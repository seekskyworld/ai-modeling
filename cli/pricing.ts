/** Pricing administration has no account, task database or submission side effects. */
import { configFromEnv } from './core/config.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import {
  pricingStatus,
  readPriceFile,
  verifyPricingBytes,
  installPricingSnapshot,
  updatePricingSnapshot,
} from '../studio/api/pricing-maintenance.ts';

export { pricingSnapshotStatus } from '../studio/api/pricing-maintenance.ts';

const help = `ai-modeling pricing status
ai-modeling pricing verify FILE [--sha256 SHA256] [--network]
ai-modeling pricing import FILE [--sha256 SHA256] [--network]
ai-modeling pricing update HTTPS_URL --sha256 SHA256

Use a reviewed snapshot from a trusted maintainer. Remote updates require its
independently obtained digest and verify official evidence. No login or generation.
Direct HTTPS URLs are required; redirects are rejected. Evidence matching does not
replace a maintainer's review of the price formulas. Expiry is never extended.
`;

function parseOptions(args: string[]) {
  const command = args[0] ?? 'status';
  const positional: string[] = [];
  let sha256: string | undefined,
    network = false;
  for (let index = 1; index < args.length; index++) {
    const value = args[index]!;
    if (value === '--json') continue;
    if (value === '--network' && !network) network = true;
    else if (value === '--sha256' && sha256 === undefined) {
      sha256 = args[++index];
      if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256))
        throw new TripoError('INVALID_INPUT', 'Use a SHA-256 digest.');
    } else if (value.startsWith('-'))
      throw new TripoError('INVALID_INPUT', 'Unknown or duplicate pricing option.');
    else positional.push(value);
  }
  return { command, positional, sha256, network };
}

export async function pricing(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(help);
    return;
  }
  const { command, positional, sha256, network } = parseOptions(args);
  const config = configFromEnv();
  let result: unknown;
  if (command === 'status' && !positional.length && !sha256 && !network)
    result = await pricingStatus(config.dataDir);
  else if (['verify', 'import'].includes(command) && positional.length === 1) {
    const bytes = await readPriceFile(positional[0]!, config.inputRoots);
    result =
      command === 'verify'
        ? (await verifyPricingBytes(bytes, { sha256, network })).result
        : await installPricingSnapshot(config.dataDir, bytes, { sha256, network });
  } else if (command === 'update' && positional.length === 1 && sha256 && !network)
    result = await updatePricingSnapshot(config.dataDir, positional[0]!, sha256);
  else throw new TripoError('INVALID_INPUT', help);
  process.stdout.write(JSON.stringify(result) + '\n');
}
