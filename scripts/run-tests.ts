/** Run offline tests in disposable state; never inherit an operator's account or data directories. */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offlineTestEnvironment } from './test-environment.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-offline-tests-'));
const hook = new URL('../tests/isolation-hook.ts', import.meta.url).href;
const env = offlineTestEnvironment(process.env, directory, hook);
const selected = process.argv.slice(2);
const files = selected.some((arg) => !arg.startsWith('-') && /\.(?:test\.ts|test\.js)$/.test(arg))
  ? []
  : (await readdir(path.join(root, 'tests')))
      .filter((name) => name.endsWith('.test.ts'))
      .sort()
      .map((name) => `tests/${name}`);
try {
  const child = spawn(process.execPath, ['--test', ...selected, ...files], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
