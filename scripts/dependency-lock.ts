/** Project the reviewed lock into a portable production lock for an exported CLI package. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sourceProvenance } from './source-provenance.ts';

export const provenanceFields = [
  'source_commit',
  'source_dirty',
  'source_tracked',
  'source_files_sha256',
  'source_lock_sha256',
  'production_lock_sha256',
] as const;

export interface LockEntry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  license?: string;
  dev?: boolean;
  devOptional?: boolean;
  link?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}
export interface ProductionLock {
  name: string;
  version: string;
  lockfileVersion: 3;
  requires: true;
  packages: Record<string, LockEntry>;
}

function sorted(value: Record<string, string> = {}) {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

function validateSourceLock(metadata: LockEntry, input: unknown): ProductionLock {
  const lock = input as Partial<ProductionLock>;
  const root = lock?.packages?.[''];
  if (
    lock?.lockfileVersion !== 3 ||
    lock.name !== metadata.name ||
    lock.version !== metadata.version ||
    root?.name !== metadata.name ||
    root?.version !== metadata.version ||
    JSON.stringify(sorted(root?.dependencies)) !== JSON.stringify(sorted(metadata.dependencies)) ||
    JSON.stringify(sorted(root?.optionalDependencies)) !==
      JSON.stringify(sorted(metadata.optionalDependencies))
  )
    throw new Error('The dependency lock must match the package identity and production dependencies.');
  return lock as ProductionLock;
}

export function productionLock(metadata: LockEntry, input: unknown): ProductionLock {
  const lock = validateSourceLock(metadata, input);
  const packages: Record<string, LockEntry> = {};
  for (const [location, entry] of Object.entries(lock.packages!)) {
    if (entry.dev === true) continue;
    if (entry.link || (location && (!location.startsWith('node_modules/') || location.includes('..'))))
      throw new Error('Release dependencies must be registry packages, not linked or local paths.');
    if (location) {
      const resolved = new URL(entry.resolved ?? '');
      if (
        resolved.protocol !== 'https:' ||
        resolved.username ||
        resolved.password ||
        !entry.integrity ||
        !entry.version
      )
        throw new Error(`Dependency lacks a public HTTPS source, integrity or version: ${location}`);
    }
    const copy = { ...entry };
    delete copy.dev;
    delete copy.devOptional;
    delete copy.devDependencies;
    packages[location] = copy;
  }
  return {
    name: String(metadata.name),
    version: String(metadata.version),
    lockfileVersion: 3,
    requires: true,
    packages,
  };
}

/** Bundle portable runtime dependencies; npm selects exact optional/native packages at install time. */
export function publicationLock(input: ProductionLock): ProductionLock {
  const lock = structuredClone(input);
  const root = lock.packages['']!;
  const optional = { ...root.optionalDependencies };
  const dependencies = { ...root.dependencies };
  for (const [location, entry] of Object.entries(lock.packages))
    if (location && entry.peer === true && !externalRuntimeDependency(entry)) {
      const name = location.slice('node_modules/'.length);
      if (!name.includes('/node_modules/')) dependencies[name] = entry.version!;
    }
  if (Object.keys(dependencies).length) root.dependencies = Object.fromEntries(sorted(dependencies));
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location || !externalRuntimeDependency(entry)) continue;
    if (entry.optional !== true)
      throw new Error(`Platform-specific runtime dependency must be optional: ${location}`);
    const name = location.split('node_modules/').at(-1)!;
    if (optional[name] !== undefined && optional[name] !== entry.version)
      throw new Error(`Conflicting optional runtime versions: ${name}`);
    optional[name] = entry.version!;
  }
  if (Object.keys(optional).length) root.optionalDependencies = Object.fromEntries(sorted(optional));
  const bundled = Object.keys(root.dependencies ?? {}).sort();
  if (bundled.length) root.bundleDependencies = bundled;
  return lock;
}

export function externalRuntimeDependency(entry: LockEntry): boolean {
  return entry.optional === true || Boolean(entry.os || entry.cpu || entry.libc);
}

/** Every vendored path must belong to an exact, portable package in the reviewed lock. */
export function validateBundledPaths(lock: ProductionLock, files: string[]): void {
  const bundled = lock.packages['']?.bundleDependencies;
  for (const file of files) {
    if (!file.startsWith('node_modules/')) continue;
    if (!Array.isArray(bundled) || !bundled.length)
      throw new Error('Bundled dependency files require an explicit reviewed bundle.');
    const prefix = file.slice(0, file.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const parts = file.slice(prefix.length).split('/');
    const count = parts[0]?.startsWith('@') ? 2 : 1;
    if (parts.length <= count) throw new Error(`Invalid bundled package path: ${file}`);
    const location = prefix + parts.slice(0, count).join('/');
    const entry = lock.packages[location];
    if (!entry || externalRuntimeDependency(entry))
      throw new Error(`Unreviewed or platform-specific bundled dependency: ${location}`);
    if (file.endsWith('.node')) throw new Error(`Native binaries must use platform installation: ${file}`);
  }
}

export async function readProductionLock(root: string) {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as LockEntry;
  const bytes = await readFile(path.join(root, 'package-lock.json'));
  return {
    lock: publicationLock(productionLock(metadata, JSON.parse(bytes.toString('utf8')))),
    sourceLockSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function dependencyProvenance(root: string, npmCli = process.env.npm_execpath) {
  const { lock, sourceLockSha256 } = await readProductionLock(root);
  const source = await sourceProvenance(root);
  let npm: string | null = null;
  if (npmCli) npm = execFileSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8' }).trim();
  return {
    ...source,
    source_lock_sha256: sourceLockSha256,
    production_lock_sha256: createHash('sha256')
      .update(JSON.stringify(lock, null, 2) + '\n')
      .digest('hex'),
    toolchain: { node: process.version, npm, platform: process.platform, arch: process.arch },
    dependencies: Object.entries(lock.packages)
      .filter(([location]) => location)
      .map(([location, entry]) => ({
        path: location,
        version: entry.version,
        integrity: entry.integrity,
        license: entry.license ?? null,
        optional: entry.optional === true,
      })),
  };
}
