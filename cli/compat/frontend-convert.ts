/** 仅显式、已证的组合复用网页前端；原生默认与既有请求布局不能静默改换。 */
import { z } from 'zod';
import type { Plan, PlannedStep } from './planning.ts';
import type { Application } from './runtime.ts';
import type { Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import { normalize } from '../../studio/contracts/schemas.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { submitFrontendExport } from '../core/frontend-export.ts';
import { frontendOutputSummary } from '../core/frontend-output.ts';
import { validateFrontendConvert } from './frontend-convert-validation.ts';
import { frontendStaticConvertSchema, frontendStaticConvertWarning } from './frontend-static-convert.ts';
import { validateFrontendStaticConvert } from './frontend-static-convert-validation.ts';
import { frontendOrientationMapping, isFrontendOrientationMapping } from './frontend-orientation.ts';

const supported = z
  .object({
    format: z.literal('GLTF'),
    export_orientation: z.enum(['+x', '-x', '+y', '-y']),
    pivot_to_center_bottom: z.boolean(),
    with_animation: z.literal(true),
    animate_in_place: z.literal(false).default(false),
    bake: z.literal(false),
    texture_format: z.literal('JPEG'),
    texture_size: z.literal(2048),
    pack_uv: z.literal(false).default(false),
    export_vertex_colors: z.literal(false).default(false),
    scale_factor: z.literal(1).default(1),
  })
  .strict();
const supportedConvert = z.discriminatedUnion('with_animation', [supported, frontendStaticConvertSchema]);
export type FrontendConvertIntent = z.infer<typeof supportedConvert>;
export const frontendConvertIntentKey = (request: string): string => `frontend-convert-intent:${request}`;
const proofKey = (request: string): string => `frontend-convert-proof:${request}`;
export const frontendConvertWarning =
  'Explicit animated GLTF bake=false with a supported axis, explicit bottom-center pivot switch and JPEG 2048 uses the pinned Studio frontend engine plus a persistent export-lite authorization. Self-contained sources with embedded skeletons/clips and existing JPEG 2048 textures pass per-file preservation and actual skinned rest checks; saved PBR metallic/roughness follows the webpage is_pbr branch. Other encodings, retarget files, geometry edits, import/remesh chains and default convert requests are not substituted. The delivered transform does not create a new Studio model operator; continue web editing from the original project/operator.';

export function frontendConvertPlan(
  source: string,
  input: Record<string, unknown>,
  file: boolean,
): Plan | undefined {
  if (input.bake !== false || (input.with_animation !== true && input.with_animation !== false)) return;
  const format = ['glb', 'gltf'].includes(text(input.format).toLowerCase()) ? 'GLTF' : input.format;
  const parsed = supportedConvert.safeParse({ ...input, format });
  // 静态仅匹配完整的显式组合；缺省与别的已支持组合仍走原生规划和校验。
  if (!parsed.success && input.with_animation === false) return;
  if (!parsed.success || file || source === 'upstream')
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Frontend bake=false requires an existing exact Studio source and explicit GLTF, a supported export_orientation, a boolean pivot_to_center_bottom, texture encoding and size. Animated input requires JPEG 2048; import/remesh chains and additional processing options have no verified combined mapping.',
      'not_submitted',
    );
  const warning = parsed.data.with_animation ? frontendConvertWarning : frontendStaticConvertWarning;
  return {
    steps: [
      {
        name: 'convert',
        operation: 'export_lite',
        parameters: normalize('export_lite', {
          project_id: 'upstream',
          operator_id: 'upstream',
          format: 'glb',
          public_model: false,
        }),
        source,
        frontendConvert: parsed.data,
        warnings: [warning],
      },
    ],
    pending_uploads: [],
    warnings: [warning],
  };
}

/** 即便改走原生路径，也不能借相同step ID绕开已经冻结的前端转换意图。 */
export function assertFrontendConvertPlan(
  jobs: JobStore,
  account: string,
  request: string,
  step: PlannedStep,
): void {
  const saved = jobs.requestPolicy(account, frontendConvertIntentKey(request));
  if (
    saved &&
    ((saved.version !== 1 && saved.version !== 2) ||
      (step.frontendConvertRevision !== undefined && saved.version !== step.frontendConvertRevision) ||
      (saved.version === 2 &&
        !isFrontendOrientationMapping(
          saved.orientation_mapping,
          object(saved.parameters).export_orientation,
        )) ||
      !step.frontendConvert ||
      step.operation !== 'export_lite' ||
      saved.source !== step.source ||
      fingerprint(saved.parameters) !== fingerprint(step.frontendConvert))
  )
    throw new TripoError('IDEMPOTENCY_CONFLICT', 'The original frontend convert intent changed.');
  const existing = jobs.find(account, request);
  if (step.frontendConvert && existing && (!saved || existing.operation !== 'export_lite'))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'This request already belongs to another export path; recover its original task.',
    );
}

