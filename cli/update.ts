/** Read public package metadata only; updates remain an explicit package-manager operation. */
import { PACKAGE_NAME, VERSION } from '../version.ts';
import { networkFetch, type Fetcher } from '../studio/api/client.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';

const registry = 'https://registry.npmjs.org';
const maxResponseBytes = 1024 * 1024;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/;

function versionParts(value: unknown): RegExpExecArray | null {
  return typeof value === 'string' && value.length <= 128 ? versionPattern.exec(value) : null;
}

function versionOrder(left: string, right: string): number {
  const a = versionParts(left)!,
    b = versionParts(right)!;
  for (const index of [1, 2, 3]) {
    const difference = BigInt(a[index]!) - BigInt(b[index]!);
    if (difference !== 0n) return difference > 0n ? 1 : -1;
  }
  if (!a[4] || !b[4]) return a[4] ? -1 : b[4] ? 1 : 0;
  const identifiersA = a[4].split('.'),
    identifiersB = b[4].split('.');
  for (let index = 0; index < Math.max(identifiersA.length, identifiersB.length); index++) {
    const x = identifiersA[index],
      y = identifiersB[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x),
      numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function updateInstructions() {
  return {
    package: PACKAGE_NAME,
    current: VERSION,
    latest: null as string | null,
    published: null as boolean | null,
    update_available: null as boolean | null,
    updated: false,
    source: 'npm',
    registry,
    command: `npm install --global ${PACKAGE_NAME}@latest`,
    installation:
      'Run the npm command to update a global installation, or select a version in your npx/MCP configuration. Restart the MCP client and update its installed Skill afterward. Run ai-modeling update --check to inspect the latest public version.',
  };
}

async function readMetadata(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('Missing registry response body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error('Registry response is too large.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export async function checkUpdate(fetcher: Fetcher = networkFetch, current = VERSION) {
  const base = { ...updateInstructions(), current };
  try {
    if (!versionParts(current)) throw new Error('Invalid current package version.');
    const response = await fetcher(`${registry}/${encodeURIComponent(PACKAGE_NAME)}/latest`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return { ...base, published: false, command: null };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Registry request failed.');
    }
    const metadata = await readMetadata(response);
    if (metadata.name !== PACKAGE_NAME || !versionParts(metadata.version))
      throw new Error('Registry package identity or version is invalid.');
    const latest = metadata.version as string;
    const available = versionOrder(latest, current) > 0;
    return {
      ...base,
      latest,
      published: true,
      update_available: available,
      command: available ? `npm install --global ${PACKAGE_NAME}@${latest}` : null,
    };
  } catch {
    throw new TripoError(
      'UPDATE_CHECK_FAILED',
      'Cannot verify the latest npm package version. Check your network or retry later; no installation was changed.',
      'read',
    );
  }
}
