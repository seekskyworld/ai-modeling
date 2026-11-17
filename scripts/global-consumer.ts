/** Verify the documented global npm installation without using user configuration or credentials. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_NAME, VERSION } from '../version.ts';

type Environment = Record<string, string>;
type InstalledLock = {
  packages?: Record<string, { name?: string; version?: string; integrity?: string }>;
};

function execute(npm: string, args: string[], cwd: string, env: Environment) {
  return execFileSync(process.execPath, [npm, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function executable(shim: string, args: string[], directory: string, env: Environment) {
  if (process.platform !== 'win32')
    return execFileSync(shim, args, { cwd: directory, env, encoding: 'utf8', timeout: 30000 });
  assert.ok(args.every((arg) => /^--[a-z-]+$/.test(arg)));
  const result = spawnSync(
    env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', `""%AI_MODELING_SMOKE_BIN%" ${args.join(' ')}"`],
    {
      cwd: directory,
      env: { ...env, AI_MODELING_SMOKE_BIN: shim },
      encoding: 'utf8',
      timeout: 30000,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

export async function installGlobalConsumer(
  archive: string,
  directory: string,
  npm: string,
  env: Environment,
  offline = false,
) {
  const prefix = path.join(directory, 'global-prefix');
  execute(
    npm,
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      ...(offline ? ['--offline'] : []),
      archive,
    ],
    directory,
    env,
  );
  const modules = execute(npm, ['root', '--global', '--prefix', prefix], directory, env).trim();
  const installed = path.join(modules, ...PACKAGE_NAME.split('/'));
  const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.name, PACKAGE_NAME);
  assert.equal(metadata.version, VERSION);
  const entry = path.join(installed, 'dist/cli/main.js');
  const shim =
    process.platform === 'win32'
      ? path.join(prefix, 'ai-modeling.cmd')
      : path.join(prefix, 'bin/ai-modeling');
  if (process.platform !== 'win32') assert.equal(await realpath(shim), await realpath(entry));
  assert.equal(executable(shim, ['--version'], directory, env).trim(), VERSION);
  assert.match(executable(shim, ['--help'], directory, env), /ai-modeling/);
  return { prefix, modules, installed, entry, shim };
}

/** Exercise actual image processing; metadata-only startup cannot establish a working native runtime. */
export function probeGlobalNativeRuntime(entry: string, directory: string, env: Environment) {
  const script = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(process.argv[1]);
const sharp = (await import(pathToFileURL(require.resolve('sharp')).href)).default;
const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
const metadata = await sharp(image).metadata();
process.stdout.write(JSON.stringify({ png: image.subarray(0, 8).toString('hex'), width: metadata.width, height: metadata.height }));
`;
  const result = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '--eval', script, entry], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  assert.deepEqual(result, { png: '89504e470d0a1a0a', width: 1, height: 1 });
  return { sharp_encode_decode: true };
}

/** Exercise the installed JSON backend only in an explicit disposable directory, never the operator's store. */
export function probeGlobalCredentialStore(entry: string, directory: string, env: Environment) {
  const script = `
import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { JsonStore } = await import(new URL('../studio/auth/credentials.js', pathToFileURL(process.argv[1])));
const directory = path.join(process.argv[2], 'synthetic-json-credentials');
const options = { directory };
const store = new JsonStore('synthetic-global-consumer', options);
const session = { deviceId: 'synthetic-device', importedAt: '2026-01-01T00:00:00Z', accountRef: 'synthetic-account', bearer: 'synthetic-consumer-value' };
const fresh = () => new JsonStore('synthetic-global-consumer', options);
assert.equal(store.load(), undefined);
store.save(session);
assert.deepEqual(fresh().load(), session);
assert.equal(new JsonStore('synthetic-other-profile', options).load(), undefined);
let jsonFiles = 0;
async function inspect(root) {
  for (const name of await readdir(root)) {
    const file = path.join(root, name);
    const info = await lstat(file);
    assert.equal(info.isSymbolicLink(), false);
    if (info.isDirectory()) await inspect(file);
    else if (name.endsWith('.json')) {
      JSON.parse(await readFile(file, 'utf8'));
      if (process.platform !== 'win32') assert.equal(info.mode & 0o077, 0);
      jsonFiles++;
    }
  }
}
await inspect(directory);
assert.ok(jsonFiles > 0);
const renewed = { ...session, bearer: 'synthetic-renewed-value' };
assert.equal(store.saveIfUnchanged(session, renewed), true);
assert.equal(store.saveIfUnchanged(session, session), false);
assert.deepEqual(fresh().load(), renewed);
store.clear();
assert.equal(fresh().load(), undefined);
process.stdout.write(JSON.stringify({ backend: 'json', persistence_verified: true, compare_and_swap_verified: true, profile_isolation_verified: true, clear_verified: true, operator_credentials_accessed: false }));
`;
  const result = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '--eval', script, entry, directory], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  assert.deepEqual(result, {
    backend: 'json',
    persistence_verified: true,
    compare_and_swap_verified: true,
    profile_isolation_verified: true,
    clear_verified: true,
    operator_credentials_accessed: false,
  });
  return result;
}

async function packageFiles(root: string, relative = ''): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (item.name === 'node_modules') continue; // Child packages are checked separately.
    const file = path.posix.join(relative, item.name);
    if (item.isDirectory()) result.push(...(await packageFiles(root, file)));
    else if (item.isFile()) result.push(file);
    else throw new Error(`Installed dependency contains a non-regular entry: ${file}`);
  }
  return result.sort();
}

/** Global npm has no hidden lock. Compare its installed files with the separately integrity-verified local route. */
export async function compareInstalledPackageFiles(expected: string, actual: string): Promise<number> {
  for (const directory of [expected, actual]) {
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Installed package must be a real directory.');
  }
  const files = await packageFiles(expected);
  assert.deepEqual(await packageFiles(actual), files, 'Global installed dependency file inventory changed.');
  for (const file of files)
    assert.deepEqual(
      await readFile(path.join(actual, file)),
      await readFile(path.join(expected, file)),
      `Global installed dependency bytes changed: ${file}`,
    );
  return files.length;
}

async function installedPackages(
  modules: string,
): Promise<{ directory: string; name: string; version: string }[]> {
  const result: { directory: string; name: string; version: string }[] = [];
  const items = await readdir(modules, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const item of items) {
    if (item.name === '.bin' || item.name === '.package-lock.json') continue;
    assert.ok(
      item.isDirectory() && !item.isSymbolicLink(),
      'Installed package path must be a real directory.',
    );
    const directory = path.join(modules, item.name);
    if (item.name.startsWith('@')) {
      result.push(...(await installedPackages(directory)));
      continue;
    }
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    result.push({ directory, name: metadata.name, version: metadata.version });
    result.push(...(await installedPackages(path.join(directory, 'node_modules'))));
  }
  return result;
}

export async function verifyGlobalDependencies(
  global: { prefix: string; installed: string },
  localDirectory: string,
  npm: string,
  directory: string,
  env: Environment,
) {
  // Missing required dependencies must fail before byte comparisons; optional platform absence is allowed by npm.
  execute(npm, ['ls', '--global', '--prefix', global.prefix, '--all', '--json'], directory, env);
  const lock = JSON.parse(
    await readFile(path.join(localDirectory, 'node_modules/.package-lock.json'), 'utf8'),
  ) as InstalledLock;
  const references = new Map<string, string>();
  for (const [location, item] of Object.entries(lock.packages ?? {})) {
    const name = item.name ?? location.split('node_modules/').at(-1)!;
    if (name === PACKAGE_NAME) continue;
    assert.ok(
      location.startsWith('node_modules/') &&
        !location.split('/').includes('..') &&
        item.version &&
        item.integrity,
    );
    references.set(`${name}@${item.version}`, path.join(localDirectory, location));
  }
  const actual = await installedPackages(path.join(global.installed, 'node_modules'));
  const identities = new Set<string>();
  let files = 0;
  for (const item of actual) {
    const id = `${item.name}@${item.version}`;
    const expected = references.get(id);
    assert.ok(expected, `Global installation contains an unreviewed dependency: ${id}`);
    identities.add(id);
    files += await compareInstalledPackageFiles(expected, item.directory);
  }
  assert.deepEqual(
    [...identities].sort(),
    [...references.keys()].sort(),
    'Global dependency set differs from the verified local installation.',
  );
  return {
    comparison: 'name-version-reviewed-local-bytes' as const,
    matches: true,
    packages_verified: identities.size,
    files_verified: files,
  };
}
