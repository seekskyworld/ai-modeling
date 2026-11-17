/** Native Keychain calls can wait indefinitely; keep them outside the CLI process. */
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TripoError } from '../contracts/errors.ts';
import { isKeyringRequest, keyringMessageLimit, type KeyringRequest } from './keyring-protocol.ts';

export const keyringTimeoutMs = 10000;
export const keyringRecoveryMessage =
  'Unlock the OS credential store and allow ai-modeling (Node.js) access when prompted, then retry the original command.';
type KeyringRunner = (
  executable: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export function keyringUnavailable(
  timedOut = false,
  certainty: TripoError['certainty'] = 'read',
): TripoError {
  return new TripoError(
    'CREDENTIAL_STORE_UNAVAILABLE',
    `${timedOut ? 'The system credential store did not respond within 10 seconds.' : 'The system credential store is unavailable.'} ${keyringRecoveryMessage}`,
    certainty,
  );
}

/** Keep runtime injection, diagnostic output and unrelated credentials out of the helper. */
function helperEnvironment(): NodeJS.ProcessEnv {
  const names = new Set([
    'PATH',
    'SYSTEMROOT',
    'WINDIR',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
  ]);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase())));
}

function readResponse(output: unknown, operation: KeyringRequest['operation']): string | null {
  const certainty = operation === 'get' ? 'read' : 'unknown';
  if (typeof output !== 'string' || Buffer.byteLength(output) > keyringMessageLimit)
    throw keyringUnavailable(false, certainty);
  const response: unknown = JSON.parse(output);
  if (!response || typeof response !== 'object' || Array.isArray(response))
    throw keyringUnavailable(false, certainty);
  const body = response as Record<string, unknown>;
  const keys = operation === 'get' ? ['ok', 'value'] : ['ok'];
  if (
    body.ok !== true ||
    Object.keys(body).length !== keys.length ||
    Object.keys(body).some((key) => !keys.includes(key)) ||
    (operation === 'get' && body.value !== null && typeof body.value !== 'string')
  )
    throw keyringUnavailable(false, certainty);
  return operation === 'get' ? (body.value as string | null) : null;
}

/** The injectable runner is an internal test seam, never a CLI or environment override. */
export function runKeyring(request: KeyringRequest, runner: KeyringRunner = spawnSync): string | null {
  const certainty = request.operation === 'get' ? 'read' : 'unknown';
  try {
    const input = JSON.stringify(request);
    if (!isKeyringRequest(request) || Buffer.byteLength(input) > keyringMessageLimit)
      throw keyringUnavailable(false, certainty);
    const worker = fileURLToPath(
      new URL(
        import.meta.url.endsWith('.ts') ? './keyring-worker.ts' : './keyring-worker.js',
        import.meta.url,
      ),
    );
    const result = runner(process.execPath, [worker], {
      input,
      encoding: 'utf8',
      timeout: keyringTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: keyringMessageLimit,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      env: helperEnvironment(),
    });
    if (result.error || result.status !== 0 || result.signal)
      throw keyringUnavailable(
        (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
        certainty,
      );
    return readResponse(result.stdout, request.operation);
  } catch (error) {
    if (error instanceof TripoError) throw error;
    // Never expose native errors, child output, request bytes, or process options.
    throw keyringUnavailable(false, certainty);
  }
}
