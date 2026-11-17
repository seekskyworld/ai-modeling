/** 模板大图直接使用图中原 URL；模型详情 RPC 不接受图片，不能把 5442 当作图片不可用。 */
import type { StudioClient } from './client.ts';
import { CanvasClient } from './canvas-client.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
import type { ExistingArtifactSource } from '../contracts/artifact-source.ts';

export async function templateImage(
  studio: StudioClient,
  templateId: string,
  nodeId: string,
  assetId: string,
): Promise<ExistingArtifactSource> {
  const response = object(
    await new CanvasClient(studio).call('/tripo.canvas.api.agent.TemplateService/GetTemplate', {
      id: templateId,
    }),
  );
  const template = object(response.template);
  if (object(template.summary).id !== templateId || !Array.isArray(template.nodes))
    throw new TripoError('CONTRACT_CHANGED', 'Template image source belongs to another or invalid graph.');
  const nodes = template.nodes.map(object).filter((node) => node.id === nodeId);
  if (nodes.length !== 1)
    throw new TripoError(
      nodes.length ? 'CONTRACT_CHANGED' : 'ARTIFACT_NOT_FOUND',
      'The requested template image node is not uniquely available.',
    );
  const node = nodes[0]!;
  // 与网页只读预览一致：精确挂载或生成资产；不回退 params.preview、缩略图或最新选中项。
  const matches = [...array(node.inputMount), ...array(node.nodeAssets)]
    .map(object)
    .filter((asset) => asset.assetId === assetId);
  if (matches.length !== 1)
    throw new TripoError(
      matches.length ? 'CONTRACT_CHANGED' : 'ARTIFACT_NOT_FOUND',
      'The requested template image asset is not uniquely available on this node.',
    );
  const asset = matches[0]!;
  const url = text(asset.url);
  if (!url) throw new TripoError('ARTIFACT_NOT_READY', 'This template image has no original URL.');
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    throw new TripoError('CONTRACT_CHANGED', 'Template image has an invalid original URL.');
  }
  const kind = text(asset.kind);
  if ((kind && kind !== 'ASSET_KIND_IMAGE') || !/\.(?:png|jpe?g|webp)$/i.test(pathname))
    throw new TripoError('ARTIFACT_FORMAT_UNCONFIRMED', 'The selected template asset is not an image.');
  studio.credentials.load();
  return { url, format: 'image', source_id: assetId, template_id: templateId, node_id: nodeId };
}
