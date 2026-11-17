/** 上传句柄只暴露随机标识；真实存储引用、账号和缓存路径留在私有本地 JSON。 */
import { JsonEntry, jsonStorageUnavailable } from './json-entry.ts';
import { randomUUID } from 'node:crypto';
import { TripoError } from '../contracts/errors.ts';
import type { AdmittedImageResult } from './image-admission.ts';
import type { AuthStorageOptions } from './control-directory.ts';
import { object } from '../contracts/errors.ts';
export interface SavedUpload {
  account: string;
  path: string;
  sha256: string;
  format: string;
  reference: {
    bucket: string;
    key: string;
    image_audit_result?: AdmittedImageResult;
    image_source?: 'upload';
  };
}
export const isFileToken = (value: string): boolean => /^studio_file_(image|model)_[a-f\d-]{36}$/.test(value);
function checkedUpload(value: unknown): SavedUpload {
  const saved = object(value);
  const reference = object(saved.reference);
  if (
    Object.keys(saved).sort().join(',') !== 'account,format,path,reference,sha256' ||
    !['account', 'path', 'sha256', 'format'].every(
      (key) => typeof saved[key] === 'string' && saved[key] !== '' && !/[\0\r\n]/.test(saved[key] as string),
    ) ||
    !/^[a-f\d]{64}$/.test(String(saved.sha256)) ||
    Object.keys(reference).some(
      (key) => !['bucket', 'key', 'image_audit_result', 'image_source'].includes(key),
    ) ||
    !['bucket', 'key'].every(
      (key) =>
        typeof reference[key] === 'string' &&
        reference[key] !== '' &&
        !/[\0\r\n]/.test(reference[key] as string),
    ) ||
    (reference.image_audit_result !== undefined &&
      !['pass', 'sensitive', 'nsfw'].includes(String(reference.image_audit_result))) ||
    (reference.image_source !== undefined && reference.image_source !== 'upload')
  )
    throw jsonStorageUnavailable();
  return saved as unknown as SavedUpload;
}
export function saveUpload(
  value: SavedUpload,
  kind: 'image' | 'model',
  options: AuthStorageOptions = {},
): string {
  const token = `studio_file_${kind}_${randomUUID()}`;
  new JsonEntry('ai-modeling-upload', token, options).setPassword(JSON.stringify(checkedUpload(value)));
  return token;
}
export function loadUpload(token: string, account?: string, options: AuthStorageOptions = {}): SavedUpload {
  if (!isFileToken(token)) throw new TripoError('INVALID_INPUT', 'Invalid Studio file token.');
  const raw = new JsonEntry('ai-modeling-upload', token, options).getPassword();
  if (!raw) throw new TripoError('INPUT_NOT_FOUND', 'Studio file token was not found on this machine.');
  let saved: SavedUpload;
  try {
    saved = checkedUpload(JSON.parse(raw));
  } catch {
    throw jsonStorageUnavailable();
  }
  if (account !== undefined && saved.account !== account)
    throw new TripoError('ACCOUNT_MISMATCH', 'Uploaded file belongs to another Studio account.');
  return saved;
}
