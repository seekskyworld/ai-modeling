/** 验收时保存原字节，URL-only 回执过期后仍可交付；内容地址不替代任务身份检查。 */
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { verifiedArtifactBytes } from './recover-download.ts';

export interface VerifiedBytes {
  sha256: string;
  bytes: number;
}
interface CacheDirectory {
  path: string;
  dev: number;
  ino: number;
}
const denied = (): TripoError =>
  new TripoError(
    'VERIFIED_CACHE_PATH_DENIED',
    'The private cache directory is not the expected local directory.',
    'read',
  );
/** 缓存根与账号桶不得是符号链接；记录真实目录身份，异步候选读取后必须重新建立边界。 */
function directories(cached: Artifact, dataDir: string, create: boolean): CacheDirectory[] | undefined {
  const root = realpathSync(dataDir),
    bucket = path.dirname(cached.local_path!);
  const result: CacheDirectory[] = [];
  for (const directory of [root, path.join(root, 'verified-output-cache'), bucket]) {
    let stat;
    try {
      stat = lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return;
      checkDirectories(result);
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
      }
      stat = lstatSync(directory);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(directory) !== directory) throw denied();
    result.push({ path: directory, dev: stat.dev, ino: stat.ino });
  }
  checkDirectories(result);
  return result;
}
function checkDirectories(expected: CacheDirectory[]): void {
  for (const saved of expected) {
    const current = lstatSync(saved.path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== saved.dev ||
      current.ino !== saved.ino ||
      realpathSync(saved.path) !== saved.path
    )
      throw denied();
  }
}
/** 关键目录检查与打开/发布之间不经过 await；打开后再次核目录，再读写固定文件描述符。 */
function validCachedFile(cached: Artifact, expected: CacheDirectory[]): boolean {
  checkDirectories(expected);
  let fd: number | undefined;
  try {
    fd = openSync(cached.local_path!, constants.O_RDONLY | constants.O_NOFOLLOW);
    checkDirectories(expected);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== cached.bytes || stat.size > 300 * 1024 * 1024) return false;
    const bytes = readFileSync(fd);
    checkDirectories(expected);
    return createHash('sha256').update(bytes).digest('hex') === cached.sha256;
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function publishCachedFile(cached: Artifact, bytes: Buffer, expected: CacheDirectory[]): void {
  const temporary = path.join(path.dirname(cached.local_path!), `.cache-${randomUUID()}.part`);
  let fd: number | undefined;
  checkDirectories(expected);
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    checkDirectories(expected);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    checkDirectories(expected);
    try {
      linkSync(temporary, cached.local_path!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!validCachedFile(cached, expected))
        throw new TripoError(
          'VERIFIED_CACHE_INVALID',
          'An existing private cache file does not match its content address.',
          'read',
        );
    }
    checkDirectories(expected);
  } finally {
    if (fd !== undefined) closeSync(fd);
    // 目录发生变化时不按新路径删除，防止清理误碰替换后的目录。
    try {
      checkDirectories(expected);
      unlinkSync(temporary);
    } catch {
      // 保留主操作的边界错误；清理失败不跟随替换后的路径，也不覆盖原始异常。
    }
  }
}
function cachedArtifact(
  job: Pick<Job, 'account_ref'>,
  artifact: Artifact,
  proof: VerifiedBytes,
  dataDir: string,
): Artifact {
  if (!/^[a-f0-9]{64}$/.test(proof.sha256) || !Number.isSafeInteger(proof.bytes) || proof.bytes <= 0)
    throw new TripoError('VERIFIED_CACHE_INVALID', 'The original byte proof is invalid.', 'read');
  const account = createHash('sha256').update(job.account_ref).digest('hex');
  return {
    ...artifact,
    local_path: path.join(realpathSync(dataDir), 'verified-output-cache', account, `${proof.sha256}.glb`),
    sha256: proof.sha256,
    bytes: proof.bytes,
  };
}
export async function saveVerifiedOutputCache(
  job: Pick<Job, 'account_ref'>,
  artifact: Artifact,
  proof: VerifiedBytes,
  bytes: Buffer,
  dataDir: string,
): Promise<Artifact> {
  if (bytes.length !== proof.bytes || createHash('sha256').update(bytes).digest('hex') !== proof.sha256)
    throw new TripoError(
      'VERIFIED_CACHE_INVALID',
      'The bytes do not match their frozen original proof.',
      'read',
    );
  const cached = cachedArtifact(job, artifact, proof, dataDir);
  const expected = directories(cached, dataDir, true)!;
  if (validCachedFile(cached, expected)) return cached;
  publishCachedFile(cached, bytes, expected);
  return cached;
}

/** 前端转换需先证明并缓存文件再申请 export-lite；内容缓存只依赖账号，不伪造远端任务。 */
export async function readVerifiedOutputCache(
  account: string,
  proof: VerifiedBytes,
  dataDir: string,
): Promise<Buffer | undefined> {
  const artifact: Artifact = { artifact_id: 'frontend-model', kind: 'model', format: 'glb', index: 0 };
  const cached = cachedArtifact({ account_ref: account }, artifact, proof, dataDir);
  const expected = directories(cached, dataDir, false);
  if (!expected || !validCachedFile(cached, expected)) return;
  const bytes = await verifiedArtifactBytes(cached);
  checkDirectories(expected);
  return bytes;
}

/** 前端产物历史只查本机原缓存；不因授权成功而跳过缺失、损坏或目录身份检查。 */
export function hasVerifiedOutputCache(account: string, proof: VerifiedBytes, dataDir: string): boolean {
  const cached = cachedArtifact(
    { account_ref: account },
    { artifact_id: 'frontend-model', kind: 'model', format: 'glb', index: 0 },
    proof,
    dataDir,
  );
  const expected = directories(cached, dataDir, false);
  return Boolean(expected && validCachedFile(cached, expected));
}

/** 历史 URL-only 导出可能复用完全相同的远端文件；只认同账号、同 SHA 与字节数，不匹配名字或近似模型。 */
export async function recoverVerifiedArtifact(
  job: Job,
  artifact: Artifact,
  proof: VerifiedBytes,
  jobs: JobStore,
  dataDir: string,
): Promise<Artifact | undefined> {
  const cached = cachedArtifact(job, artifact, proof, dataDir);
  const expected = directories(cached, dataDir, false);
  if (expected && validCachedFile(cached, expected)) return cached;
  for (const candidate of [artifact, ...jobs.cachedArtifacts(job.account_ref, proof.sha256, proof.bytes)]) {
    if (candidate.sha256 !== proof.sha256 || candidate.bytes !== proof.bytes) continue;
    const bytes = await verifiedArtifactBytes(candidate);
    if (bytes) return await saveVerifiedOutputCache(job, artifact, proof, bytes, dataDir);
  }
}
