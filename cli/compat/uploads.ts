/** 独立上传返回可重复使用的句柄；缓存保留已核对字节，生成阶段复用已审核的网页引用。 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readInput } from '../../studio/files.ts';
import { uploadFile, uploadImage } from '../../studio/api/upload.ts';
import { saveUpload } from '../../studio/auth/uploads.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Application } from './runtime.ts';
export async function uploadLocal(app: Application, file: string): Promise<Record<string, unknown>> {
  const account = app.service.accountRef();
  const input = await readInput(file, app.service.config.inputRoots, 150 * 1024 * 1024, [
    'png',
    'jpeg',
    'webp',
    'glb',
    'gltf',
    'fbx',
    'obj',
    'stl',
  ]);
  const image = ['png', 'jpeg', 'webp'].includes(input.format);
  if (image && input.bytes.length > 20 * 1024 * 1024)
    throw new TripoError('INPUT_SIZE', 'Image inputs must be at most 20 MiB.');
  const client = app.studio.client.forAccount(account);
  const reference = image
    ? await uploadImage(client, input.bytes, input.format)
    : await uploadFile(client, input.bytes, input.format);
  const dir = path.join(app.service.config.dataDir, 'uploaded-files');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const cached = path.join(dir, `${input.sha256}.${input.format}`);
  await writeFile(cached, input.bytes, { mode: 0o600, flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const token = saveUpload(
    { account, path: cached, sha256: input.sha256, format: input.format, reference },
    image ? 'image' : 'model',
  );
  return {
    file_token: token,
    format: input.format,
    bytes: input.bytes.length,
    sha256: input.sha256,
    backend: 'studio',
  };
}
