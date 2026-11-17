/** 同一文件描述符完成身份检查和有界读取；不跟随最终软链接或回显文件内容/路径。 */
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { TripoError } from '../../studio/contracts/errors.ts';

const maximumBytes = 131072;

function assertCredentialFile(info: BigIntStats): void {
  if (!info.isFile() || info.size > BigInt(maximumBytes))
    throw new TripoError('INVALID_CREDENTIAL', 'Credential file must be a regular file of at most 128 KiB.');
  if (
    process.platform !== 'win32' &&
    ((info.mode & 0o077n) !== 0n || (process.getuid && info.uid !== BigInt(process.getuid())))
  )
    throw new TripoError(
      'CREDENTIAL_FILE_PERMISSIONS',
      'Credential file must be private to its current owner.',
    );
}

function unchanged(before: BigIntStats, after: BigIntStats): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.mode !== after.mode ||
    before.uid !== after.uid
  )
    throw new TripoError('CREDENTIAL_FILE_CHANGED', 'Credential file changed while being read.');
}

async function boundedRead(handle: FileHandle): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const buffer = Buffer.alloc(Math.min(4096, maximumBytes + 1 - size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
    if (!bytesRead) return Buffer.concat(chunks, size);
    size += bytesRead;
    if (size > maximumBytes) throw new TripoError('INVALID_CREDENTIAL', 'Credential file is too large.');
    chunks.push(buffer.subarray(0, bytesRead));
  }
}

export async function readCredentialFile(filename: string): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    const initial = await lstat(filename, { bigint: true });
    assertCredentialFile(initial);
    handle = await open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    assertCredentialFile(opened);
    unchanged(initial, opened);
    const bytes = await boundedRead(handle);
    const final = await handle.stat({ bigint: true });
    assertCredentialFile(final);
    unchanged(opened, final);
    if (BigInt(bytes.length) !== final.size)
      throw new TripoError('CREDENTIAL_FILE_CHANGED', 'Credential file changed while being read.');
    return bytes.toString('utf8');
  } catch (error) {
    if (error instanceof TripoError) throw error;
    throw new TripoError('CREDENTIAL_FILE_UNREADABLE', 'Cannot securely read the credential file.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
