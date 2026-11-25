/** 按网页素材身份读取下载地址；不依赖本地任务，不用缩略图或当前选中结果替代。 */
import { array, object, text, TripoError } from '../contracts/errors.ts';
import type { ExistingArtifactSource } from '../contracts/artifact-source.ts';
import type { StudioClient } from './client.ts';
import { CanvasClient } from './canvas-client.ts';

interface Request {
  kind: string;
  id: string;
  canvas_id?: string;
  node_id?: string;
  job_id?: string;
}
const videos = new Set(['3gp', 'avi', 'flv', 'm4v', 'mkv', 'mov', 'mp4', 'rmvb', 'ts', 'webm', 'wmv']);
const structured = new Set(['glb', 'gltf', 'fbx', 'obj', 'stl', 'usdz', '3mf', 'zip', 'png', 'jpeg', 'webp']);
function extension(value: string): string {
  const found = /\.([a-z0-9]{1,12})$/i.exec(value)?.[1]?.toLowerCase() ?? '';
  return found === 'jpg' ? 'jpeg' : found;
}

/** Shared metadata classification: an actual URL path suffix takes precedence over a filename. */
export function canvasArtifactSuffix(url: string | undefined, filename: string): string {
  let urlExtension = '';
  if (url !== undefined) {
    try {
      urlExtension = extension(new URL(url).pathname);
    } catch {
      throw new TripoError('CONTRACT_CHANGED', 'Canvas returned an invalid download URL.');
    }
  }
  return urlExtension || extension(filename.trim());
}

/** 网页 EC.r 优先 URL 后缀，再取标题；未知文件只核传输字节，不能声称验证其内容。 */
export function canvasArtifactContent(url: string, filename: string, kind: string) {
  const format = canvasArtifactSuffix(url, filename);
  if (kind === 'image' || kind === 'screenshot' || kind === 'ASSET_KIND_IMAGE') return { format: 'image' };
  if (kind === 'video' || kind === 'ASSET_KIND_VIDEO') {
    if (!videos.has(format))
      throw new TripoError('ARTIFACT_FORMAT_UNCONFIRMED', 'Canvas video has no recognized container suffix.');
    return { format, content_hint: { kind: 'video' as const } };
  }
  // Lab 的通用 file 可能是 TypeScript .ts；不能仅凭该后缀将任意代码误判成传输流。
  if (videos.has(format) && format !== 'ts') return { format, content_hint: { kind: 'video' as const } };
  if (structured.has(format)) return { format };
  if (kind === 'model' || kind === 'ASSET_KIND_MODEL') return { format: 'glb' };
  return { format: format || 'bin', content_hint: { kind: 'file' as const } };
}

function unique(values: unknown[], key: string, id: string): Record<string, unknown> {
  const matches = values.map(object).filter((asset) => asset[key] === id);
  if (matches.length !== 1)
    throw new TripoError(
      matches.length ? 'CONTRACT_CHANGED' : 'ARTIFACT_NOT_FOUND',
      'The exact requested Canvas asset is not uniquely available.',
    );
  return matches[0]!;
}
function byteSize(asset: Record<string, unknown>): number | undefined {
  const value = asset.sizeBytes ?? asset.byteSize;
  if (value === undefined) return undefined;
  const size = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
    throw new TripoError('CONTRACT_CHANGED', 'Canvas returned an invalid file size.');
  return size;
}
function source(asset: Record<string, unknown>, request: Request, urlField: string): ExistingArtifactSource {
  const url = text(asset[urlField]);
  if (!url)
    throw new TripoError(
      'ARTIFACT_NOT_READY',
      'This Canvas asset has no download URL in its source context.',
    );
  const content = canvasArtifactContent(url, text(asset.filename) || text(asset.title), text(asset.kind));
  const size = byteSize(asset);
  return {
    url,
    source_id: request.id,
    ...(request.canvas_id ? { canvas_id: request.canvas_id } : {}),
    ...(request.node_id ? { node_id: request.node_id } : {}),
    ...(request.job_id ? { job_id: request.job_id } : {}),
    ...content,
    ...(size === undefined ? {} : { content_hint: { ...content.content_hint, byte_size: size } }),
  };
}

