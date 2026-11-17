/** Synthetic cross-process regression: a synchronous store delay must not revive a logged-out session. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
    const source = `
import {JsonStore} from ${JSON.stringify(new URL('../studio/auth/credentials.ts', import.meta.url).href)};
import {beginLogin} from ${JSON.stringify(new URL('../cli/auth/coordinator.ts', import.meta.url).href)};
import {startLoginBroker} from ${JSON.stringify(new URL('../cli/auth/broker.ts', import.meta.url).href)};
const config=${JSON.stringify(config)};
const candidate=${JSON.stringify(session)};
const store=new JsonStore(config.credentialProfile);
const load=store.load.bind(store);
let stall=false;
store.load=()=>{
  if(stall){
    stall=false;
    process.stdout.write('STALLED\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);
  }
  return load();
};
let browserOptions;
const runtime={
  store,
  verify:async()=>{stall=true;return {session:candidate,result:{authenticated:true}}},
  browser:async(options)=>{
    browserOptions=options;
    await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));
  }
};
let broker;
runtime.launch=async(start)=>{broker=await startLoginBroker(start,runtime)};
try {
  await beginLogin({config,open:true},runtime);
  const accepted=await browserOptions.accept(candidate);
  process.stdout.write(JSON.stringify({accepted})+'\\n');
} catch(error) {
  process.stdout.write(JSON.stringify({error:error.code})+'\\n');
  process.exitCode=1;
} finally {
  await broker?.close();
}
`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'close');
    let output = '',
      errors = '';
    const stalled = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('STALLED\n')) resolve();
      });
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    });
    await Promise.race([
      stalled,
      exited.then(([code]) => {
        throw new Error(`Login worker exited before the store delay (${code}): ${errors}`);
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
    assert.ok(output.includes('{"accepted":true}'), output);
    assert.equal(store.load(), undefined, 'a late login must not recreate the logged-out session');
    assert.equal((await readState(config))?.status, 'cancelled');
  },
);
