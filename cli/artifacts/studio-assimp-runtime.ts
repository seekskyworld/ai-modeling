/** 明确的网页前端导出入口：验证固定引擎及每次转换的实物，超时只终止本地worker。 */
import { Worker } from 'node:worker_threads';
import { loadStudioAssimpAssets } from './studio-assimp-assets.ts';
import { validateFrontendMetadata, type StudioFrontendMetadata } from './studio-assimp-proof.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

export interface StudioFrontendOptions {
  dataDir: string;
  runtimeDir?: string;
  inputRoots?: string[];
  projectName: string;
  metadata: StudioFrontendMetadata;
  timeoutMs?: number;
}
export interface StudioFrontendResult {
  bytes: Buffer;
  proof: Record<string, unknown>;
}
export async function convertStudioFrontend(
  source: Buffer,
  options: StudioFrontendOptions,
): Promise<StudioFrontendResult> {
  validateFrontendMetadata(options.metadata);
  if (!source.length || source.length > 150 * 1024 * 1024)
    throw new TripoError(
      'FRONTEND_EXPORT_UNVERIFIED',
      'Frontend export requires a nonempty GLB or verified static binary FBX of at most 150 MiB.',
      'not_submitted',
    );
  if (
    !options.projectName.length ||
    options.projectName.length > 128 ||
    /[/\\]/.test(options.projectName) ||
    [...options.projectName].some((character) => character.charCodeAt(0) < 32)
  )
    throw new TripoError(
      'INVALID_INPUT',
      'Frontend export name must be 1–128 characters without path separators or control characters.',
    );
  const timeout = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000)
    throw new TripoError('INVALID_INPUT', 'Frontend conversion timeout must be 1–120000 milliseconds.');
  const assets = await loadStudioAssimpAssets(options);
  const script = new URL(
    import.meta.url.endsWith('.ts') ? './studio-assimp-worker.ts' : './studio-assimp-worker.js',
    import.meta.url,
  );
  return await new Promise<StudioFrontendResult>((resolve, reject) => {
    const worker = new Worker(script, {
      workerData: { source, ...assets, metadata: options.metadata, projectName: options.projectName },
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
    });
    let finished = false;
    const finish = (error?: TripoError, result?: StudioFrontendResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(
      () =>
        finish(
          new TripoError(
            'FRONTEND_CONVERSION_TIMEOUT',
            'Frontend conversion or proof exceeded its time limit; no export was submitted.',
            'not_submitted',
          ),
        ),
      timeout,
    );
    worker.on(
      'message',
      (message: {
        ok: boolean;
        bytes?: Uint8Array;
        proof?: Record<string, unknown>;
        code?: string;
        message?: string;
      }) => {
        if (!message.ok || !message.bytes || !message.proof)
          return finish(
            new TripoError(
              message.code ?? 'FRONTEND_CONVERSION_FAILED',
              message.message ?? 'Frontend conversion failed.',
              'not_submitted',
            ),
          );
        finish(undefined, { bytes: Buffer.from(message.bytes), proof: message.proof });
      },
    );
    worker.on('error', () =>
      finish(
        new TripoError(
          'FRONTEND_CONVERSION_FAILED',
          'Frontend conversion worker failed; no export was submitted.',
          'not_submitted',
        ),
      ),
    );
    worker.on('exit', () => {
      if (!finished)
        finish(
          new TripoError(
            'FRONTEND_CONVERSION_FAILED',
            'Frontend conversion worker exited without a result.',
            'not_submitted',
          ),
        );
    });
  });
}
