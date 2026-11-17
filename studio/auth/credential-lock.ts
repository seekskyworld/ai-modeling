/** 每个 JSON 身份独立锁；同 profile 的写入、清理和刷新回写共用跨进程锁。 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lockSync } from 'proper-lockfile';
import { TripoError } from '../contracts/errors.ts';
import { privateAuthDirectory } from './control-directory.ts';

export function withJsonEntryLock<T>(service: string, account: string, run: () => T, directory?: string): T {
  const root = privateAuthDirectory('credential-locks', directory);
  const name = createHash('sha256')
    .update(JSON.stringify([service, account]))
    .digest('hex');
  let release: () => void;
  try {
    release = lockSync(path.join(root, name), { realpath: false, stale: 120000, retries: 0 });
  } catch {
    throw new TripoError(
      'CREDENTIAL_STORE_BUSY',
      'The Studio session is being updated by another process. Retry the original action.',
      'not_submitted',
    );
  }
  try {
    return run();
  } finally {
    release();
  }
}

export function withCredentialLock<T>(profile: string, run: () => T, directory?: string): T {
  return withJsonEntryLock('ai-modeling', profile, run, directory);
}
