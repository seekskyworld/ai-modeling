/** 上传句柄只暴露随机标识；真实存储引用、账号和缓存路径留在系统凭据库。 */
import { Entry } from './keyring-entry.ts';
import { randomUUID } from 'node:crypto';
import { TripoError } from '../contracts/errors.ts';
import type { AdmittedImageResult } from './image-admission.ts';
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
export function saveUpload(value: SavedUpload, kind: 'image' | 'model'): string {
  const token = `studio_file_${kind}_${randomUUID()}`;
  new Entry('ai-modeling-upload', token).setPassword(JSON.stringify(value));
  return token;
}
export function loadUpload(token: string, account?: string): SavedUpload {
  if (!isFileToken(token)) throw new TripoError('INVALID_INPUT', 'Invalid Studio file token.');
  const raw = new Entry('ai-modeling-upload', token).getPassword();
  if (!raw) throw new TripoError('INPUT_NOT_FOUND', 'Studio file token was not found on this machine.');
  const saved = JSON.parse(raw) as SavedUpload;
  if (account !== undefined && saved.account !== account)
    throw new TripoError('ACCOUNT_MISMATCH', 'Uploaded file belongs to another Studio account.');
  return saved;
}
