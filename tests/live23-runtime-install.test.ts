/** 固定运行时离线引导：未验输入不落盘，路径换链不越界，CLI/MCP不创建账号状态。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimeStatus, installRuntime } from '../cli/runtime/assets.ts';
import { runtimeCache, runtimeCachePath, runtimeSource } from '../cli/runtime/cache.ts';
import { studioAssimpFiles } from '../cli/runtime/manifest.ts';
import { runtimeTools } from '../cli/runtime/tools.ts';
import { loadStudioAssimpAssets } from '../cli/artifacts/studio-assimp-assets.ts';
import { CliBridge } from '../mcp/cli-bridge.ts';
import { object } from '../studio/contracts/errors.ts';

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tripo-runtime-install-'));
  const config = { dataDir: path.join(root, 'unused-data'), inputRoots: [] as string[] };
  const source = path.join(root, 'source');
  await mkdir(source);
  return { root, config, source, close: async () => await rm(root, { recursive: true, force: true }) };
}
const offlineEnv = (dataDir: string) => ({
  ...process.env,
  AI_MODELING_DATA_DIR: dataDir,
  AI_MODELING_PROFILE: 'runtime-install-no-account',
  AI_MODELING_INPUT_ROOTS: '',
  AI_MODELING_OUTPUT_DIR: '',
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '',
});

test('status lists exact required files without creating a missing data directory', async () => {
  const f = await fixture();
  try {
    const status = runtimeStatus(f.config);
    assert.equal(status.ready, false);
    assert.equal(status.directory, runtimeCachePath(f.config.dataDir));
    assert.deepEqual(
      status.files.map((file) => file.state),
      ['missing', 'missing'],
    );
    assert.ok(status.files.every((file) => file.url.startsWith('https://studio.tripo3d.ai/_assimp/wasm/')));
    await assert.rejects(stat(f.config.dataDir), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('install requires both source files and creates no cache for an incomplete source', async () => {
  const f = await fixture();
  try {
    assert.throws(() => installRuntime(f.config, f.source), { code: 'FRONTEND_RUNTIME_MISSING' });
    assert.throws(() => runtimeStatus(f.config, path.join(f.source, 'missing')), {
      code: 'FRONTEND_RUNTIME_MISSING',
    });
    await assert.rejects(stat(f.config.dataDir), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

for (const kind of ['short', 'same-size-wrong-hash', 'oversized'] as const) {
  test(`install rejects ${kind} source bytes without executing or publishing them`, async () => {
    const f = await fixture();
    try {
      const length = studioAssimpFiles.glue.bytes + (kind === 'short' ? -1 : kind === 'oversized' ? 1 : 0);
      const bytes = Buffer.alloc(length);
      bytes.write('globalThis.__untrusted_runtime_was_executed = true;');
      await writeFile(path.join(f.source, studioAssimpFiles.glue.name), bytes);
      assert.throws(() => installRuntime(f.config, f.source), { code: 'FRONTEND_RUNTIME_INTEGRITY' });
      const status = runtimeStatus(f.config, f.source);
      assert.deepEqual(
        status.files.map((file) => file.state),
        ['invalid', 'missing'],
      );
      assert.equal(status.ready, false);
      assert.equal('__untrusted_runtime_was_executed' in globalThis, false);
      await assert.rejects(stat(f.config.dataDir), { code: 'ENOENT' });
    } finally {
      await f.close();
    }
  });
}

test('source-dir obeys configured input roots and rejects linked final files', async () => {
  const f = await fixture();
  try {
    const allowed = path.join(f.root, 'allowed');
    await mkdir(allowed);
    assert.throws(() => runtimeStatus({ ...f.config, inputRoots: [allowed] }, f.source), {
      code: 'INPUT_PATH_DENIED',
    });
    const file = path.join(f.root, 'untrusted');
    await writeFile(file, 'unchanged');
    await symlink(file, path.join(f.source, studioAssimpFiles.glue.name));
    assert.throws(() => installRuntime(f.config, f.source), { code: 'FRONTEND_RUNTIME_PATH' });
    assert.equal(await readFile(file, 'utf8'), 'unchanged');
    await assert.rejects(stat(f.config.dataDir), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

for (const level of ['root', 'parent', 'bucket'] as const) {
  for (const replacement of ['symlink', 'directory'] as const) {
    test(`cached directory identity rejects ${level} ${replacement} replacement`, async () => {
      const f = await fixture();
      try {
        const cache = runtimeCache(f.config.dataDir, true)!;
        const replaced =
          level === 'root' ? f.config.dataDir : level === 'parent' ? path.dirname(cache.path) : cache.path;
        const moved = path.join(f.root, 'moved');
        await rename(replaced, moved);
        if (replacement === 'symlink') await symlink(moved, replaced);
        else await mkdir(replaced);
        assert.throws(() => cache.read('glue'), { code: 'FRONTEND_RUNTIME_PATH' });
        assert.deepEqual(await readdir(f.source), []);
      } finally {
        await f.close();
      }
    });
  }
}

test('a source directory replaced after inspection cannot supply files', async () => {
  const f = await fixture();
  try {
    const source = runtimeSource(f.source);
    const moved = path.join(f.root, 'old-source');
    await rename(f.source, moved);
    await symlink(moved, f.source);
    assert.throws(() => source.read('glue'), { code: 'FRONTEND_RUNTIME_PATH' });
    await assert.rejects(stat(f.config.dataDir), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('preexisting linked cache paths are rejected without touching their targets', async () => {
  const f = await fixture();
  try {
    await mkdir(f.config.dataDir);
    await symlink(f.source, path.join(f.config.dataDir, 'studio-frontend'));
    assert.throws(() => runtimeStatus(f.config), { code: 'FRONTEND_RUNTIME_PATH' });
    await assert.rejects(
      loadStudioAssimpAssets(f.config, async () => assert.fail('No network fallback')),
      {
        code: 'FRONTEND_RUNTIME_PATH',
      },
    );
    assert.deepEqual(await readdir(f.source), []);
  } finally {
    await f.close();
  }
});

test('corrupt cached bytes remain unchanged and never trigger network recovery', async () => {
  const f = await fixture();
  try {
    const cache = runtimeCache(f.config.dataDir, true)!;
    const file = path.join(cache.path, studioAssimpFiles.glue.name);
    const corrupt = Buffer.alloc(studioAssimpFiles.glue.bytes, 41);
    await writeFile(file, corrupt);
    assert.equal(runtimeStatus(f.config).files[0]!.state, 'invalid');
    await assert.rejects(
      loadStudioAssimpAssets(f.config, async () => assert.fail('No network fallback')),
      {
        code: 'FRONTEND_RUNTIME_INTEGRITY',
      },
    );
    assert.deepEqual(await readFile(file), corrupt);
  } finally {
    await f.close();
  }
});

test('nonregular source entries are rejected before opening or waiting on a FIFO writer', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.source, studioAssimpFiles.glue.name);
    await mkdir(file);
    assert.throws(() => installRuntime(f.config, f.source), { code: 'FRONTEND_RUNTIME_INTEGRITY' });
    await rm(file, { recursive: true });
    if (process.platform !== 'win32') {
      await exec('mkfifo', [file]);
      const cli = await exec(
        process.execPath,
        ['cli/main.ts', 'runtime', 'status', '--source-dir', f.source, '--json'],
        { env: offlineEnv(f.config.dataDir), timeout: 5000 },
      );
      assert.equal(JSON.parse(cli.stdout).files[0].state, 'invalid');
    }
    await assert.rejects(stat(f.config.dataDir), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('runtime tool contracts reject credentials, custom hashes and missing source paths', async () => {
  const f = await fixture();
  try {
    const tools = runtimeTools(f.config);
    const status = tools.find((tool) => tool.name === 'ai_modeling_runtime_status')!;
    const install = tools.find((tool) => tool.name === 'ai_modeling_runtime_install')!;
    assert.equal(status.readOnly, true);
    assert.equal(install.readOnly, false);
    assert.equal(status.schema.safeParse({ cookie: 'secret' }).success, false);
    assert.equal(
      install.schema.safeParse({ source_dir: f.source, sha256: 'caller-controlled' }).success,
      false,
    );
    assert.equal(install.schema.safeParse({}).success, false);
    assert.equal(install.schema.safeParse({ source_dir: '\0' }).success, false);
    assert.equal(object(await status.run({})).ready, false);
    await assert.rejects(stat(f.config.dataDir), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('CLI runtime status and MCP CLI bridge share local-only behavior without creating jobs', async () => {
  const f = await fixture();
  const env = offlineEnv(f.config.dataDir);
  const bridge = new CliBridge({ command: process.execPath, args: ['cli/main.ts'], env });
  try {
    const cli = await exec(process.execPath, ['cli/main.ts', 'runtime', 'status', '--json'], { env });
    const direct = JSON.parse(cli.stdout);
    assert.equal(direct.ready, false);
    const mcp = await bridge.call('ai_modeling_runtime_status', {});
    assert.deepEqual(object(mcp.result), direct);
    const invalid = await bridge.call('ai_modeling_runtime_install', { source_dir: f.source });
    assert.equal(object(invalid.error).code, 'FRONTEND_RUNTIME_MISSING');
    const wrongToolset = await bridge.call('ai_modeling_runtime_status', {}, undefined, 'full');
    assert.equal(object(wrongToolset.error).code, 'UNKNOWN_TOOL');
    await assert.rejects(stat(f.config.dataDir), { code: 'ENOENT' });
  } finally {
    bridge.close();
    await f.close();
  }
});
