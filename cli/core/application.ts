/** 只由 CLI 组合业务服务；MCP 通过 CLI 子进程接入，不直接初始化业务或凭证。 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { configFromEnv, initializeDirectories, type Config } from './config.ts';
import { KeyringStore } from '../../studio/auth/credentials.ts';
import { KeyringLinks } from '../../studio/auth/artifact-links.ts';
import { StudioClient } from '../../studio/api/client.ts';
import { StudioGateway } from '../../studio/api/gateway.ts';
import { PricingService } from '../../studio/api/pricing.ts';
import { reviewedPrices } from '../../studio/api/reviewed-prices.ts';
import { JobStore } from '../storage/jobs.ts';
import { TaskService } from './service.ts';
import { authenticationHandler } from '../auth/recovery.ts';

export async function createApplication(
  config: Config = configFromEnv(),
  options: { authentication?: boolean } = {},
): Promise<{ service: TaskService; studio: StudioGateway; close: () => void }> {
  await initializeDirectories(config);
  const cache = path.join(config.dataDir, 'input-cache');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  config = { ...config, inputRoots: config.inputRoots.length ? [...config.inputRoots, cache] : [] };
  const credentials = new KeyringStore(config.keyringAccount);
  const client = new StudioClient(
    credentials,
    undefined,
    undefined,
    options.authentication === false ? undefined : authenticationHandler(config, credentials),
  );
  const studio = new StudioGateway(client, config.inputRoots, new KeyringLinks(config.keyringAccount));
  const jobs = new JobStore(path.join(config.dataDir, 'jobs.sqlite'));
  jobs.recoverExpired();
  return {
    service: new TaskService({
      jobs,
      gateway: studio,
      credentials,
      pricing: new PricingService(path.join(config.dataDir, 'pricing.json'), reviewedPrices),
      config,
    }),
    studio,
    close: () => jobs.close(),
  };
}
