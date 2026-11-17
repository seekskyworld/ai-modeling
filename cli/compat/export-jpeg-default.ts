/** JPEG 只在首次提交前验证来源；显式编码不允许降级，缺省策略可保留原生并告警。 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { JobStore } from '../storage/jobs.ts';
import { text, TripoError } from '../../studio/contracts/errors.ts';
import { download } from '../artifacts/download.ts';
import { inspectGlbJpeg } from '../artifacts/glb-jpeg.ts';
import { artifactFormat } from '../../studio/api/artifact-format.ts';
import { networkFetch, type Fetcher } from '../../studio/api/client.ts';
import { detectFormat } from '../../studio/files.ts';
import {
  canDefaultExportJpeg,
  canExplicitExportJpeg,
  exportJpegIntent,
  exportJpegPolicyKey,
} from '../core/export-jpeg-policy.ts';

type Context = {
  jobs: JobStore;
  gateway: Gateway;
  dataDir: string;
  accountRef: () => string;
};
/** 来源可能是网页保留的 FBX/OBJ/STL；路径仅提供格式提示，下载器仍须核验实物和主机边界。 */
export async function readJpegSource(
  url: string,
  dataDir: string,
  fetcher: Fetcher = networkFetch,
): Promise<Buffer> {
  const format =
    URL.canParse(url) && new URL(url).pathname.toLowerCase().endsWith('.gltf')
      ? 'gltf'
      : artifactFormat(url, 'glb');
  if (!['glb', 'gltf', 'fbx', 'obj', 'stl'].includes(format))
    throw new TripoError('TEXTURE_SOURCE_UNVERIFIED', 'The exact texture source is not a supported model.');
  const root = path.join(dataDir, 'jpeg-export-checks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, 'source-'));
  try {
    const file = await download(url, temporary, `source.${format}`, format, fetcher);
    return await readFile(file.local_path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
function warning(policy: Record<string, unknown>): string {
  return policy.mode === 'jpeg'
    ? `Opaque embedded GLB textures use ${policy.explicit ? 'the requested JPEG encoding' : 'the official JPEG default'} through local texture-only encoding; geometry, skin and animation data bypass model conversion.`
    : `Native texture encoding was retained; the official JPEG default is not fulfilled for this source: ${text(policy.reason)}`;
}

function assertEncodingIntent(previous: Record<string, unknown>, explicit: boolean): void {
  if ((previous.explicit === true) !== explicit || (explicit && previous.mode !== 'jpeg'))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'The original request used a different explicit or default JPEG intent.',
      'not_submitted',
    );
}

async function sourceMode(bytes: Buffer, explicit: boolean): Promise<Record<string, unknown>> {
  const format = detectFormat(bytes);
  if (format !== 'glb') {
    if (!['gltf', 'fbx', 'obj', 'stl'].includes(format))
      throw new TripoError('TEXTURE_SOURCE_UNVERIFIED', 'The exact texture source is not a supported model.');
    const reason = `The original ${format.toUpperCase()} source is outside the verified embedded GLB JPEG scope.`;
    if (explicit) throw new TripoError('TEXTURE_ENCODING_UNSUPPORTED', reason, 'not_submitted');
    // 默认偏好不能阻断本来可执行的网页格式转换；原格式/摘要及不满足 JPEG 的原因随意图冻结。
    return { mode: 'native', source_format: format, reason };
  }
  try {
    await inspectGlbJpeg(bytes);
    return { mode: 'jpeg' };
  } catch (error) {
    if (!(error instanceof TripoError) || error.code !== 'TEXTURE_ENCODING_UNSUPPORTED') throw error;
    // 显式要求是调用方的交付契约；不能像缺省偏好那样退回其它编码后宣称成功。
    if (explicit) throw error;
    return { mode: 'native', reason: error.message };
  }
}

export async function applyDefaultExportJpeg(
  context: Context,
  request: string,
  parameters: Record<string, unknown>,
  existing?: Job,
  read: (url: string, directory: string) => Promise<Buffer> = readJpegSource,
  explicit = parameters.texture_format === 'JPEG',
): Promise<string[]> {
  const account = context.accountRef(),
    key = exportJpegPolicyKey(request),
    previous = context.jobs.requestPolicy(account, key);
  if (previous) assertEncodingIntent(previous, explicit);
  if (existing) {
    // 已登记任务只重用原编码/来源；不因升级而重读来源、改变默认值或追加收费请求。
    if (previous) {
      parameters.expected_operator_id ??= existing.input.expected_operator_id;
      return [warning(previous)];
    }
    return [];
  }
  if (!(explicit ? canExplicitExportJpeg(parameters) : canDefaultExportJpeg(parameters))) return [];
  if (previous) {
    parameters.expected_operator_id ??= previous.operator_id;
    if (previous.intent !== exportJpegIntent(parameters, explicit))
      throw new TripoError('IDEMPOTENCY_CONFLICT', 'The existing JPEG export source or options changed.');
    if (previous.mode === 'jpeg') parameters.texture_format = 'JPEG';
    return [warning(previous)];
  }
  if (!context.gateway.jpegSource) {
    if (explicit)
      throw new TripoError(
        'TEXTURE_ENCODING_UNSUPPORTED',
        'Explicit JPEG requires an inspectable exact Studio source; this gateway cannot verify it.',
        'not_submitted',
      );
    return [
      'Native texture encoding was retained because the exact source cannot be inspected by this gateway; JPEG-default equivalence is unverified.',
    ];
  }
  const source = await context.gateway.jpegSource(account, parameters);
  const bytes = await read(source.url, context.dataDir);
  parameters.expected_operator_id = source.operator_id;
  const policy: Record<string, unknown> = {
    version: 1,
    project_id: parameters.project_id,
    operator_id: source.operator_id,
    intent: exportJpegIntent(parameters, explicit),
    ...(explicit ? { explicit: true } : {}),
    source_sha256: createHash('sha256').update(bytes).digest('hex'),
    source_bytes: bytes.length,
    ...(await sourceMode(bytes, explicit)),
  };
  if (context.accountRef() !== account)
    throw new TripoError('ACCOUNT_MISMATCH', 'The Studio account changed while checking export textures.');
  context.jobs.bindRequestPolicy(account, key, policy);
  if (policy.mode === 'jpeg') parameters.texture_format = 'JPEG';
  return [warning(policy)];
}
