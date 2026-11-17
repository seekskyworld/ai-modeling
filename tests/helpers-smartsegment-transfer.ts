/** 隔离模拟网页原生返回；仅测试夹具写变换顶点，生产实现只传原始字节和矩阵。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mat3, vec3 } from 'gl-matrix';
import sharp from 'sharp';
import { modelIO } from '../cli/local/gltf.ts';
import { prepareNativeAffineTransfer } from '../cli/artifacts/smartsegment-affine-transfer-proof.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { smartSegmentIdentity } from '../cli/compat/smartsegment-scale-plan.ts';
import { transferChildRequest, transferSourceKey } from '../cli/core/smartsegment-affine-transfer-policy.ts';
import { object, text, TripoError } from '../studio/contracts/errors.ts';
import type { Artifact, Job, RemoteStatus } from '../studio/contracts/types.ts';
import type { SubmissionOptions } from '../studio/api/segment-route.ts';
import { assertNativeSegmentRoute, assertNativeMetadataSource } from '../studio/api/segment-route.ts';
import { metadataBody } from '../studio/api/metadata.ts';
import { scaleFixture, scaleModel } from './helpers-smartsegment-scale.ts';

export const transferMatrix = [1, 0, 0, 0, 0.2, 1, 0, 0, 0.1, 0, 1, 0, 0, 0, 0, 1];
export const transferRequest = 'native-affine-transfer';
export const transferMetadata = (): Record<string, unknown> => ({
  transform_matrix: [],
  children_deleted: [],
  children_rename: {},
  children_transform_matrix: {},
  material_factor: { metallic: 0, roughness: 0.5 },
});
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export async function transferModel(matrix: number[], name?: string, sceneName?: string): Promise<Buffer> {
  const io = await modelIO(),
    doc = await io.readBinary(await scaleModel()),
    primitive = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!,
    positions = primitive.getAttribute('POSITION')!,
    normals = primitive.getAttribute('NORMAL')!,
    normalMatrix = new Float64Array(9);
  mat3.normalFromMat4(normalMatrix, matrix);
  if (name) doc.getRoot().listNodes()[0]!.setName(name);
  if (sceneName) doc.getRoot().listScenes()[0]!.setName(sceneName);
  for (let index = 0; index < positions.getCount(); index++) {
    const position = positions.getElement(index, []),
      output = new Float64Array(3);
    vec3.transformMat4(output, position, matrix);
    positions.setElement(index, Array.from(output));
    vec3.transformMat3(output, normals.getElement(index, []), normalMatrix);
    vec3.normalize(output, output);
    normals.setElement(index, Array.from(output));
  }
  return Buffer.from(await io.writeBinary(doc));
}

export async function transferFixture(
  options: {
    file?: boolean;
    matrix?: number[];
    wrongImport?: boolean;
    wrongFinal?: boolean;
    unknownIndex?: number;
    failedIndex?: number;
    sourceMetadata?: Record<string, unknown>;
    importedNodeName?: string;
    sourceNodeName?: string;
    sourceSceneName?: string;
  } = {},
) {
  const matrix = options.matrix ?? transferMatrix,
    f = await scaleFixture({
      reference: !options.file,
      ...(options.sourceNodeName || options.sourceSceneName
        ? {
            sourceBytes: await transferModel(
              smartSegmentIdentity,
              options.sourceNodeName,
              options.sourceSceneName,
            ),
          }
        : {}),
    }),
    preparation = await prepareNativeAffineTransfer(f.sourceBytes, matrix),
    imported = options.wrongImport
      ? f.sourceBytes
      : await transferModel(preparation.first_matrix, options.importedNodeName ?? options.sourceNodeName),
    finalBytes = await transferModel(options.wrongFinal ? preparation.first_matrix : matrix),
    native = [imported, finalBytes],
    artifacts: Artifact[] = [];
  for (const [index, bytes] of native.entries()) {
    const local_path = path.join(f.dir, `transfer-native-${index}.glb`);
    await writeFile(local_path, bytes);
    artifacts.push({
      artifact_id: 'model',
      kind: 'model',
      format: 'glb',
      index: 0,
      local_path,
      sha256: sha(bytes),
      bytes: bytes.length,
    });
  }
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#12ff00ff' } })
      .png()
      .toBuffer(),
    pngPath = path.join(f.dir, 'transfer-native-preview.png');
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
  f.states.set('original-one', { ...transferMetadata(), ...options.sourceMetadata });
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
        metadata: f.states.get(operator) ?? transferMetadata(),
      },
    };
  };
  const indexOf = (job: Job): number =>
    [0, 1, 2].findIndex((index) => job.request_id === transferChildRequest(transferRequest, index));
  const before = {
    submit: undefined as
      ((job: Job, index: number, route?: SubmissionOptions) => void | Promise<void>) | undefined,
  };
  f.gateway.submit = async (job: Job, beforeSend?: () => void, route?: SubmissionOptions) => {
    const index = indexOf(job);
    assert(index >= 0);
    await before.submit?.(job, index, route);
    beforeSend?.();
    const project = 'transfer-private',
      operator = `transfer-op-${index}`;
    if (index === 0) {
      assert.equal(sha(await readFile(text(job.input.model_path))), sha(f.sourceBytes));
      assert.deepEqual(job.input.transform_matrix, preparation.import_matrix);
      assert.equal(job.input.use_original_uv, true);
    } else {
      assert.equal(job.input.project_id, project);
      assert.equal(job.input.expected_operator_id, heads.get(project));
      if (index === 1)
        assertNativeMetadataSource(
          job,
          {
            id: project,
            model_url: 'https://example.invalid/source.glb',
            operator: {
              operator_id: heads.get(project),
              status: 'success',
              metadata: f.states.get(heads.get(project)!),
            },
          },
          route,
        );
      if (index === 2) {
        assert.equal(route?.segmentRoute?.strategy, 'ordinary');
        assertNativeSegmentRoute(route!.segmentRoute!, job.input, {
          id: project,
          model_url: 'https://example.invalid/source.glb',
          operator: {
            operator_id: heads.get(project),
            status: 'success',
            metadata: f.states.get(heads.get(project)!),
          },
        });
      }
    }
    if (options.unknownIndex === index) {
      f.gateway.posts++;
      throw new TripoError('LOST_NATIVE_RECEIPT', 'Simulated unknown native outcome.', 'unknown');
    }
    f.gateway.posts++;
    f.submissions.push(job);
    if (index === 1) {
      const previous = f.states.get(heads.get(project)!)!;
      assert.deepEqual(
        job.input.expected_metadata,
        Object.fromEntries(
          ['children_deleted', 'children_rename', 'children_transform_matrix', 'material_factor'].map(
            (key) => [key, previous[key]],
          ),
        ),
      );
      const body = await metadataBody(f.client as unknown as Parameters<typeof metadataBody>[0], job.input);
      f.states.set(operator, {
        ...previous,
        ...Object.fromEntries(
          ['children_deleted', 'children_rename', 'children_transform_matrix', 'material_factor'].map(
            (key) => [key, body[key]],
          ),
        ),
      });
    } else f.states.set(operator, transferMetadata());
    heads.set(project, operator);
    return { remote_ids: { project_id: project, operator_id: operator } };
  };
  f.gateway.status = async (job: Job): Promise<RemoteStatus> => {
    const index = indexOf(job);
    return index === options.failedIndex
      ? {
          state: 'failed',
          progress: 0,
          artifacts: [],
          error: { code: 'FAILED_FIXTURE', message: 'Native fixture failed.' },
        }
      : {
          state: 'succeeded',
          progress: 100,
          artifacts: index === 2 ? [artifacts[1]!, mask] : [artifacts[0]!],
        };
  };
  return {
    ...f,
    matrix,
    preparation,
    nativeBytes: native,
    artifacts,
    mask,
    before,
    heads,
    flags: { requestId: transferRequest, maxCredits: 100, download: false, open: false },
    plan: (selected = matrix, hint = 'head') =>
      processingPlan('smartsegment', f.source, {
        param: { transform: selected, granularity: 'coarse', hint },
      }),
    final: () => f.jobs.find('test-account', transferChildRequest(transferRequest, 2))!,
    chain: () =>
      [0, 1, 2]
        .map((index) => f.jobs.find('test-account', transferChildRequest(transferRequest, index)))
        .filter((job): job is Job => Boolean(job)),
    sourcePolicy: () => object(f.jobs.requestPolicy('test-account', transferSourceKey(transferRequest))),
  };
}
