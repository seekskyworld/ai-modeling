/** Synthetic cross-process regression: a synchronous store delay must not revive a logged-out session. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { JsonStore } from '../studio/auth/credentials.ts';
import { logoutLogin } from '../cli/auth/coordinator.ts';
import { readState } from '../cli/auth/state.ts';

test(
  'logout cannot be undone when a credential read blocks the login lock heartbeat',
  { timeout: 90000 },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-login-stall-'));
    const config = {
      dataDir: directory,
      credentialProfile: path.basename(directory),
      inputRoots: [],
      outputDir: '',
    };
    const session = {
      cookie: 'synthetic-cookie-only',
      deviceId: 'synthetic-device',
      accountRef: 'synthetic-account',
      importedAt: '2026-11-17T00:00:00Z',
    };
    // The real broker and JSON store run in another process. Only the duration of one
    // store read changes, modelling successive synchronous Windows ACL checks.
    // This exercises lock timing; it does not substitute for native Windows ACL tests.
    const fixture = fileURLToPath(new URL('./login-lock-stall-fixture.ts', import.meta.url));
    const child = spawn(process.execPath, [fixture, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'close');
    let errors = '';
    let accepted = false;
    let lastDiagnostic = '';
    let lastFailure = '';
    const lines = createInterface({ input: child.stdout });
    const stalled = new Promise<void>((resolve) => {
      lines.on('line', (line) => {
        if (line.length > 4096) return;
        let value: Record<string, unknown>;
        try {
          value = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!value || value.diagnostic !== 'login_lock_stall') return;
        // Only this fixed schema is reported; never include arbitrary child output or credential fields.
        const diagnostic = {
          diagnostic: 'login_lock_stall',
          phase:
            typeof value.phase === 'string' && /^[a-z_]{1,64}$/.test(value.phase) ? value.phase : 'unknown',
          elapsed_ms: typeof value.elapsed_ms === 'number' ? value.elapsed_ms : undefined,
          store_reads: typeof value.store_reads === 'number' ? value.store_reads : undefined,
          error_code:
            typeof value.error_code === 'string' && /^[A-Z_]{2,64}$/.test(value.error_code)
              ? value.error_code
              : undefined,
          status:
            typeof value.status === 'string' && /^[a-z_]{1,32}$/.test(value.status)
              ? value.status
              : undefined,
          accepted: typeof value.accepted === 'boolean' ? value.accepted : undefined,
        };
        lastDiagnostic = JSON.stringify(diagnostic);
        if (diagnostic.error_code) lastFailure = lastDiagnostic;
        t.diagnostic(lastDiagnostic);
        if (diagnostic.phase === 'store_stalled') resolve();
        if (diagnostic.phase === 'candidate_result') accepted = diagnostic.accepted === true;
      });
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited.catch(() => undefined);
      lines.close();
      await rm(directory, { recursive: true, force: true });
    });
    await Promise.race([
      stalled,
      exited.then(([code]) => {
        throw new Error(
          `Login worker exited before the store delay (${code}): ${lastFailure || lastDiagnostic}`,
        );
      }),
    ]);
    // The old ten-second stale threshold allowed logout to take over this live lock.
    await delay(12000);
    const store = new JsonStore(config.credentialProfile);
    const runtime = {
      store,
      verify: async () => ({ session, result: {} }),
      browser: async () => {},
    };
    const until = Date.now() + 30000;
    let signedOut = false;
    while (!signedOut) {
      try {
        assert.deepEqual(await logoutLogin({ config }, runtime), { signed_out_locally: true });
        signedOut = true;
      } catch (error) {
        if ((error as { code?: string }).code !== 'CREDENTIAL_STORE_BUSY' || Date.now() >= until) throw error;
        await delay(50);
      }
    }
    assert.equal(store.load(), undefined, 'logout must clear the shared JSON session');
    const [code] = await exited;
    assert.equal(code, 0, errors);
    assert.equal(errors.includes('ECOMPROMISED'), false);
    assert.equal(accepted, true, lastDiagnostic);
    assert.equal(store.load(), undefined, 'a late login must not recreate the logged-out session');
    assert.equal((await readState(config))?.status, 'cancelled');
  },
);
