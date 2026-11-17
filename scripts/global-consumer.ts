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

/** Exercise actual image processing and load the OS module without opening any credential entry. */
export function probeGlobalNativeRuntime(entry: string, directory: string, env: Environment) {
  const script = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(process.argv[1]);
const sharp = (await import(pathToFileURL(require.resolve('sharp')).href)).default;
const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
const metadata = await sharp(image).metadata();
const keyring = require('@napi-rs/keyring');
process.stdout.write(JSON.stringify({ png: image.subarray(0, 8).toString('hex'), width: metadata.width, height: metadata.height, keyring_loaded: typeof keyring.Entry === 'function' }));
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
  assert.deepEqual(result, { png: '89504e470d0a1a0a', width: 1, height: 1, keyring_loaded: true });
  return { sharp_encode_decode: true, keyring_module_loaded: true, credential_accessed: false };
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
