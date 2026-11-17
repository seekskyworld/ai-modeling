/** Studio 打印菜单的协议与只读项目契约；不导出、改变可见性或提交打印订单。 */
import { object, TripoError } from './contracts/errors.ts';
import type { StudioClient } from './api/client.ts';

export type PrintPlatform = 'mac' | 'windows' | 'other';
export const printTargetKeys = [
  'local',
  'bambu-studio',
  'creality-print',
  'orca-slicer',
  'blueprint-studio',
  'elegoo-slicer',
  'anycubic',
  'lychee-slicer',
] as const;
export type PrintTarget = (typeof printTargetKeys)[number];
export const slicerTargetKeys = printTargetKeys.filter((target) => target !== 'local');

const labels: Record<PrintTarget, string> = {
  local: 'Multi-color OBJ download',
  'bambu-studio': 'Bambu Studio',
  'creality-print': 'Creality Print',
  'orca-slicer': 'OrcaSlicer',
  'blueprint-studio': 'Blueprint Studio',
  'elegoo-slicer': 'ElegooSlicer',
  anycubic: 'Anycubic',
  'lychee-slicer': 'Lychee',
};

export function printPlatform(platform: string): PrintPlatform {
  return platform === 'darwin' || platform === 'mac'
    ? 'mac'
    : platform === 'win32' || platform === 'windows'
      ? 'windows'
      : 'other';
}

export function printDelivery(target: PrintTarget, platform: PrintPlatform): 'protocol' | 'download' {
  if (['local', 'anycubic', 'lychee-slicer'].includes(target)) return 'download';
  if (target === 'blueprint-studio' && platform !== 'windows') return 'download';
  if (target === 'bambu-studio' && platform === 'other') return 'download';
  if (target === 'creality-print' && platform === 'mac') return 'download';
  return 'protocol';
}

/** 来源：BzcATFn4.js 的 ur/dr。只是新导出的建议，不改写已有任务，也不自动创建导出。 */
export function printExportSuggestion(
  projectId: string,
  target: PrintTarget,
  platform: PrintPlatform,
  sourceTextureSize = 4096,
): Record<string, unknown> {
  const threeMf = target !== 'local';
  const packaged = threeMf && printDelivery(target, platform) === 'download';
  if (!Number.isInteger(sourceTextureSize) || sourceTextureSize < 1 || sourceTextureSize > 8192)
    throw new TripoError('INVALID_INPUT', 'Source texture size must be an integer between 1 and 8192.');
  return {
    animate_in_place: false,
    animations: [],
    bake_animation_frame: 0,
    enable_bake_animation: false,
    ...(threeMf ? { export_orientation: '-y' } : {}),
    export_vertex_colors: !threeMf,
    fbx_preset: 'blender',
    format: threeMf ? '3mf' : 'obj',
    model_version: 'default',
    name: projectId,
    pack_uv: false,
    project_id: projectId,
    texture_packaging: packaged ? 'zip' : 'embedded',
    texture_size: packaged ? Math.min(4096, sourceTextureSize) : 4096,
    with_animation: true,
  };
}

export function printTargets(platform: PrintPlatform): Record<string, unknown>[] {
  return printTargetKeys.map((target) => ({
    target,
    name: labels[target],
    delivery: printDelivery(target, platform),
    format: target === 'local' ? 'obj' : '3mf',
    color_mode: target === 'local' ? 'multi_color' : 'monochrome',
    requires_textured_model: target === 'local',
    supported_by_print_open: true,
  }));
}

/** 临时签名 URL 仅在调用栈中用于系统协议，不应将返回值写进任务、日志或 MCP 结果。 */
export function printProtocol(
  target: PrintTarget,
  artifactUrl: string,
  projectId: string,
  platform: PrintPlatform,
): string | undefined {
  if (printDelivery(target, platform) !== 'protocol') return;
  const source = new URL(artifactUrl);
  if (source.protocol !== 'https:' || source.username || source.password)
    throw new TripoError(
      'INVALID_INPUT',
      'Printing requires an HTTPS artifact URL without embedded credentials.',
    );
  // 网页先追加下载名称，Orca 再替换 fragment；保留原签名参数，不把 URL 当 Shell 文本。
  source.searchParams.append('name', `${projectId}.3mf`);
  const url = source.toString();
  const encoded = encodeURIComponent(url);
  if (target === 'bambu-studio')
    return platform === 'mac' ? `bambustudioopen://${encoded}` : `bambustudio://open?file=${encoded}`;
  if (target === 'creality-print') return `crealityprintlink://open/?file=${encoded}`;
  if (target === 'orca-slicer')
    return `orcaslicer://open/?file=${encodeURIComponent(`${url.split('#', 1)[0]}#/model.3mf`)}`;
  if (target === 'elegoo-slicer') return `elegooslicer://open/?file=${encoded}`;
  if (target === 'blueprint-studio')
    return `blueprint-studio://preprocess/create-project-with-assets?editor=3d&assets=${encodeURIComponent(JSON.stringify([{ extension: '3mf', name: `${projectId}.3mf`, url }]))}&source=tripo&source_ref=${encodeURIComponent(projectId)}`;
  return;
}

export const printShopVendor = {
  name: 'JuJuBit',
  url: 'https://jujubit.ai/collections/tripo-jujubit',
} as const;

/** 网页仅对私密且有内容风险的项目阻止分享；这里不改变任何可见性。 */
export function printShopAvailability(detail: Record<string, unknown>): {
  ready: boolean;
  reason?: 'private_project' | 'content_not_shareable';
} {
  if (!['private', 'public', 'shareable'].includes(String(detail.visibility)))
    throw new TripoError('CONTRACT_CHANGED', 'Studio did not return a recognized project visibility.');
  if (detail.visibility !== 'private') return { ready: true };
  const sensitive =
    detail.is_nsfw === true || ['nsfw', 'sensitive'].includes(String(detail.content_risk_level));
  return { ready: false, reason: sensitive ? 'content_not_shareable' : 'private_project' };
}

/** 只读取原项目可见性；不把项目详情中的签名链接或其他账号信息传播到 CLI。 */
export async function readPrintShop(
  client: StudioClient,
  projectId: string,
): Promise<{
  project_id: string;
  visibility: string;
  ready: boolean;
  reason?: 'private_project' | 'content_not_shareable';
}> {
  const detail = object(
    await client.request('GET', `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}`),
  );
  if (detail.id !== projectId) throw new TripoError('CONTRACT_CHANGED', 'Project identity mismatch.');
  const availability = printShopAvailability(detail);
  return { project_id: projectId, visibility: String(detail.visibility), ...availability };
}
