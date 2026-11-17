import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  productionLock,
  publicationLock,
  validateBundledPaths,
  unbundledRuntimeLocation,
} from '../scripts/dependency-lock.ts';
import { archiveEntries, snapshotArchive } from '../scripts/archive-input.ts';
import { sourceProvenance } from '../scripts/source-provenance.ts';
import {
  assessReadiness,
  parseReleaseArgs,
  privateContactUrl,
  readSmokeReports,
  repositoryUrl,
  verifyDistribution,
} from '../scripts/release.ts';
import { VERSION } from '../version.ts';
import { reviewedPrices } from '../studio/api/reviewed-prices.ts';

const provenance = {
  source_commit: 'a'.repeat(40),
  source_dirty: false,
  source_tracked: true,
  source_files_sha256: '1'.repeat(64),
  source_lock_sha256: 'b'.repeat(64),
  production_lock_sha256: 'c'.repeat(64),
  toolchain: { node: 'v24.0.0', npm: '11.0.0', platform: process.platform, arch: process.arch },
  dependencies: [],
};
const nowMs = Date.parse('2026-01-01T00:00:00Z');
const pricing = {
  ...reviewedPrices,
  reviewed_at: '2025-12-31T00:00:00Z',
  expires_at: '2026-01-03T00:00:00Z',
};
const input = {
  version: '0.1.0',
  repository: 'https://github.com/maintainer/ai-modeling',
  securityContact: 'https://github.com/maintainer/ai-modeling/security/advisories/new',
  provenance,
  pricing,
  minPricingHours: 24,
  nowMs,
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('production lock retains all platform optional packages, removes dev-only dependencies and rejects drift', () => {
  const metadata = {
    name: '@seekskyworld/ai-modeling',
    version: '0.1.0',
    dependencies: { runtime: '1.0.0' },
    devDependencies: { test: '1.0.0' },
  };
  const entry = {
    version: '1.0.0',
    resolved: 'https://registry.npmjs.org/runtime/-/runtime-1.0.0.tgz',
    integrity: 'sha512-fixture',
  };
  const source = {
    name: metadata.name,
    version: metadata.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': metadata,
      'node_modules/runtime': {
        ...entry,
        optionalDependencies: { 'native-linux': '1.0.0', 'native-win32': '1.0.0' },
      },
      'node_modules/native-linux': { ...entry, optional: true, os: ['linux'] },
      'node_modules/native-win32': { ...entry, optional: true, os: ['win32'] },
      'node_modules/test': { ...entry, dev: true },
    },
  };
  const lock = productionLock(metadata, source);
  assert.deepEqual(Object.keys(lock.packages), [
    '',
    'node_modules/runtime',
    'node_modules/native-linux',
    'node_modules/native-win32',
  ]);
  assert.equal(lock.packages['']!.devDependencies, undefined);
  assert.deepEqual(source.packages[''].devDependencies, { test: '1.0.0' });
  assert.throws(
    () => productionLock({ ...metadata, dependencies: { runtime: '2.0.0' } }, source),
    /must match/,
  );
  assert.throws(
    () =>
      productionLock(metadata, {
        ...source,
        packages: { ...source.packages, 'node_modules/runtime': { ...entry, link: true } },
      }),
    /linked or local/,
  );
  assert.throws(
    () =>
      productionLock(metadata, {
        ...source,
        packages: {
          ...source.packages,
          'node_modules/runtime': {
            ...entry,
            resolved: 'https://user:secret@registry.npmjs.org/runtime.tgz',
          },
        },
      }),
    /HTTPS/,
  );
});

