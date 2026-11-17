/** Shared validation of npm's actual package inventory and distribution source files. */
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { checkDocumentation } from './documentation-check.ts';
import { PACKAGE_NAME } from '../version.ts';
import { productionLock, validateBundledPaths } from './dependency-lock.ts';

export const requiredPackageFiles = [
  'package.json',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
  'README.zh-CN.md',
  'assets/branding/logo.png',
  'assets/branding/publicity_EN.png',
  'assets/branding/publicity_CN.png',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'SUPPORT.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  'ROADMAP.md',
  '.env.example',
  'examples/README.md',
  'examples/mcp.json',
  'examples/mcp-installed.json',
  'examples/mcp-codex.toml',
  'examples/mcp-vscode.json',
  'examples/mcp-opencode.json',
  'examples/batch.yaml',
  'docs/README.md',
  'docs/usage.md',
  'docs/commands.md',
  'docs/compatibility.md',
  'docs/development.md',
  'skills/ai-modeling/SKILL.md',
  'skills/ai-modeling/references/usage.md',
  'skills/ai-modeling/references/pipelines.md',
  'dist/cli/main.js',
  'dist/version.js',
  'dist/studio/api/reviewed-prices.json',
  'dist/mcp/main.js',
  'dist/cli/local/model-worker.py',
];

export interface PackResult {
  name: string;
  version: string;
  filename?: string;
  files: { path: string; size: number; mode?: number }[];
}

export interface PackageMetadata {
  name: string;
  version: string;
  license: string;
  private: boolean;
  bin: Record<string, string>;
}

export function runNpm(root: string, args: string[], npmCli = process.env.npm_execpath): string {
  if (!npmCli) throw new Error('Run this command through npm run so npm_execpath is available.');
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function parsePackResult(output: string): PackResult {
  const entries = JSON.parse(output) as PackResult[];
  if (!Array.isArray(entries) || entries.length !== 1 || !Array.isArray(entries[0]?.files))
    throw new Error('Invalid npm pack inventory.');
  const result = entries[0]!;
  if (typeof result.name !== 'string' || typeof result.version !== 'string')
    throw new Error('Invalid npm package identity.');
  for (const entry of result.files) {
    if (typeof entry.path !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new Error('Invalid npm file inventory.');
  }
  return result;
}

export function packageInventory(root: string, npmCli = process.env.npm_execpath): PackResult {
  return parsePackResult(runNpm(root, ['pack', '--dry-run', '--ignore-scripts', '--json'], npmCli));
}

export function assertDistributionPath(file: string): void {
  const parts = file.split('/');
  if (
    !file ||
    /[\\:<>"|?*]/.test(file) ||
    [...file].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)) ||
    parts.some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
  )
    throw new Error(`Unsafe distribution path: ${file}`);
}

export function assertPublicFile(file: string, bundled = false): void {
  assertDistributionPath(file);
  const parts = file.split('/');
  const forbidden = new Set([
    '.ds_store',
    '.git',
    '.golutra',
    '.codex',
    '.ai-modeling',
    '.ai-modeling-auth',
    '.tripo',
    '.data',
    '.state',
    '.auth',
    '__pycache__',
    'node_modules',
    'auth-state',
    'mcp.local.json',
  ]);
  if (
    parts.some((part) => forbidden.has(part.toLowerCase()) && !(bundled && part === 'node_modules')) ||
    (!bundled && /\.(?:tgz|zip)$/i.test(file)) ||
    /\.(?:har|log|sqlite|db|pem|key|p12|pfx|pyc|pyo)(?:-wal|-shm|-journal)?$/i.test(file) ||
    /\.state\.json(?:\.lock)?(?:\/|$)/i.test(file) ||
    (file !== '.env.example' && parts.some((part) => part.toLowerCase().startsWith('.env')))
  )
    throw new Error(`Private or generated distribution file: ${file}`);
}

export function assertPublicContent(file: string, bytes: Uint8Array): void {
  const content = Buffer.from(bytes).toString('utf8');
  const patterns = [
    /\/Users\/[A-Za-z0-9._-]+\//,
    /\/private\/var\/folders\//,
    /[A-Za-z]:\\Users\\[^\\\s]+\\/,
    /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
    /[?&](?:X-Amz-Signature|X-Goog-Signature)=[a-f0-9]{32,}/i,
  ];
  if (patterns.some((pattern) => pattern.test(content))) throw new Error(`${file}: private data marker`);
}

/** Reject symlinks in every component, then read the same regular file that was checked. */
export async function readDistributionFile(root: string, file: string, bundled = false): Promise<Buffer> {
  assertPublicFile(file, bundled);
  const parts = file.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(`Distribution parent must be a real directory: ${file}`);
  }
  const filename = path.join(root, ...parts);
  const entry = await lstat(filename);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error(`Distribution input must be a regular file: ${file}`);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino)
      throw new Error(`Distribution input changed while opening: ${file}`);
    const bytes = await handle.readFile();
    const final = await handle.stat();
    if (opened.size !== final.size || opened.mtimeMs !== final.mtimeMs || bytes.length !== final.size)
      throw new Error(`Distribution input changed while reading: ${file}`);
    if (!bundled) assertPublicContent(file, bytes);
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readPackageMetadata(root: string): Promise<PackageMetadata> {
  const metadata = JSON.parse(
    (await readDistributionFile(root, 'package.json')).toString('utf8'),
  ) as PackageMetadata;
  if (metadata.name !== PACKAGE_NAME || metadata.license !== 'Apache-2.0')
    throw new Error('The package must preserve ai-modeling and the selected Apache-2.0 license.');
  if (
    metadata.private === true ||
    !metadata.bin ||
    typeof metadata.bin !== 'object' ||
    Array.isArray(metadata.bin) ||
    Object.keys(metadata.bin).length !== 1 ||
    metadata.bin['ai-modeling'] !== 'dist/cli/main.js'
  )
    throw new Error('The package must be publishable with ai-modeling as its only CLI entrypoint.');
  if (
    typeof metadata.version !== 'string' ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(
      metadata.version,
    )
  )
    throw new Error('Package version must be a safe semantic version.');
  return metadata;
}

