/** One native credential operation per child. Never write diagnostics or persist pipe data. */
import { Entry } from '@napi-rs/keyring';
import { isKeyringRequest, keyringMessageLimit } from './keyring-protocol.ts';

try {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > keyringMessageLimit) throw new Error('Invalid request.');
    chunks.push(bytes);
  }
  const request: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isKeyringRequest(request)) throw new Error('Invalid request.');
  const entry = new Entry(
    request.service,
    request.account,
    request.secretService ? { linux: { store: 'secret-service' } } : undefined,
  );
  let response: { ok: true; value?: string | null };
  if (request.operation === 'get') response = { ok: true, value: entry.getPassword() };
  else {
    if (request.operation === 'set') entry.setPassword(request.value);
    else entry.deleteCredential();
    response = { ok: true };
  }
  const output = JSON.stringify(response);
  if (Buffer.byteLength(output) > keyringMessageLimit) throw new Error('Invalid response.');
  process.stdout.write(output);
} catch {
  process.stdout.write('{"ok":false}');
  process.exitCode = 1;
}
