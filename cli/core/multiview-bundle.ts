/** 四视图组合是本地回执，子任务仍由网页逐图编辑；没有伪造一个远端 multiview 请求。 */
import { z } from 'zod';
import { text, TripoError } from '../../studio/contracts/errors.ts';
import type { Job, Artifact } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';

export const multiviewNames = ['front', 'left', 'back', 'right'] as const;
export const multiviewPrompts = z
  .array(
    z
      .object({
        view: z.enum(multiviewNames),
        prompt: z.string().min(1).max(1024),
      })
      .strict(),
  )
  .min(1)
  .max(4)
  .refine(
    (items) => new Set(items.map((item) => item.view)).size === items.length,
    'Each view may have only one edit instruction.',
  );
const source = z
  .object({ asset_id: z.string().min(1), output_index: z.number().int().min(0).max(99) })
  .strict();
const definition = z
  .object({
    version: z.literal(1),
    intent: z.object({ source: z.string(), prompts: multiviewPrompts, model: z.string() }).strict(),
    source_reference: z.string().min(1),
    sources: z.array(source).length(4),
    children: z
      .array(z.object({ view: z.enum(multiviewNames), request_id: z.string().min(1) }).strict())
      .min(1)
      .max(4),
  })
  .strict();
export type MultiviewBundle = z.infer<typeof definition>;
export type MultiviewSource = z.infer<typeof source>;

export function isMultiviewBundle(job: Pick<Job, 'operation' | 'input'>): boolean {
  return job.operation === 'image_process' && job.input._multiview_edit !== undefined;
}
export function multiviewBundle(job: Job): MultiviewBundle {
  if (!isMultiviewBundle(job)) throw new TripoError('INVALID_INPUT', 'Expected an edited multiview task.');
  const parsed = definition.safeParse(job.input._multiview_edit);
  if (!parsed.success)
    throw new TripoError('CONTRACT_CHANGED', 'The saved multiview composition is incomplete.');
  return parsed.data;
}

export function multiviewChildren(jobs: JobStore, root: Job): (Job | undefined)[] {
  return multiviewBundle(root).children.map(({ request_id }) => {
    const child = jobs.find(root.account_ref, request_id);
    if (child && child.operation !== 'image')
      throw new TripoError('IDEMPOTENCY_CONFLICT', 'A multiview child request belongs to another operation.');
    return child;
  });
}

/** 未改槽来自被冻结的源视图；成功修改槽只取对应孩子的第一个明确输出。 */
export function multiviewSources(jobs: JobStore, root: Job): MultiviewSource[] {
  const saved = multiviewBundle(root),
    children = multiviewChildren(jobs, root);
  if (children.some((child) => !child || child.state !== 'succeeded' || !text(child.remote_ids.asset_id)))
    throw new TripoError(
      'INPUT_NOT_READY',
      'Every edited view must succeed before using this multiview composition.',
      'not_submitted',
    );
  const sources = saved.sources.map((item) => ({ ...item }));
  for (const [index, child] of children.entries())
    sources[multiviewNames.indexOf(saved.children[index]!.view)] = {
      asset_id: text(child!.remote_ids.asset_id),
      output_index: 0,
    };
  // 完成后的槽位身份必须固定；后续读取/下载不能把旧缓存关联到变更的孩子回执。
  jobs.bindRequestPolicy(root.account_ref, `multiview-output:${root.job_id}`, { sources });
  return sources;
}

export function multiviewSummary(jobs: JobStore, root: Job): Record<string, unknown> {
  const saved = multiviewBundle(root),
    children = multiviewChildren(jobs, root);
  const states: string[] = children.map((child) => child?.state ?? 'missing');
  const state =
    ['outcome_unknown', 'requires_login', 'failed', 'waiting_input'].find((value) =>
      states.includes(value),
    ) ??
    (states.some((value) => ['prepared', 'missing', 'submitting'].includes(value))
      ? 'needs_attention'
      : states.every((value) => value === 'succeeded')
        ? 'succeeded'
        : 'running');
  const complete = state === 'succeeded';
  const known = children.every((child) => child?.observed_cost?.status === 'fulfilled');
  return {
    state,
    progress: Math.round((states.filter((value) => value === 'succeeded').length / states.length) * 100),
    composition: {
      kind: 'native_image_edits',
      atomic: false,
      views: complete ? multiviewSources(jobs, root) : saved.sources,
      views_complete: complete,
      children: saved.children.map((item, index) => ({
        ...item,
        job_id: children[index]?.job_id,
        state: states[index],
        error: children[index]?.error,
      })),
    },
    ...(known
      ? {
          observed_cost: {
            status: 'fulfilled',
            credits: children.reduce((sum, child) => sum + child!.observed_cost!.credits, 0),
            source: 'studio_child_transactions',
            observed_at: new Date().toISOString(),
          },
        }
      : {}),
    ...(state === 'needs_attention'
      ? {
          next_action:
            'Resume the original edit-multiview command with the same request_id to submit missing/prepared views.',
        }
      : {}),
    ...(state === 'outcome_unknown'
      ? {
          next_action:
            'Reconcile the specific child task with the original Studio receipt; never resubmit an unknown view.',
        }
      : {}),
    ...(state === 'failed'
      ? {
          error: {
            code: 'MULTIVIEW_CHILD_FAILED',
            message:
              'At least one view edit failed. Completed child tasks are preserved; the same request will not regenerate them.',
          },
        }
      : {}),
  };
}

export async function refreshMultiviewBundle(
  jobs: JobStore,
  root: Job,
  refresh: (id: string) => Promise<unknown>,
): Promise<{ job: Job; summary: Record<string, unknown> }> {
  jobs.linkStep(root.account_ref, `multiview:${root.job_id}`, 0, root.job_id);
  for (const [index, child] of multiviewChildren(jobs, root).entries())
    if (child) {
      jobs.linkStep(root.account_ref, `multiview:${root.job_id}`, index + 1, child.job_id);
      await refresh(child.job_id);
    }
  const summary = multiviewSummary(jobs, root);
  if (summary.state === 'succeeded') {
    const sources = multiviewSources(jobs, root),
      saved = multiviewBundle(root),
      children = multiviewChildren(jobs, root);
    const artifacts: Artifact[] = sources.map((_item, index) => {
      const edited = saved.children.findIndex((item) => item.view === multiviewNames[index]);
      const format =
        edited >= 0
          ? children[edited]!.artifacts.find((item) => item.kind === 'image' && item.index === 0)?.format
          : undefined;
      return { artifact_id: `image-${index}`, kind: 'image', format: format ?? 'image', index };
    });
    root = jobs.update(root.job_id, 'succeeded', { progress: 100, artifacts });
  }
  return { job: root, summary };
}

/** 下载仍走网页真实资产读取与受控下载器，组合只替换读取时的资产身份/槽位。 */
export function multiviewArtifactSource(
  jobs: JobStore,
  root: Job,
  artifact: Artifact,
): { job: Job; artifact: Artifact } {
  const selected = multiviewSources(jobs, root)[artifact.index];
  if (!selected) throw new TripoError('ARTIFACT_NOT_FOUND', 'No such multiview output slot.');
  return {
    job: { ...root, input: { action: 'multiview' }, remote_ids: { asset_id: selected.asset_id } },
    artifact: { ...artifact, index: selected.output_index },
  };
}
