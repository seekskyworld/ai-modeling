/** Exercise the real CLI parser with synthetic auth and state, including dangerous argument reordering. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStructuredArgs, structuredInput, structuredRoute } from '../cli/structured-input.ts';
import { toolMetadata } from '../cli/commands.ts';

const exec = promisify(execFile);
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const hook = fileURLToPath(new URL('./live27-auth-cli-hook.ts', import.meta.url));
const loginId = '11111111-1111-4111-8111-111111111111';

test('structured inputs preserve identity with either option order and reject ambiguous or malformed arguments', async () => {
  for (const args of [
    [
      'call',
      'ai_modeling_auth_cancel',
      '--input',
      JSON.stringify({ login_id: loginId }),
      '--toolset',
      'studio',
    ],
    [
      'call',
      '--toolset=studio',
      'ai_modeling_auth_cancel',
      `--input=${JSON.stringify({ login_id: loginId })}`,
    ],
    ['call', 'ai_modeling_auth_cancel', '--toolset', 'studio', '--input-stdin'],
    ['--profile', 'isolated-profile', 'call', 'ai_modeling_auth_cancel', '--input-stdin'],
  ]) {
    assert.deepEqual(
      await structuredInput(parseStructuredArgs(structuredRoute(args)), async () =>
        JSON.stringify({ login_id: loginId }),
      ),
      { login_id: loginId },
    );
  }
  for (const args of [
    ['call', 'tool', '--input-stdin', '--input', '{}'],
    ['call', 'tool', '--input', '{}', '--input-stdin'],
    ['call', 'tool', '--toolset', 'studio', '--toolset', 'full'],
    ['call', 'tool', '--input'],
    ['call', 'tool', '--wat', 'x'],
    ['call', 'tool', 'extra'],
    ['tools', '--input', '{}'],
  ])
    assert.throws(() => parseStructuredArgs(args), { code: 'INVALID_INPUT' });
  for (const json of ['{', 'null', '[]', 'true'])
    await assert.rejects(
      structuredInput(parseStructuredArgs(['call', 'tool', '--input', json]), async () => ''),
      { code: 'INVALID_INPUT' },
    );
  await assert.rejects(
    structuredInput(parseStructuredArgs(['call', 'tool', '--input-stdin']), async () => ' '.repeat(1048577)),
    { code: 'INVALID_INPUT' },
  );
});

test('the production CLI passes a reordered login ID and discovers tools without opening runtime state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-structured-'));
  const trace = path.join(directory, 'trace.jsonl');
  await writeFile(trace, '');
  const env = {
    ...process.env,
    AI_MODELING_DATA_DIR: path.join(directory, 'unused-data'),
    AI_MODELING_PROFILE: 'structured-fixture',
    LIVE27_TRACE: trace,
  };
  const invoke = async (args: string[]) =>
    JSON.parse(
      (await exec(process.execPath, ['--import', hook, main, ...args], { env, timeout: 30000 })).stdout,
    );
  try {
    await invoke([
      'call',
      'ai_modeling_auth_cancel',
      '--toolset',
      'studio',
      '--input',
      JSON.stringify({ login_id: loginId }),
    ]);
    const records = (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));
    assert.equal(records.find((row) => row.kind === 'cancel-login').login_id, loginId);
    assert.equal(
      records.some((row) => row.kind === 'create-application'),
      false,
    );
    // A directory initialization would fail; discovery must not even read settings or construct credential storage.
    await writeFile(env.AI_MODELING_DATA_DIR, 'not a directory');
    for (const [toolset, count] of [
      ['default', 6],
      ['full', 26],
      ['studio', 182],
    ] as const) {
      const tools = await invoke(['tools', '--toolset', toolset]);
      assert.equal(tools.length, count);
      assert.deepEqual(tools, toolMetadata(toolset));
    }
    for (const args of [
      ['call', 'ai_modeling_auth_cancel', '--input', '{'],
      ['call', 'ai_modeling_auth_cancel', '--unknown'],
    ]) {
      await assert.rejects(invoke(args), (error: unknown) => {
        assert.equal(JSON.parse((error as { stdout: string }).stdout).error.code, 'INVALID_INPUT');
        return true;
      });
    }
    const final = (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));
    assert.equal(
      final.some((row) => row.kind === 'create-application'),
      false,
    );
    assert.equal(final.filter((row) => row.kind === 'cancel-login').length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