test('release readiness distinguishes source checks, three-platform evidence and stale pricing without refreshing it', () => {
  assert.equal(assessReadiness(input).ready, true);
  assert.equal(assessReadiness(input).scope, 'source');
  const candidate = {
    archive_sha256: 'd'.repeat(64),
    verified_platforms: ['linux', 'darwin'],
    consumer_verified_platforms: ['linux', 'darwin', 'win32'],
    consumer_locked_platforms: ['linux', 'darwin', 'win32'],
  };
  assert.equal(assessReadiness({ ...input, candidate }).ready, false);
  assert.equal(
    assessReadiness({
      ...input,
      candidate: { ...candidate, verified_platforms: ['linux', 'darwin', 'win32'] },
    }).ready,
    true,
  );
  const missingConsumer = assessReadiness({
    ...input,
    candidate: {
      ...candidate,
      verified_platforms: ['linux', 'darwin', 'win32'],
      consumer_verified_platforms: [],
    },
  });
  assert.equal(missingConsumer.ready, false);
  assert.equal(missingConsumer.blockers.filter((item) => item.code === 'CONSUMER_SMOKE_MISSING').length, 3);
  const drift = assessReadiness({
    ...input,
    candidate: {
      ...candidate,
      verified_platforms: ['linux', 'darwin', 'win32'],
      consumer_locked_platforms: ['linux', 'win32'],
    },
  });
  assert.equal(drift.ready, false);
  assert.ok(drift.blockers.some((item) => item.code === 'CONSUMER_DEPENDENCY_DRIFT'));
  assert.deepEqual(drift.consumer_dependency_drift, ['darwin']);
  const short = assessReadiness({ ...input, pricing: { ...pricing, expires_at: '2026-01-01T23:59:59Z' } });
  assert.equal(short.blockers[0]?.code, 'PRICING_REFRESH_REQUIRED');
  assert.equal(short.pricing.expires_at, '2026-01-01T23:59:59Z');
  assert.equal(short.pricing.evidence_verified_online, false);
  const absent = assessReadiness({
    ...input,
    repository: undefined,
    securityContact: undefined,
    provenance: { ...provenance, source_commit: null, source_dirty: null },
  });
  assert.deepEqual(
    absent.blockers.map((item) => item.code),
    ['REPOSITORY_UNCONFIGURED', 'SECURITY_CONTACT_UNCONFIGURED', 'SOURCE_COMMIT_UNKNOWN', 'SOURCE_NOT_CLEAN'],
  );
});

test('readiness accepts confirmed metadata only and rejects ambiguous command inputs', () => {
  assert.equal(repositoryUrl('git+https://github.com/maintainer/ai-modeling.git'), input.repository);
  assert.equal(repositoryUrl('https://github.com/owner/repo'), undefined);
  assert.equal(repositoryUrl('https://user:secret@github.com/maintainer/ai-modeling'), undefined);
  assert.equal(privateContactUrl('mailto:security@example.com'), undefined);
  assert.equal(privateContactUrl('mailto:security@maintainer.dev?body=private'), undefined);
  assert.equal(privateContactUrl(input.securityContact), input.securityContact);
  assert.equal(parseReleaseArgs(['check', '--min-pricing-hours=48', '--require-ready'])?.minPricingHours, 48);
  for (const args of [
    ['prepare'],
    ['check', '--out', 'x'],
    ['check', '--min-pricing-hours', '0'],
    ['check', '--repository=x', '--repository=y'],
    ['check', '--require-ready', '--require-ready'],
  ])
    assert.throws(() => parseReleaseArgs(args));
});

test('candidate verification rejects altered archives, source drift and smoke reports for another archive', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = ['ai-modeling-skill-0.1.0.zip', 'ai-modeling-0.1.0.tgz', 'mcp.json', 'INSTALL.md'];
  const artifacts = names.map((name) => ({ path: name, size: name.length, sha256: hash(Buffer.from(name)) }));
  for (const name of names) await writeFile(path.join(directory, name), name);
  await writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      schema_version: 2,
      name: '@seekskyworld/ai-modeling',
      version: '0.1.0',
      target: 'all',
      provenance,
      artifacts,
    }),
  );
  const sums = [];
  for (const name of [...names, 'manifest.json'])
    sums.push(`${hash(await readFile(path.join(directory, name)))}  ${name}`);
  await writeFile(path.join(directory, 'SHA256SUMS'), sums.sort().join('\n') + '\n');
  const verified = await verifyDistribution(directory, '0.1.0', provenance);
  await assert.rejects(
    verifyDistribution(directory, '0.1.0', { ...provenance, source_commit: 'e'.repeat(40) }),
    /provenance/,
  );
  await writeFile(path.join(directory, 'ai-modeling-0.1.0.tgz'), 'altered');
  await assert.rejects(verifyDistribution(directory, '0.1.0', provenance), /SHA256SUMS/);
  const smokeDir = await mkdtemp(path.join(tmpdir(), 'ai-modeling-smoke-report-test-'));
  t.after(() => rm(smokeDir, { recursive: true, force: true }));
  const smoke = {
    schema_version: 1,
    install_method: 'extracted-tgz-npm-ci-link',
    name: '@seekskyworld/ai-modeling',
    version: '0.1.0',
    platform: 'linux',
    archive_sha256: verified.archive_sha256,
    live_services: false,
    checks: [
      'installed-bin',
      'version',
      'help',
      'cli-guides',
      'mcp-initialize',
      'mcp-guides',
      'production-lock',
      'static-tool-discovery',
      'focused-command-guides',
      'no-runtime-state',
    ],
  };
  await writeFile(path.join(smokeDir, 'smoke-linux.json'), JSON.stringify(smoke));
  assert.deepEqual((await readSmokeReports(smokeDir, '0.1.0', verified.archive_sha256)).verified, ['linux']);
  await assert.rejects(readSmokeReports(smokeDir, '0.1.0', 'f'.repeat(64)), /this archive/);
});