export async function executeFrontendConvert(
  app: Application,
  step: PlannedStep,
  params: Record<string, unknown>,
  request: string,
  maximum: number,
): Promise<Record<string, unknown>> {
  const account = app.service.accountRef();
  assertFrontendConvertPlan(app.service.jobs, account, request, step);
  const saved = app.service.jobs.requestPolicy(account, frontendConvertIntentKey(request)),
    version = saved?.version ?? step.frontendConvertRevision ?? 2,
    parameters = supportedConvert.parse(step.frontendConvert),
    mapping = version === 2 ? frontendOrientationMapping(parameters.export_orientation) : undefined;
  const intent = {
    version,
    source: step.source,
    parameters,
    project_id: params.project_id,
    operator_id: params.operator_id,
    ...(mapping ? { orientation_mapping: mapping } : {}),
  };
  app.service.jobs.bindRequestPolicy(account, frontendConvertIntentKey(request), intent);
  const result = await submitFrontendExport(
    app.service,
    app.studio.client,
    {
      project_id: params.project_id,
      operator_id: params.operator_id,
      request_id: request,
      format: 'glb',
      forward_axis: mapping?.forward_axis ?? intent.parameters.export_orientation,
      pivot_to_center_bottom: intent.parameters.pivot_to_center_bottom,
      ...(intent.parameters.with_animation ? {} : { exclude_retarget: true }),
      max_credits: maximum,
    },
    {
      authorizationRequestId: request,
      validatePrepared: async ({ proof, bytes }) => {
        const validation = intent.parameters.with_animation
          ? await validateFrontendConvert(proof, bytes, mapping)
          : await validateFrontendStaticConvert(proof, bytes, intent.parameters, mapping);
        if (account !== app.service.accountRef())
          throw new TripoError('ACCOUNT_MISMATCH', 'The account changed during frontend validation.');
        app.service.jobs.bindRequestPolicy(account, proofKey(request), {
          version,
          intent: fingerprint(intent),
          source_sha256: proof.source_sha256,
          output_sha256: proof.output_sha256,
          output_bytes: proof.output_bytes,
          validation,
        });
      },
    },
  );
  return object(result.export_lite_job);
}

export function rejectFrontendConvertContinuation(jobs: JobStore, job?: Job): void {
  if (!job) return;
  const intent = jobs.requestPolicy(job.account_ref, frontendConvertIntentKey(job.request_id));
  if (intent)
    throw new TripoError(
      'FRONTEND_CONVERT_CONTINUATION_UNVERIFIED',
      `This converted delivery applies its axis/pivot locally and creates no new Studio model operator. Continue web editing from original project ${text(intent.project_id)} / operator ${text(intent.operator_id)}.`,
      'not_submitted',
    );
}

/** 重做保留原始精确来源和完整转换意图；不能复制仅含授权字段的export_lite任务。 */
export function redoFrontendConvertPlan(
  jobs: JobStore,
  dataDir: string,
  job: Job,
  seed?: unknown,
  overrides: Record<string, unknown> = {},
): Plan | undefined {
  const intent = jobs.requestPolicy(job.account_ref, frontendConvertIntentKey(job.request_id));
  if (!intent) return;
  const current = frontendOutputSummary(jobs, dataDir, job);
  if (current?.state !== 'succeeded' || current.task_type !== 'convert_model')
    throw new TripoError(
      'INPUT_NOT_READY',
      'Recover the original verified frontend convert before creating another authorization.',
      'not_submitted',
    );
  if (seed !== undefined)
    throw new TripoError('STUDIO_CAPABILITY_UNAVAILABLE', 'Frontend convert has no seed parameter.');
  const original = supportedConvert.parse(intent.parameters);
  if (overrides.with_animation !== undefined && overrides.with_animation !== original.with_animation)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'A frontend redo must retain its original static or animated conversion mode.',
      'not_submitted',
    );
  const plan = frontendConvertPlan(text(intent.project_id), { ...original, ...overrides }, false);
  if (!plan)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'A frontend redo must retain its explicit bake=false conversion intent.',
      'not_submitted',
    );
  // 来源不再保留可能改指向的@alias；精确旧operator仍须在新授权前重新确认。
  plan.steps[0]!.parameters.operator_id = intent.operator_id;
  // 重做是新的授权，但仍重现原方向；不能把历史±X交付套用后来发现的新枚举映射。
  plan.steps[0]!.frontendConvertRevision = intent.version as 1 | 2;
  return plan;
}
