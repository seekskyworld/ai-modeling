/** 上传、登记输入素材和挂载节点分开；调用方选择是否等待 READY，不重复提交已有登记。 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { StudioClient } from './client.ts';
import { CanvasClient, bindCanvasAccount } from './canvas-client.ts';
import { readCanvasInput } from './canvas-input.ts';
import { modelUpload } from '../model-upload.ts';
import { inspectModelFaceCount } from '../model-face-count.ts';
import { uploadFile } from './upload.ts';
import { array, object, sanitize, text, TripoError } from '../contracts/errors.ts';

/** 网页 Upload Card 保留原 UV；旋转属于调用方选择，未旋转的外层矩阵是单位矩阵。 */
export const canvasUploadOptionsSchema = z
  .object({
    transformation: z
      .array(z.number().finite())
      .length(16)
      .optional()
      .describe(
        'Model import transform as 16 column-major numbers; omitted means the unrotated identity matrix.',
      ),
    use_original_uv: z
      .boolean()
      .optional()
      .describe('Preserve model UVs as the Canvas Upload Card does (default true). Model inputs only.'),
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(120)
      .default(0)
      .describe(
        'Wait up to this many seconds for the registered input asset; 0 returns its actual initial status.',
      ),
  })
  .strict();
export type CanvasUploadOptions = z.input<typeof canvasUploadOptionsSchema>;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const assetMethod = (name: string) => `/tripo.canvas.api.agent.AssetService/${name}`;
const statuses = new Set([
  'INPUT_ASSET_STATUS_READY',
  'INPUT_ASSET_STATUS_PROCESSING',
  'INPUT_ASSET_STATUS_FAILED',
  'INPUT_ASSET_STATUS_UNSPECIFIED',
]);

/** Import 的受理回执不等于 READY；保持 assetId，轮询失败时可用 input-assets 继续查询。 */
function inputAsset(response: unknown, kind: string, assetId?: string): Record<string, unknown> {
  const matches = array(object(response).assets)
    .map(object)
    .filter((asset) => !assetId || asset.assetId === assetId);
  if (
    matches.length !== 1 ||
    !text(matches[0]?.assetId).trim() ||
    matches[0]?.kind !== kind ||
    !statuses.has(text(matches[0]?.status))
  )
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Canvas input receipt has no unique asset with the expected kind and status; do not repeat its import.',
      assetId ? 'read' : 'unknown',
      {
        ...(assetId ? { asset_id: assetId } : {}),
        observed_asset_ids: matches.map((asset) => text(asset.assetId)).filter(Boolean),
      },
    );
  return matches[0]!;
}

function inputState(asset: Record<string, unknown>): string {
  if (asset.status === 'INPUT_ASSET_STATUS_READY') return 'ready';
  if (asset.status === 'INPUT_ASSET_STATUS_FAILED') return 'failed';
  if (asset.status === 'INPUT_ASSET_STATUS_PROCESSING') return 'processing';
  return 'unknown';
}

async function waitForInput(
  studio: StudioClient,
  projectId: string,
  kind: string,
  asset: Record<string, unknown>,
  waitSeconds: number,
): Promise<Record<string, unknown>> {
  const assetId = text(asset.assetId);
  const deadline = performance.now() + waitSeconds * 1000;
  let pollError: Record<string, unknown> | undefined;
  let polls = 0;
  let waitTimedOut = false;
  while (
    waitSeconds > 0 &&
    ['INPUT_ASSET_STATUS_PROCESSING', 'INPUT_ASSET_STATUS_UNSPECIFIED'].includes(text(asset.status)) &&
    performance.now() < deadline
  ) {
    if (polls) await delay(Math.min(1500, Math.max(0, deadline - performance.now())));
    if (performance.now() >= deadline) break;
    // 定时器可能在单调时钟的亚毫秒边界触发；已中止的等待预算本身就是超时依据。
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
    try {
      // 等待预算也覆盖慢请求及会话刷新，不能在最后一次读取额外阻塞 65 秒。
      const pollingClient = new CanvasClient(
        new StudioClient(
          studio.credentials,
          (url, init) =>
            studio.fetcher(url, {
              ...init,
              signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal,
            }),
          studio.origin,
        ),
      );
      const response = await pollingClient.call(assetMethod('BatchGetInputAssets'), {
        projectId,
        assetIds: [assetId],
      });
      asset = inputAsset(response, kind, assetId);
      polls++;
    } catch (error) {
      if (signal.aborted || performance.now() >= deadline) {
        waitTimedOut = true;
        break;
      }
      const detail = error instanceof TripoError ? error : undefined;
      pollError = {
        code: detail?.code ?? 'INPUT_STATUS_UNAVAILABLE',
        message:
          detail?.message ??
          'Input status could not be refreshed. Query the accepted asset ID; do not upload it again.',
      };
      break;
    }
  }
  const ready = asset.status === 'INPUT_ASSET_STATUS_READY';
  const failed = asset.status === 'INPUT_ASSET_STATUS_FAILED';
  return {
    assets: [asset],
    ready,
    state: inputState(asset),
    wait_timed_out:
      waitSeconds > 0 && !ready && !failed && !pollError && (waitTimedOut || performance.now() >= deadline),
    ...(pollError ? { poll_error: pollError } : {}),
  };
}