test('consumer evidence preserves dependency drift and rejects false success, duplicate routes and foreign archives', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-consumer-report-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archiveSha256 = 'a'.repeat(64);
  const productionLockSha256 = 'b'.repeat(64);
  const report = {
    schema_version: 1,
    install_method: 'npm-install-tgz-and-npx-offline',
    name: '@seekskyworld/ai-modeling',
    version: '0.1.0',
    platform: 'darwin',
    archive_sha256: archiveSha256,
    live_services: false,
    functional_passed: true,
    checks: [
      'installed-bin',
      'version',
      'help',
      'npm-exec-offline',
      'npx-offline',
      'mcp-initialize',
      'static-tool-discovery',
      'skill-install',
      'skill-status',
      'skill-uninstall',
      'no-runtime-state',
      'dependency-inspection',
      'bundled-file-integrity',
      'global-install',
      'global-bin',
      'global-native-runtime',
      'global-mcp',
      'global-skill-management',
      'global-dependency-bytes',
    ],
    global_installation: {
      functional_passed: true,
      native_runtime: { sharp_encode_decode: true, keyring_module_loaded: true, credential_accessed: false },
      dependency_lock: {
        comparison: 'name-version-reviewed-local-bytes',
        matches: true,
        packages_verified: 4,
        files_verified: 8,
      },
      bundled_files_verified: 8,
    },
    dependency_lock: {
      matches: false,
      comparison: 'name-version-integrity',
      production_lock_sha256: productionLockSha256,
      routes: [
        {
          route: 'npm-install',
          matches: true,
          installed_packages: 4,
          mismatches: [],
          bundled_files_verified: 8,
        },
        {
          route: 'npx-cache',
          matches: false,
          installed_packages: 4,
          bundled_files_verified: 8,
          mismatches: [{ kind: 'version', name: 'synthetic-dependency', expected: '1.0.0', actual: '1.1.0' }],
        },
      ],
    },
  };
  const filename = path.join(directory, 'consumer-darwin.json');
  const verify = () => readSmokeReports(directory, '0.1.0', archiveSha256, productionLockSha256);
  await writeFile(filename, JSON.stringify(report));
  const accepted = await verify();
  assert.deepEqual(accepted.consumerVerified, ['darwin']);
  assert.deepEqual(accepted.consumerLocked, []);
  assert.deepEqual(accepted.verified, []);
  for (const changed of [
    { ...report, functional_passed: false },
    { ...report, archive_sha256: 'c'.repeat(64) },
    { ...report, checks: report.checks.filter((item) => item !== 'skill-uninstall') },
    { ...report, global_installation: undefined },
    { ...report, checks: report.checks.filter((item) => item !== 'global-native-runtime') },
    ...['sharp_encode_decode', 'keyring_module_loaded'].map((check) => ({
      ...report,
      global_installation: {
        ...report.global_installation,
        native_runtime: { ...report.global_installation.native_runtime, [check]: false },
      },
    })),
    {
      ...report,
      global_installation: {
        ...report.global_installation,
        native_runtime: { ...report.global_installation.native_runtime, credential_accessed: true },
      },
    },
    { ...report, dependency_lock: { ...report.dependency_lock, matches: true } },
    { ...report, dependency_lock: { ...report.dependency_lock, production_lock_sha256: 'd'.repeat(64) } },
    {
      ...report,
      dependency_lock: {
        ...report.dependency_lock,
        routes: [report.dependency_lock.routes[0], report.dependency_lock.routes[0]],
      },
    },
  ]) {
    await writeFile(filename, JSON.stringify(changed));
    await assert.rejects(verify(), /Consumer report/);
  }
});

test('installation snapshots bind the hashed bytes even if the supplied path is replaced, and reject symlinks', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-archive-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, 'input.tgz');
  const snapshotDir = path.join(directory, 'snapshot');
  await mkdir(snapshotDir);
  await writeFile(archive, 'reviewed bytes');
  const snapshot = await snapshotArchive(archive, snapshotDir);
  await rename(archive, path.join(directory, 'original.tgz'));
  await writeFile(archive, 'replacement bytes');
  assert.equal(await readFile(snapshot.filename, 'utf8'), 'reviewed bytes');
  assert.equal(snapshot.sha256, hash(Buffer.from('reviewed bytes')));
  await symlink(archive, path.join(directory, 'link.tgz'));
  await assert.rejects(snapshotArchive(path.join(directory, 'link.tgz'), snapshotDir), /non-symlink/);
});