/** 输入原文件地址由 GetCanvas.inputMount 提供；跨图粘贴的挂载不必登记在当前项目的素材目录中。 */
async function mountedInput(client: CanvasClient, request: Request): Promise<ExistingArtifactSource> {
  const graph = object(
    await client.call('/tripo.canvas.api.agent.CanvasService/GetCanvas', {
      canvasId: request.canvas_id,
    }),
  );
  const canvas = object(graph.canvas);
  if (canvas.canvasId !== request.canvas_id || !text(canvas.projectId))
    throw new TripoError('CONTRACT_CHANGED', 'Canvas returned another graph or no source project.');
  const node = unique(array(graph.nodes), 'id', request.node_id!);
  const mount = unique(array(node.inputMount), 'assetId', request.id);
  const result = object(
    await client.call('/tripo.canvas.api.agent.AssetService/BatchGetInputAssets', {
      projectId: canvas.projectId,
      assetIds: [request.id],
    }),
  );
  if (!Array.isArray(result.assets) || result.assets.some((asset) => object(asset).assetId !== request.id))
    throw new TripoError('CONTRACT_CHANGED', 'Canvas input metadata returned an invalid identity list.');
  const matches = array(result.assets)
    .map(object)
    .filter((asset) => asset.assetId === request.id);
  if (matches.length > 1)
    throw new TripoError('CONTRACT_CHANGED', 'Canvas input metadata has duplicate asset identities.');
  const metadata = matches[0];
  if (metadata && metadata.status !== 'INPUT_ASSET_STATUS_READY')
    throw new TripoError('ARTIFACT_NOT_READY', 'Wait for this Canvas input asset to become ready.');
  // 网页 Gv/Kv→Jv 对 UploadCard 直接使用挂载 URL。跨图素材不在当前 project 的
  // BatchGetInputAssets 中并不等于不可下载；没有元数据时不冒称 READY 或臆造原项目身份。
  // metadata 不含原 URL；保留远端 GetCanvas 精确 node/asset 的挂载，不回退 thumbnailUrl。
  return {
    ...source({ ...mount, ...metadata, url: mount.url }, request, 'url'),
    project_id: text(canvas.projectId),
    input_metadata_scope: metadata ? 'current_project' : 'not_in_current_project',
  };
}

export async function canvasArtifactSource(
  studio: StudioClient,
  request: Request,
): Promise<ExistingArtifactSource> {
  const client = new CanvasClient(studio);
  if (request.kind === 'canvas_input') {
    const result = await mountedInput(client, request);
    studio.credentials.load();
    return result;
  }
  if (request.kind === 'canvas_node') {
    const result = object(
      await client.call('/tripo.canvas.api.agent.NodeService/ListNodesAssets', {
        nodeIds: [request.node_id],
      }),
    );
    const node = unique(array(result.nodes), 'nodeId', request.node_id!);
    const asset = unique(array(node.assets), 'assetId', request.id);
    if (asset.nodeId !== request.node_id)
      throw new TripoError('CONTRACT_CHANGED', 'Canvas returned an asset from another node.');
    studio.credentials.load();
    return source(asset, request, 'url');
  }
  const job = object(
    await client.call('/tripo.canvas.api.agent.LabService/GetLabJob', {
      jobId: request.job_id,
    }),
  );
  if (job.jobId !== request.job_id) throw new TripoError('CONTRACT_CHANGED', 'Lab returned a different job.');
  studio.credentials.load();
  if (request.kind === 'lab_input') {
    const input = unique(array(job.inputs), 'assetId', request.id);
    return { ...source(input, request, 'previewUrl'), representation: 'input_preview' };
  }
  // 网页允许下载运行中或随后失败的任务已生成文件；精确 artifact 存在才是条件。
  return source(unique(array(job.artifacts), 'artifactId', request.id), request, 'downloadUrl');
}