export async function uploadCanvasFile(
  studio: StudioClient,
  projectId: string,
  filePath: string,
  roots: string[],
  options: CanvasUploadOptions = {},
): Promise<unknown> {
  const settings = canvasUploadOptionsSchema.parse(options);
  studio = bindCanvasAccount(studio);
  if (!projectId.trim()) throw new TripoError('INVALID_INPUT', 'Canvas project ID is required.');
  const file = await readCanvasInput(filePath, roots);
  const isModel = file.kind === 'ASSET_KIND_MODEL';
  if (!isModel && (settings.transformation !== undefined || settings.use_original_uv !== undefined))
    throw new TripoError(
      'INVALID_INPUT',
      'Model transformation and UV options do not apply to images or videos.',
    );
  // glTF 必须先转换，登记 format/size/hash 要描述真实上传字节，不能沿用转换前的大小。
  const prepared = await modelUpload(file.bytes, file.format);
  const modelFaceCheck = isModel ? await inspectModelFaceCount(prepared.bytes, prepared.format) : undefined;
  const uploaded = await uploadFile(studio, prepared.bytes, prepared.format);
  if (!uploaded.key) throw new TripoError('UPLOAD_FAILED', 'Canvas upload returned no resource URI.');
  const client = new CanvasClient(studio);
  const result = object(
    await client.call(
      assetMethod('ImportInputAssets'),
      {
        projectId,
        objectRefs: [
          {
            resourceUri: uploaded.key,
            originalFilename: path.basename(filePath),
            sizeBytes: String(prepared.bytes.length),
            contentType: file.contentType,
            ...(isModel
              ? {
                  format: prepared.format,
                  transformMatrix: settings.transformation ?? [...identity],
                  useOriginalUv: settings.use_original_uv ?? true,
                }
              : {}),
          },
        ],
      },
      true,
    ),
  );
  const kind = file.kind;
  const observed = await waitForInput(
    studio,
    projectId,
    kind,
    inputAsset(result, kind),
    settings.wait_seconds,
  );
  const acceptedId = text(object(array(observed.assets)[0]).assetId);
  return sanitize({
    ...result,
    ...observed,
    project_id: projectId,
    sha256: file.sha256,
    uploaded_sha256: createHash('sha256').update(prepared.bytes).digest('hex'),
    uploaded_format: prepared.format,
    ...(modelFaceCheck ? { model_face_check: modelFaceCheck } : {}),
    // 网页将原始文件 URL 与展示矩阵分开保存；提供可组合的挂载参数，不自动写图。
    ...(kind === 'ASSET_KIND_VIDEO'
      ? { lab_asset_id: acceptedId }
      : {
          input_mount: [{ assetId: acceptedId }],
          node_params: {
            assetType: isModel ? 'model' : 'image',
            ...(isModel
              ? {
                  uploadSource: {
                    assetId: acceptedId,
                    format: prepared.format,
                    transformMatrix: settings.transformation ?? [...identity],
                  },
                }
              : {}),
          },
          remote_saved: false,
        }),
  });
}
