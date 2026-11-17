/** 少数即时导出没有 operator_id；临时下载链接进入凭据库，避免签名 URL 落入数据库与日志。 */
import { Entry } from './keyring-entry.ts';
import { keyringUnavailable } from './keyring-process.ts';
import { TripoError } from '../contracts/errors.ts';
export interface ArtifactLinks {
  get(jobId: string): string | undefined;
  set(jobId: string, url: string): void;
}
export class KeyringLinks implements ArtifactLinks {
  private profile: string;
  constructor(profile: string) {
    this.profile = profile;
  }
  private entry(jobId: string): Entry {
    return new Entry('ai-modeling.artifacts', `${this.profile}:${jobId}`);
  }
  get(jobId: string): string | undefined {
    try {
      return this.entry(jobId).getPassword() ?? undefined;
    } catch (error) {
      if (error instanceof TripoError) throw error;
      throw keyringUnavailable();
    }
  }
  set(jobId: string, url: string): void {
    try {
      this.entry(jobId).setPassword(url);
    } catch (error) {
      if (error instanceof TripoError) throw error;
      throw keyringUnavailable(false, 'unknown');
    }
  }
}
export class MemoryLinks implements ArtifactLinks {
  private links = new Map<string, string>();
  get(id: string): string | undefined {
    return this.links.get(id);
  }
  set(id: string, url: string): void {
    this.links.set(id, url);
  }
}
