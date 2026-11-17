/** 可控上游只在测试代码中注入，生产入口不提供绕过认证的环境变量。 */
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { JobStore } from '../cli/storage/jobs.ts';
import { TaskService } from '../cli/core/service.ts';
import type { Job, Quote, RemoteStatus, RemoteIds } from '../studio/contracts/types.ts';
import type { Gateway } from '../studio/api/gateway.ts';

export const quote: Quote = {
  known: true,
  credits: 10,
  hard_limit: false,
  source: 'test fixture',
  observed_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 600000).toISOString(),
  explanation: 'test',
};
export const imageInput = { prompt: 'A blue toy robot', model_version: 'gemini_3.1_flash_image_preview' };
export class FakeGateway implements Gateway {
  posts = 0;
  failSubmit?: Error;
  failPoll?: Error;
  async account(): Promise<Record<string, unknown>> {
    return { authenticated: true, balance: 100, account_ref: 'test-account' };
  }
  async submit(_job: Job): Promise<{ remote_ids: RemoteIds }> {
    this.posts++;
    if (this.failSubmit) throw this.failSubmit;
    return { remote_ids: { asset_id: 'remote-image-1' } };
  }
  async status(_job: Job): Promise<RemoteStatus> {
    if (this.failPoll) throw this.failPoll;
    return {
      state: 'succeeded',
      progress: 100,
      artifacts: [{ artifact_id: 'image-0', kind: 'image', format: 'image', index: 0 }],
    };
  }
  async artifactUrl(_job: Job): Promise<string> {
    return 'https://cdn.tripo3d.ai/test.png';
  }
}
export async function fixture(
  existing?: string,
): Promise<{ dir: string; jobs: JobStore; gateway: FakeGateway; service: TaskService }> {
  const dir = existing ?? (await mkdtemp(path.join(os.tmpdir(), 'tripo-mcp-test-')));
  await mkdir(path.join(dir, 'output'), { recursive: true });
  const jobs = new JobStore(path.join(dir, 'jobs.sqlite'));
  const gateway = new FakeGateway();
  const credentials = new MemoryCredentials({
    cookie: 'not-a-real-cookie-value',
    deviceId: 'test-device',
    accountRef: 'test-account',
    importedAt: new Date().toISOString(),
  });
  const service = new TaskService({
    jobs,
    gateway,
    credentials,
    pricing: { quote: async () => quote },
    config: { dataDir: dir, outputDir: path.join(dir, 'output'), inputRoots: [dir], keyringAccount: 'test' },
  });
  return { dir, jobs, gateway, service };
}
export function tinyGlb(animationOnly = false): Buffer {
  const json = JSON.stringify({
    asset: { version: '2.0' },
    ...(animationOnly
      ? { animations: [{ channels: [], samplers: [] }] }
      : { meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] }),
  });
  const body = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const header = Buffer.alloc(20);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + body.length, 8);
  header.writeUInt32LE(body.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, body]);
}
