/** Verify the shared test boundary itself before allowing any credential or external transport exercise. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { Socket } from 'node:net';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { JsonEntry } from '../studio/auth/json-entry.ts';
import { object } from '../studio/contracts/errors.ts';
import { offlineTestEnvironment } from '../scripts/test-environment.ts';

test('the runner keeps explicit optional Blender selection while excluding account and state settings', () => {
  const source = {
    HOME: '/synthetic/user',
    CODEX_HOME: '/synthetic/codex',
    AI_MODELING_DATA_DIR: '/private-data',
    AI_MODELING_PROFILE: 'operator',
    AI_MODELING_BLENDER: '/tools/blender',
    AI_MODELING_TEST_BLENDER: '/test-tools/blender',
    AI_MODELING_TEST_LOGIN_MODE: 'accept',
    TRIPO_PROFILE: 'old',
    NODE_OPTIONS: '--inspect',
  };
  const isolated = offlineTestEnvironment(source, '/synthetic/test-state', 'file:///synthetic/test-hook.ts');
  assert.equal(isolated.HOME, source.HOME);
  assert.equal(isolated.CODEX_HOME, source.CODEX_HOME);
  assert.equal(isolated.AI_MODELING_TEST_BLENDER, source.AI_MODELING_TEST_BLENDER);
  assert.equal(isolated.AI_MODELING_BLENDER, undefined);
  assert.equal(isolated.AI_MODELING_DATA_DIR, undefined);
  assert.equal(isolated.AI_MODELING_PROFILE, undefined);
  assert.equal(isolated.AI_MODELING_TEST_LOGIN_MODE, undefined);
  assert.equal(isolated.TRIPO_PROFILE, undefined);
  assert.equal(isolated.NODE_OPTIONS, '--import=file:///synthetic/test-hook.ts');
  assert.equal(
    offlineTestEnvironment({ AI_MODELING_BLENDER: '/tools/blender' }, '/state', 'hook')
      .AI_MODELING_TEST_BLENDER,
    '/tools/blender',
  );
  assert.equal(source.NODE_OPTIONS, '--inspect');
});

test('offline workers and inherited CLI children share JSON only inside the disposable OS home', async () => {
  const sandbox = process.env.MODELING_TEST_SANDBOX;
  assert.ok(sandbox, 'Use scripts/run-tests.ts, including when selecting an individual file.');
  assert.ok(os.userInfo().homedir.startsWith(sandbox + path.sep));
  assert.ok(process.env.AI_MODELING_DATA_DIR?.startsWith(sandbox + path.sep));
  assert.equal(os.homedir(), os.userInfo().homedir);
  const entry = new JsonEntry('synthetic-only', 'synthetic-only');
  entry.setPassword('synthetic-value');
  assert.equal(entry.getPassword(), 'synthetic-value');
  const result = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import os from 'node:os';
    import {JsonEntry} from ${JSON.stringify(new URL('../studio/auth/json-entry.ts', import.meta.url).href)};
    console.log(JSON.stringify({ home: os.homedir(), data: process.env.AI_MODELING_DATA_DIR, saved: new JsonEntry('synthetic-only','synthetic-only').getPassword() }));
  `,
  ]);
  assert.deepEqual(JSON.parse(result.stdout), {
    home: os.homedir(),
    data: process.env.AI_MODELING_DATA_DIR,
    saved: 'synthetic-value',
  });
});

test('offline transport rejects external requests before connecting and retains loopback fixtures', async () => {
  assert.ok(process.env.MODELING_TEST_SANDBOX);
  const socket = new Socket();
  try {
    assert.throws(() => socket.connect({ host: 'example.invalid', port: 443 }), {
      code: 'TEST_NETWORK_BLOCKED',
    });
  } finally {
    socket.destroy();
  }
  await assert.rejects(fetch('https://example.invalid/isolation-check'), (error: unknown) => {
    assert.equal(object(object(error).cause).code, 'UND_MOCK_ERR_MOCK_NOT_MATCHED');
    return true;
  });
  const server = createServer((_request, response) => response.end('fixture'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(await (await fetch(`http://127.0.0.1:${address.port}/`)).text(), 'fixture');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
