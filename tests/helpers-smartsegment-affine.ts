/** 七步原生回执的隔离夹具；几何变换仅用于模拟上游测试产物，不属于生产实现。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { modelIO } from '../cli/local/gltf.ts';
import { prepareSmartSegmentAffine } from '../cli/artifacts/smartsegment-affine-proof.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { legacyAffinePlan } from '../cli/compat/smartsegment-affine-transfer-plan.ts';
import { freezeAffineIntent } from '../cli/compat/smartsegment-affine-source.ts';
import { affineChildRequest } from '../cli/core/smartsegment-affine-policy.ts';
import { object, text, TripoError } from '../studio/contracts/errors.ts';
import type { Artifact, Job, RemoteStatus } from '../studio/contracts/types.ts';
import type { SubmissionOptions } from '../studio/api/segment-route.ts';
import { assertNativeMergeSource } from '../studio/api/segment-route.ts';
import { scaleFixture, scaleModel } from './helpers-smartsegment-scale.ts';

export const affineMatrix = [1, 0, 0, 0, 0.2, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const affineRequest = 'native-affine';
const metadata = (): Record<string, unknown> => ({
  children_deleted: [],
  children_rename: {},
  children_transform_matrix: {},
  material_factor: { metallic: 0, roughness: 0.5 },
});
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
export async function affineFixture(
  options: {
    file?: boolean;
    wrongFinal?: boolean;
    failedIndex?: number;
    unknownIndex?: number;
    mergeNameCollision?: boolean;
    rootTransform?: number[];
    matrix?: number[];
  } = {},
) {
  const f = await scaleFixture({ reference: !options.file }),
    selectedMatrix = options.matrix ?? affineMatrix,
    prepared = await prepareSmartSegmentAffine(f.sourceBytes, selectedMatrix),
    first = await scaleModel(prepared.first_matrix),
    io = await modelIO(),
    merged = await io.readBinary(first);
  merged.getRoot().listNodes()[0]!.setName('ai_modeling_affine_stage1');
  const native = [
      f.sourceBytes,
      first,
      Buffer.from(await io.writeBinary(merged)),
      await scaleModel(options.wrongFinal ? prepared.first_matrix : selectedMatrix),
    ],
    artifacts: Artifact[] = [];
  for (const [index, bytes] of native.entries()) {
    const filename = path.join(f.dir, `affine-native-${index}.glb`);
    await writeFile(filename, bytes);
    artifacts.push({
      artifact_id: 'model',
      kind: 'model',
      format: 'glb',
      index: 0,
      local_path: filename,
      sha256: sha(bytes),
      bytes: bytes.length,
    });
  }
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff0000ff' } })
      .png()
      .toBuffer(),
    pngPath = path.join(f.dir, 'affine-mask.png');
  await writeFile(pngPath, png);
  const mask: Artifact = {
    artifact_id: 'semantic-mask',
    kind: 'image',
    format: 'png',
    index: 1,
    local_path: pngPath,
    sha256: sha(png),
    bytes: png.length,
  };
  const heads = new Map([['original-project', 'original-one']]);
  const nativeMetadata = (): Record<string, unknown> => ({
    ...metadata(),
    ...(options.rootTransform === undefined ? {} : { transform_matrix: options.rootTransform }),
  });
  if (options.rootTransform !== undefined)
    f.states.set('original-one', {
      ...f.states.get('original-one'),
      transform_matrix: options.rootTransform,
    });
  f.client.request = async (method: string, url: string) => {
    assert.equal(method, 'GET');
    f.reads.push(url);
    const parsed = new URL(url, 'https://example.invalid'),
      project = parsed.pathname.split('/').at(-1)!,
      operator = parsed.searchParams.get('operator_id') ?? heads.get(project)!;
    return {
      id: project,
      is_owner: true,
      model_url: 'https://example.invalid/source.glb',
      operator: {
        operator_id: operator,
        status: 'success',
        is_rigged: false,
        metadata: f.states.get(operator) ?? nativeMetadata(),
      },
    };
  };
  const indexOf = (job: Job): number =>
    Array.from({ length: 7 }, (_, index) => affineChildRequest(affineRequest, index)).indexOf(job.request_id);
  const before = { submit: undefined as ((job: Job, index: number) => void | Promise<void>) | undefined };
  f.gateway.submit = async (job: Job, beforeSend?: () => void, route?: SubmissionOptions) => {
    const index = indexOf(job);
    assert(index >= 0);
    await before.submit?.(job, index);
    if (index === 3)
      assertNativeMergeSource(
        job,
        {
          id: 'private-first',
          operator: {
            operator_id: heads.get('private-first'),
            status: 'success',
            metadata: f.states.get(heads.get('private-first')!),
          },
        },
        route,
      );
    beforeSend?.();
    if (options.unknownIndex === index) {
      f.gateway.posts++;
      throw new TripoError('UNKNOWN_FIXTURE', 'Simulated lost native receipt.', 'unknown');
    }
    f.gateway.posts++;
    f.submissions.push(job);
    const project = index < 4 ? 'private-first' : 'private-second',
      operator = `affine-op-${index}`;
    if ([1, 2, 3, 5, 6].includes(index)) assert.equal(job.input.expected_operator_id, heads.get(project));
    if (job.operation === 'copy' && index === 4) {
      assert.equal(job.input.project_id, 'private-first');
      assert.equal(job.input.operator_id, 'affine-op-3');
    }
    if (job.operation === 'project_edit') {
      const previous = f.states.get(heads.get(project)!)!;
      assert.deepEqual(
        job.input.expected_metadata,
        Object.fromEntries(Object.keys(metadata()).map((key) => [key, previous[key]])),
      );
      f.states.set(operator, {
        ...nativeMetadata(),
        ...Object.fromEntries(
          ['children_deleted', 'children_rename', 'children_transform_matrix', 'material_factor'].map((k) => [
            k,
            job.input[k],
          ]),
        ),
      });
    } else {
      const state = nativeMetadata();
      if (index === 2 && options.mergeNameCollision)
        state.children_rename = { ai_modeling_affine_stage1: 'reserved' };
      f.states.set(operator, state);
    }
    if (job.operation === 'segment' && (!options.file || index === 6))
      assert.equal(route?.segmentRoute?.strategy, 'ordinary');
    heads.set(project, operator);
    return { remote_ids: { project_id: project, operator_id: operator } };
  };
  f.gateway.status = async (job: Job): Promise<RemoteStatus> => {
    const index = indexOf(job);
    if (index === options.failedIndex)
      return {
        state: 'failed',
        progress: 0,
        artifacts: [],
        error: { code: 'BACKEND', message: 'Simulated native failure.' },
      };
    return {
      state: 'succeeded',
      progress: 100,
      artifacts: [
        artifacts[index <= 1 ? 0 : index === 2 ? 1 : index <= 5 ? 2 : 3]!,
        ...([2, 6].includes(index) ? [mask] : []),
      ],
    };
  };
  // 夹具模拟升级前已冻结的七步父意图；新CLI输入仍由持久namespace还原旧布局。
  freezeAffineIntent(
    f.app,
    legacyAffinePlan(
      processingPlan('smartsegment', f.source, {
        param: { transform: selectedMatrix, granularity: 'coarse', hint: 'head' },
      }),
    ),
    affineRequest,
  );
  return {
    ...f,
    prepared,
    nativeBytes: native,
    artifacts,
    mask,
    before,
    heads,
    flags: { requestId: affineRequest, maxCredits: 100, download: false, open: false },
    plan: (matrix = selectedMatrix, hint = 'head') =>
      processingPlan('smartsegment', f.source, { param: { transform: matrix, granularity: 'coarse', hint } }),
    final: () => f.jobs.find('test-account', affineChildRequest(affineRequest, 6))!,
    chain: () =>
      Array.from({ length: 7 }, (_, index) =>
        f.jobs.find('test-account', affineChildRequest(affineRequest, index)),
      ).filter((job): job is Job => Boolean(job)),
    sourcePolicy: () =>
      object(f.jobs.requestPolicy('test-account', `smartsegment-affine-source:${affineRequest}`)),
    stagePolicy: (name: string) =>
      object(f.jobs.requestPolicy('test-account', `smartsegment-affine-stage:${affineRequest}:${name}`)),
    cachePath: (policy: Record<string, unknown>) =>
      path.join(
        text(policy.cache_data_dir),
        'verified-output-cache',
        sha(Buffer.from('test-account')),
        `${text(policy.sha256)}.glb`,
      ),
  };
}
