/** 少数即时导出没有 operator_id；临时下载链接进入私有 JSON，不进入业务数据库或日志。 */
import { JsonEntry, jsonStorageUnavailable } from './json-entry.ts';
import type { AuthStorageOptions } from './control-directory.ts';
export interface ArtifactLinks {
  get(jobId: string): string | undefined;
  set(jobId: string, url: string): void;
}
export class JsonLinks implements ArtifactLinks {
  private profile: string;
  private options: AuthStorageOptions;
  constructor(profile: string, options: AuthStorageOptions = {}) {
    this.profile = profile;
    this.options = options;
  }
  private entry(jobId: string): JsonEntry {
    return new JsonEntry('ai-modeling.artifacts', JSON.stringify([this.profile, jobId]), this.options);
  }
  get(jobId: string): string | undefined {
    const value = this.entry(jobId).getPassword();
    return value === null ? undefined : checkedLink(value);
  }
  set(jobId: string, url: string): void {
    this.entry(jobId).setPassword(checkedLink(url));
  }
}
function checkedLink(value: string): string {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\0\r\n]/.test(value))
      throw new Error('Invalid link.');
    return value;
  } catch {
    throw jsonStorageUnavailable();
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
