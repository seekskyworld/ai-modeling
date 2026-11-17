/** 文件边界使用 realpath 并拒绝符号链接；输入摘要与实际上传字节一致。 */
import { constants } from 'node:fs';
import { lstat, realpath, open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TripoError } from './contracts/errors.ts';
import { isFileToken, loadUpload } from './auth/uploads.ts';
import { zipFormat } from './zip-format.ts';

export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}
export async function readInput(
  file: string,
  roots: string[],
  maxBytes = 20 * 1024 * 1024,
  allowedFormats = ['png', 'jpeg', 'webp'],
): Promise<{ bytes: Buffer; sha256: string; format: string }> {
  if (isFileToken(file)) {
    const saved = loadUpload(file);
    const input = await readInput(saved.path, [], maxBytes, allowedFormats);
    if (input.sha256 !== saved.sha256) throw new TripoError('INPUT_CHANGED', 'Uploaded file cache changed.');
    return input;
  }
  const input = await readBoundedFile(file, roots, maxBytes);
  const format = detectFormat(input.bytes);
  if (!allowedFormats.includes(format))
    throw new TripoError('INPUT_FORMAT', `Accepted formats: ${allowedFormats.join(', ')}.`);
  return { ...input, format };
}
/** JSON 编辑状态复用素材的路径和大小边界，不冒充图片或 glTF 输入。 */
export async function readBoundedFile(
  file: string,
  roots: string[],
  maxBytes: number,
): Promise<{ bytes: Buffer; sha256: string }> {
  const actual = await realpath(file);
  const allowed = await Promise.all(roots.map((root) => realpath(root)));
  if (allowed.length && !allowed.some((root) => inside(root, actual)))
    throw new TripoError('INPUT_PATH_DENIED', 'Input is outside AI_MODELING_INPUT_ROOTS.');
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new TripoError('INPUT_SIZE', `Input must be a regular file of at most ${maxBytes} bytes.`);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new TripoError('INPUT_SIZE', 'Input grew beyond its permitted size.');
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await handle.close();
  }
}
/** Studio 导入上限为 150 MiB；模型同样绑定准备时的真实文件摘要。 */
export async function readModelInput(
  file: string,
  roots: string[],
): Promise<{ bytes: Buffer; sha256: string; format: string }> {
  return await readInput(file, roots, 150 * 1024 * 1024, ['glb', 'gltf', 'fbx', 'obj', 'stl']);
}
/** 根据文件结构判断格式，下载错误页或截断数据不得伪装为成功模型。 */
export function detectFormat(data: Buffer, allowAnimation = false): string {
  if (data.length < 12) throw new TripoError('INVALID_ARTIFACT', 'Artifact is truncated.');
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (data.indexOf(Buffer.from('IEND')) < 0)
      throw new TripoError('INVALID_ARTIFACT', 'PNG has no final chunk.');
    return 'png';
  }
  if (data[0] === 255 && data[1] === 216 && data[data.length - 2] === 255 && data[data.length - 1] === 217)
    return 'jpeg';
  if (
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP' &&
    data.readUInt32LE(4) + 8 === data.length
  )
    return 'webp';
  if (data.toString('ascii', 0, 4) === 'glTF') {
    validateGlb(data, allowAnimation);
    return 'glb';
  }
  return detectExportFormat(data);
}
function detectExportFormat(data: Buffer): string {
  if (data.toString('utf8', 0, 100).trimStart().startsWith('{')) return detectGltf(data);
  if (data.readUInt32LE(0) === 0x04034b50 && data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0)
    return zipFormat(data);
  if (
    data.toString('ascii', 0, 18).startsWith('Kaydara FBX Binary') ||
    data.toString('utf8', 0, 80).startsWith('; FBX')
  )
    return 'fbx';
  if (data.length >= 84 && data.readUInt32LE(80) * 50 + 84 === data.length) return 'stl';
  const start = data.toString('utf8', 0, 8192);
  if (/^solid\s/m.test(start) && /facet normal/.test(start)) return 'stl';
  if (/^v -?[\d.]+ /m.test(start) && /^f /m.test(data.toString('utf8'))) return 'obj';
  throw new TripoError('INVALID_ARTIFACT', 'Downloaded data is not a supported image or model.');
}
/** 文本 glTF 只接受自包含资源；禁止服务端或导入器偷偷读取本地相邻文件。 */
function detectGltf(data: Buffer): string {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(data.toString('utf8'));
  } catch {
    throw new TripoError('INVALID_ARTIFACT', 'Invalid glTF JSON.');
  }
  if (
    (json.asset as { version?: unknown })?.version !== '2.0' ||
    !Array.isArray(json.meshes) ||
    !json.meshes.length
  )
    throw new TripoError('INVALID_ARTIFACT', 'glTF must contain version 2.0 mesh data.');
  validateEmbeddedResources(json);
  return 'gltf';
}
export function validateGlb(data: Buffer, allowAnimation = false): Record<string, unknown> {
  if (
    data.length < 20 ||
    data.toString('ascii', 0, 4) !== 'glTF' ||
    data.readUInt32LE(4) !== 2 ||
    data.readUInt32LE(8) !== data.length ||
    data.readUInt32LE(16) !== 0x4e4f534a
  )
    throw new TripoError('INVALID_ARTIFACT', 'Invalid GLB header or length.');
  const jsonLength = data.readUInt32LE(12);
  if (20 + jsonLength > data.length) throw new TripoError('INVALID_ARTIFACT', 'Truncated GLB JSON.');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(data.toString('utf8', 20, 20 + jsonLength).trim());
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Not a GLB object');
  } catch {
    throw new TripoError('INVALID_ARTIFACT', 'Invalid GLB JSON.');
  }
  if (
    (!Array.isArray(json.meshes) || json.meshes.length === 0) &&
    !(allowAnimation && Array.isArray(json.animations) && json.animations.length > 0)
  )
    throw new TripoError('INVALID_ARTIFACT', 'GLB contains no mesh.');
  validateEmbeddedResources(json);
  validateGlbChunks(data);
  return json;
}
// 下载承诺自包含 GLB，禁止导入器之后再从远端或本机路径读取附加资源。
function validateEmbeddedResources(json: Record<string, unknown>): void {
  for (const resources of [json.buffers, json.images])
    if (
      Array.isArray(resources) &&
      resources.some((resource: unknown) => {
        const uri = (resource as { uri?: unknown } | null)?.uri;
        return uri !== undefined && (typeof uri !== 'string' || !uri.startsWith('data:'));
      })
    )
      throw new TripoError('INVALID_ARTIFACT', 'GLB references an external buffer or image.');
}
function validateGlbChunks(data: Buffer): void {
  for (let offset = 12; offset < data.length;) {
    if (offset + 8 > data.length) throw new TripoError('INVALID_ARTIFACT', 'Truncated GLB chunk.');
    offset += 8 + data.readUInt32LE(offset);
    if (offset > data.length || offset % 4 !== 0)
      throw new TripoError('INVALID_ARTIFACT', 'Invalid GLB chunk length.');
  }
}
/** 输出父目录逐级创建和核对，阻止相对路径逃逸及已存在的链接目录。 */
export async function outputTarget(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0'))
    throw new TripoError('OUTPUT_PATH_DENIED', 'Output must be a relative path.');
  const actualRoot = await realpath(root);
  const target = path.resolve(actualRoot, relative);
  if (!inside(actualRoot, target) || target === actualRoot)
    throw new TripoError('OUTPUT_PATH_DENIED', 'Output escapes its configured root.');
  let parent = actualRoot;
  for (const piece of path.relative(actualRoot, path.dirname(target)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, piece);
    await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(actualRoot, await realpath(parent)))
      throw new TripoError('OUTPUT_PATH_DENIED', 'Output parent is not a safe directory.');
  }
  return target;
}
