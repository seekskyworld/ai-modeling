/** 默认daemon入口的跨进程测试：只替换认证runtime，真实IPC/状态锁/进程生命周期保留。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../cli/core/config.ts';
import { loginStateFile, readState } from '../cli/auth/state.ts';
import { readLogin, cancelLogin } from '../cli/auth/coordinator.ts';
import { fakeLoginSession } from './login-runtime-fixture.ts';
const exec = promisify(execFile);
async function processFixture(mode = 'pending') {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'tripo-login-process-')));
  const config: Config = {
    dataDir: directory,
    keyringAccount: path.basename(directory),
    inputRoots: [],
    outputDir: '',
  };
  const hook = path.join(directory, 'runtime-hook.mjs'),
    runtime = new URL('../cli/auth/runtime.ts', import.meta.url).href,
    fixture = new URL('./login-runtime-fixture.ts', import.meta.url).href;
  await writeFile(
    hook,
    `import{registerHooks}from'node:module';registerHooks({resolve(s,c,n){const r=n(s,c);return r.url===${JSON.stringify(runtime)}?{url:${JSON.stringify(fixture)},shortCircuit:true}:r;}});`,
    { mode: 0o600 },
  );
  const environment = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(hook).href}`.trim(),
    AI_MODELING_TEST_LOGIN_MODE: mode,
    DEBUG: 'pw:protocol',
    DEBUG_FILE: path.join(directory, 'forbidden-debug.log'),
    PWDEBUG: '1',
  };
  const entry = new URL('../cli/auth/coordinator.ts', import.meta.url).href;
  const run = async (expression: string) => {
    const script = `import * as login from ${JSON.stringify(entry)};const config=${JSON.stringify(config)};console.log(JSON.stringify(await (${expression})));`;
    const output = await exec(process.execPath, ['--input-type=module', '--eval', script], {
      env: environment,
      cwd: directory,
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(output.stdout);
  };
  const close = async () => {
    await cancelLogin(undefined, { config }).catch(() => undefined);
    const current = await readState(config);
    if (current?.pid && current.pid !== process.pid) {
      for (let i = 0; i < 30; i++) {
        try {
          process.kill(current.pid, 0);
        } catch {
          break;
        }
        await delay(50);
      }
      try {
        process.kill(current.pid, 'SIGTERM');
      } catch {
        /*owned test daemon already stopped*/
      }
    }
    await rm(await loginStateFile(config), { force: true });
    await rm(directory, { recursive: true, force: true });
  };
  return { config, directory, run, close };
}
test('two CLI processes share one detached login and clear protocol-debug environment in its worker', async () => {
  const f = await processFixture();
  try {
    const values = await Promise.all([
      f.run('login.beginLogin({config,open:true})'),
      f.run('login.beginLogin({config,open:true})'),
    ]);
    assert.equal(values[0].login_id, values[1].login_id);
    const state = (await readState(f.config))!;
    assert.notEqual(state.pid, process.pid);
    const events = (await readFile(path.join(f.directory, 'fixture-browser-events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].pid, state.pid);
    for (const key of ['debug', 'debug_file', 'pwdebug', 'arguments_contain_cookie'])
      assert.equal(events[0][key], false);
    const status = await readLogin(state.login_id, { config: f.config });
    assert.equal(status.status, 'waiting_for_login');
    const raw = await readFile(await loginStateFile(f.config), 'utf8');
    assert.ok(!raw.includes(fakeLoginSession.cookie!));
    await assert.rejects(readFile(path.join(f.directory, 'forbidden-debug.log')), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
test('dead detached broker is diagnosed and a new begin receives a new login ID', async () => {
  const f = await processFixture();
  try {
    const first = await f.run('login.beginLogin({config,open:false})'),
      state = (await readState(f.config))!;
    process.kill(state.pid, 'SIGKILL');
    await delay(50);
    const dead = await readLogin(first.login_id, { config: f.config });
    assert.equal(dead.status, 'failed');
    assert.equal(dead.error?.code, 'LOGIN_BROKER_UNAVAILABLE');
    const next = await f.run('login.beginLogin({config,open:false})');
    assert.notEqual(next.login_id, first.login_id);
    assert.equal(next.status, 'waiting_for_login');
  } finally {
    await f.close();
  }
});
test('a detached worker saves a fake verified candidate and its parent can exit without losing completion', async () => {
  const f = await processFixture('accept');
  try {
    const started = await f.run('login.beginLogin({config,open:true})');
    const finished = await f.run(
      `login.waitLogin(${JSON.stringify(started.login_id)},{config,timeoutMs:5000})`,
    );
    assert.equal(finished.authenticated, true);
    assert.equal(finished.account_ref, fakeLoginSession.accountRef);
    const stored = JSON.parse(
      await readFile(
        path.join(f.directory, 'fixture-credentials-' + f.config.keyringAccount + '.json'),
        'utf8',
      ),
    );
    assert.deepEqual(stored, fakeLoginSession);
    const stateFile = await readFile(await loginStateFile(f.config), 'utf8');
    assert.ok(!stateFile.includes(fakeLoginSession.cookie!));
  } finally {
    await f.close();
  }
});