export function assertPackageFile(file: string): void {
  assertPublicFile(file, file.startsWith('node_modules/'));
  if (
    file !== 'npm-shrinkwrap.json' &&
    !requiredPackageFiles.includes(file) &&
    !/^(?:dist|docs|examples|skills\/ai-modeling|node_modules)\//.test(file)
  )
    throw new Error(`Unexpected package file: ${file}`);
}

export function assertUniquePaths(files: string[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    assertDistributionPath(file);
    const normalized = file.normalize('NFC').toLowerCase();
    if (seen.has(normalized)) throw new Error(`Conflicting distribution paths: ${file}`);
    seen.add(normalized);
  }
}

export async function validatePackageInventory(root: string, packed: PackResult) {
  const files = packed.files.map((entry) => entry.path);
  assertUniquePaths(files);
  const inventory = new Set(files);
  const errors = requiredPackageFiles
    .filter((file) => !inventory.has(file))
    .map((file) => `Missing package file: ${file}`);
  for (const file of files) assertPackageFile(file);
  const metadata = await readPackageMetadata(root);
  if (metadata.name !== packed.name || metadata.version !== packed.version)
    errors.push('Package identity mismatch.');
  for (const entry of packed.files) {
    const bytes = await readDistributionFile(root, entry.path, entry.path.startsWith('node_modules/'));
    if (bytes.length !== entry.size) errors.push(`${entry.path}: npm inventory size changed`);
  }
  if (inventory.has('npm-shrinkwrap.json')) {
    const sourceMetadata = JSON.parse((await readDistributionFile(root, 'package.json')).toString('utf8'));
    const shrinkwrap = JSON.parse((await readDistributionFile(root, 'npm-shrinkwrap.json')).toString('utf8'));
    const projected = productionLock(sourceMetadata, shrinkwrap);
    validateBundledPaths(projected, files);
    if (JSON.stringify(projected) !== JSON.stringify(shrinkwrap))
      errors.push('Bundled shrinkwrap must contain only the portable production lock.');
  }
  if (files.some((file) => file.startsWith('node_modules/')) && !inventory.has('npm-shrinkwrap.json'))
    errors.push('Bundled runtime dependencies require the reviewed production lock.');
  const docs = await checkDocumentation(
    root,
    files.filter((file) => !file.startsWith('node_modules/')),
  );
  errors.push(...docs.errors);
  if (errors.length) throw new Error(errors.join('\n'));
  return { name: packed.name, version: packed.version, files: files.length, documentation: docs };
}