function tarFixture(filename: string, type = '0') {
  const header = Buffer.alloc(512);
  header.write(filename);
  header.write('0000644\0', 100);
  header.write('00000000002\0', 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  const body = Buffer.alloc(512);
  body.write('{}');
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
}

test('archive extraction rejects traversal and link entries before writing files', () => {
  assert.equal(archiveEntries(tarFixture('package/package.json'))[0]?.path, 'package.json');
  assert.throws(() => archiveEntries(tarFixture('package/../package.json')), /Unsafe distribution path/);
  assert.throws(() => archiveEntries(tarFixture('/package/package.json')), /inside package/);
  assert.throws(() => archiveEntries(tarFixture('package/package.json', '2')), /links and special files/);
});

test('source provenance rejects an ignored child of another repository and ignored source in its own root', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-git-provenance-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const empty = path.join(directory, 'empty');
  await writeFile(empty, '');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty };
  const git = (root: string, args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=test@invalid.local', ...args], {
      cwd: root,
      env,
      stdio: 'ignore',
    });
  const parent = path.join(directory, 'parent');
  await mkdir(parent);
  git(parent, ['init', '--quiet', '--template=']);
  await writeFile(path.join(parent, '.gitignore'), 'child/\ncli/\n');
  await writeFile(path.join(parent, 'README.md'), '# Synthetic\n');
  git(parent, ['add', '.gitignore', 'README.md']);
  git(parent, ['commit', '--quiet', '-m', 'synthetic fixture']);
  const child = path.join(parent, 'child');
  await mkdir(child);
  await writeFile(path.join(child, 'package.json'), '{}');
  const ignored = await sourceProvenance(child);
  assert.equal(ignored.source_commit, null);
  assert.equal(ignored.source_dirty, null);
  assert.equal(ignored.source_tracked, false);
  assert.equal((await sourceProvenance(parent)).source_tracked, true);
  await mkdir(path.join(parent, 'cli'));
  await writeFile(path.join(parent, 'cli/main.ts'), '// untracked ignored source\n');
  const uncovered = await sourceProvenance(parent);
  assert.equal(uncovered.source_dirty, false);
  assert.equal(uncovered.source_tracked, false);
});

test('publication bundles portable code and selects exact optional binaries on the consumer platform', () => {
  const input = {
    name: '@seekskyworld/ai-modeling',
    version: VERSION,
    lockfileVersion: 3 as const,
    requires: true as const,
    packages: {
      '': { name: '@seekskyworld/ai-modeling', version: VERSION, dependencies: { runtime: '1.0.0' } },
      'node_modules/runtime': { version: '1.0.0' },
      'node_modules/peer-runtime': { version: '3.0.0', peer: true },
      'node_modules/platform-linux': { version: '2.0.0', optional: true, os: ['linux'] },
    },
  };
  const lock = publicationLock(input);
  assert.deepEqual(lock.packages['']!.bundleDependencies, ['peer-runtime', 'runtime']);
  assert.equal(lock.packages['']!.dependencies!['peer-runtime'], '3.0.0');
  assert.deepEqual(lock.packages['']!.optionalDependencies, { 'platform-linux': '2.0.0' });
  assert.equal('optionalDependencies' in input.packages[''], false);
  validateBundledPaths(lock, ['node_modules/runtime/index.js']);
  assert.throws(() => validateBundledPaths(lock, ['node_modules/unreviewed/index.js']), /Unreviewed/);
  assert.throws(
    () => validateBundledPaths(lock, ['node_modules/platform-linux/module.node']),
    /platform-specific/,
  );
  assert.throws(() => validateBundledPaths(lock, ['node_modules/runtime/module.node']), /Native binaries/);
});

test('native runtime loaders stay outside bundles so global npm installs their platform dependencies', () => {
  const lock = publicationLock({
    name: '@seekskyworld/ai-modeling',
    version: VERSION,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: '@seekskyworld/ai-modeling', version: VERSION, dependencies: { loader: '1.0.0' } },
      'node_modules/loader': {
        version: '1.0.0',
        dependencies: { helper: '^2.0.0' },
        optionalDependencies: { native: '3.0.0' },
      },
      'node_modules/helper': { version: '2.1.0' },
      'node_modules/native': { version: '3.0.0', optional: true, os: ['darwin'] },
    },
  });
  assert.equal(lock.packages['']!.dependencies!.helper, '2.1.0');
  assert.deepEqual(lock.packages['']!.bundleDependencies, ['helper']);
  assert.equal(unbundledRuntimeLocation(lock, 'node_modules/loader'), true);
  assert.equal(unbundledRuntimeLocation(lock, 'node_modules/native'), true);
  assert.equal(unbundledRuntimeLocation(lock, 'node_modules/helper'), false);
  assert.throws(() => validateBundledPaths(lock, ['node_modules/loader/index.js']), /bundled dependency/);
  validateBundledPaths(lock, ['node_modules/helper/index.js']);
});
