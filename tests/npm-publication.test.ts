import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  parseNpmPublicationArgs,
  runNpmPublication,
  type NpmPublicationOptions,
} from '../scripts/npm-publication.ts';
import { preparePublicationIdentity } from '../scripts/npm-publication-candidate.ts';
import {
  GitHubPublicationStore,
  verifyPublicArchive,
  type PublicationRelease,
  type PublicationStore,
} from '../scripts/npm-publication-remote.ts';
import {
  digest,
  identityDigest,
  jsonBytes,
  makeRecord,
  parseRecord,
  recordName,
  type PublicationContext,
  type PublicationIdentity,
} from '../scripts/npm-publication-state.ts';

const context = { repository: 'maintainer/ai-modeling', tag: 'v0.1.3', source: 'a'.repeat(40) };
const packageName = '@seekskyworld/ai-modeling';
const now = Date.parse('2026-11-17T00:00:00Z');
const platforms = ['linux', 'darwin', 'win32'];
const provenance = {
  source_commit: context.source,
  source_dirty: false,
  source_tracked: true,
  source_files_sha256: '1'.repeat(64),
  source_lock_sha256: '2'.repeat(64),
  production_lock_sha256: '3'.repeat(64),
};

class MemoryStore implements PublicationStore {
  exists = false;
  assets = new Map<string, Buffer>();
  writes: string[] = [];
  failAfterPut?: string;
  failBeforePut?: string;
  hideRead?: string;
  async assertTag(value: PublicationContext) {
    assert.deepEqual({ repository: value.repository, tag: value.tag, source: value.source }, context);
  }
  async load() {
    return this.exists
      ? {
          id: 10,
          tag: context.tag,
          draft: true,
          assets: [...this.assets].map(([name, bytes], index) => ({
            id: index + 1,
            name,
            size: bytes.length,
          })),
        }
      : undefined;
  }
  async create() {
    if (this.exists) throw new Error('Release already exists.');
    this.exists = true;
    this.writes.push('create-release');
    return (await this.load())!;
  }
  async read(_release: PublicationRelease, name: string, maximumBytes: number) {
    if (this.hideRead === name) return;
    const bytes = this.assets.get(name);
    if (bytes && bytes.length > maximumBytes) throw new Error('oversized asset');
    return bytes && Buffer.from(bytes);
  }
  async put(_release: PublicationRelease, name: string, bytes: Buffer) {
    if (this.failBeforePut === name) throw new Error('write rejected');
    if (this.assets.has(name)) throw new Error('immutable asset already exists');
    this.assets.set(name, Buffer.from(bytes));
    this.writes.push(name);
    if (this.failAfterPut === name) throw new Error('response lost after durable write');
  }
}

function tgz() {
  const bytes = jsonBytes({ name: packageName, version: '0.1.3' });
  const header = Buffer.alloc(512);
  header.write('package/package.json');
  header.write('0000644\0', 100);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156);
  header.write('0', 156);
  header.write(
    header
      .reduce((sum, value) => sum + value, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
  );
  const body = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
  bytes.copy(body);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
}

function smoke(platform: string, archiveSha256: string, consumer: boolean) {
  const common = {
    schema_version: 1,
    name: packageName,
    version: '0.1.3',
    platform,
    archive_sha256: archiveSha256,
    live_services: false,
    install_method: consumer ? 'npm-install-tgz-and-npx-offline' : 'extracted-tgz-npm-ci-link',
    checks: consumer
      ? [
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
          'global-json-credentials',
          'global-mcp',
          'global-skill-management',
          'global-dependency-bytes',
        ]
      : [
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
  return consumer
    ? {
        ...common,
        functional_passed: true,
        dependency_lock: {
          matches: true,
          comparison: 'name-version-integrity',
          production_lock_sha256: provenance.production_lock_sha256,
          routes: ['npm-install', 'npx-cache'].map((route) => ({
            route,
            matches: true,
            installed_packages: 4,
            bundled_files_verified: 8,
            mismatches: [],
          })),
        },
        global_installation: {
          functional_passed: true,
          native_runtime: { sharp_encode_decode: true },
          bundled_files_verified: 8,
          credential_store: {
            backend: 'json',
            persistence_verified: true,
            compare_and_swap_verified: true,
            profile_isolation_verified: true,
            clear_verified: true,
            operator_credentials_accessed: false,
          },
          dependency_lock: {
            comparison: 'name-version-reviewed-local-bytes',
            matches: true,
            packages_verified: 4,
            files_verified: 8,
          },
        },
      }
    : common;
}

async function sums(directory: string, files: Map<string, Buffer>) {
  files.set(
    'SHA256SUMS',
    Buffer.from(
      [...files]
        .filter(([name]) => name !== 'SHA256SUMS')
        .map(([name, bytes]) => `${digest(bytes)}  ${name}`)
        .sort()
        .join('\n') + '\n',
    ),
  );
  for (const [name, bytes] of files) await writeFile(path.join(directory, name), bytes);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-publication-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const distribution = path.join(directory, 'distribution');
  const candidate = path.join(directory, 'candidate');
  await mkdir(distribution);
  await mkdir(candidate);
  const archive = tgz();
  const dist = new Map<string, Buffer>([
    ['ai-modeling-0.1.3.tgz', archive],
    ['ai-modeling-skill-0.1.3.zip', Buffer.from('synthetic ZIP')],
    ['mcp.json', jsonBytes({})],
    ['INSTALL.md', Buffer.from('Synthetic install fixture\n')],
  ]);
  dist.set(
    'manifest.json',
    jsonBytes({
      schema_version: 2,
      name: packageName,
      version: '0.1.3',
      target: 'all',
      provenance,
      artifacts: [...dist].map(([name, bytes]) => ({
        path: name,
        size: bytes.length,
        sha256: digest(bytes),
      })),
    }),
  );
  await sums(distribution, dist);
  const readiness = {
    schema_version: 1,
    name: packageName,
    version: '0.1.3',
    scope: 'candidate',
    ready: true,
    repository: `https://github.com/${context.repository}`,
    provenance,
    checked_at: new Date(now).toISOString(),
    blockers: [],
    consumer_dependency_drift: [],
    pricing: { expires_at: new Date(now + 72 * 3600000).toISOString(), minimum_remaining_hours: 24 },
    installation: {
      archive_sha256: digest(archive),
      verified_platforms: platforms,
      consumer_verified_platforms: platforms,
      consumer_locked_platforms: platforms,
    },
  };
  const evidence = new Map<string, Buffer>([
    ['readiness.json', jsonBytes(readiness)],
    ['RELEASE.md', Buffer.from('Synthetic release fixture\n')],
  ]);
  for (const platform of platforms) {
    evidence.set(`smoke-${platform}.json`, jsonBytes(smoke(platform, digest(archive), false)));
    evidence.set(`consumer-${platform}.json`, jsonBytes(smoke(platform, digest(archive), true)));
  }
  await sums(candidate, evidence);
  const store = new MemoryStore();
  const options = (overrides: Partial<NpmPublicationOptions> = {}): NpmPublicationOptions => ({
    ...context,
    command: 'check',
    dryRun: false,
    beginSubmission: false,
    submitted: false,
    ...overrides,
  });
  const fetcher: typeof fetch = async (_url, request) => {
    assert.equal(request?.credentials, 'omit');
    assert.equal(request?.redirect, 'error');
    assert.equal(new Headers(request?.headers).has('authorization'), false);
    return new Response('{}', { status: 404 });
  };
  const dependencies = { store, fetcher, now: () => now };
  const freeze = () =>
    runNpmPublication(options({ command: 'prepare', distribution, candidate }), dependencies);
  return {
    directory,
    distribution,
    candidate,
    archive,
    dist,
    evidence,
    readiness,
    store,
    options,
    dependencies,
    freeze,
  };
}

function publicFetcher(
  identity: PublicationIdentity,
  archive: Buffer,
  metadataOverrides: object = {},
  bytes = archive,
): typeof fetch {
  let count = 0;
  return async (input, request) => {
    assert.equal(request?.credentials, 'omit');
    assert.equal(request?.redirect, 'error');
    assert.equal(new Headers(request?.headers).has('authorization'), false);
    count++;
    if (count % 2 === 1) {
      assert.equal(String(input), 'https://registry.npmjs.org/%40seekskyworld%2Fai-modeling/0.1.3');
      return new Response(
        JSON.stringify({
          name: packageName,
          version: '0.1.3',
          dist: {
            integrity: identity.archive.integrity,
            shasum: identity.archive.shasum,
            tarball: 'https://registry.npmjs.org/@seekskyworld/ai-modeling/-/ai-modeling-0.1.3.tgz',
          },
          ...metadataOverrides,
        }),
      );
    }
    return new Response(new Uint8Array(bytes));
  };
}

test('fresh inspection is read-only and an existing legacy release never becomes a new submission on 404', async (t) => {
  const f = await fixture(t);
  assert.equal((await runNpmPublication(f.options(), f.dependencies)).action, 'prepare');
  assert.deepEqual(f.store.writes, []);
  f.store.exists = true;
  assert.equal((await runNpmPublication(f.options(), f.dependencies)).action, 'import_required');
  assert.equal((await f.freeze()).action, 'import_required');
  assert.deepEqual(f.store.writes, []);
});

test('prepare freezes the six original artifacts and complete candidate before marking prepared', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.freeze()).action, 'submit');
  assert.equal(f.store.writes[1], 'npm-publication-frozen.json');
  assert.equal(f.store.writes.at(-1), recordName('prepared'));
  assert.deepEqual(f.store.assets.get('ai-modeling-0.1.3.tgz'), f.archive);
  const record = parseRecord(f.store.assets.get(recordName('prepared'))!, context);
  assert.equal(record.identity.archive.sha256, digest(f.archive));
  assert.equal(record.identity.archive.sha512, digest(f.archive, 'sha512'));
  assert.equal(record.identity.distribution.length, 6);
  assert.equal(record.identity.candidate.length, 9);
  assert.deepEqual(Object.keys(record.identity).sort(), [
    'archive',
    'candidate',
    'distribution',
    'name',
    'readiness',
    'repository',
    'source',
    'tag',
    'version',
  ]);
  const target = path.join(f.directory, 'restored');
  await runNpmPublication(f.options({ restore: target }), f.dependencies);
  assert.deepEqual(await readFile(path.join(target, 'distribution', 'ai-modeling-0.1.3.tgz')), f.archive);
  assert.deepEqual(
    await readFile(path.join(target, 'candidate', 'readiness.json')),
    f.evidence.get('readiness.json'),
  );
});

test('ready=true cannot replace missing or foreign same-archive platform evidence', async (t) => {
  const f = await fixture(t);
  const report = JSON.parse(f.evidence.get('consumer-win32.json')!.toString());
  report.archive_sha256 = 'f'.repeat(64);
  f.evidence.set('consumer-win32.json', jsonBytes(report));
  await sums(f.candidate, f.evidence);
  await assert.rejects(f.freeze(), /does not verify this archive/);
  assert.deepEqual(f.store.writes, []);
  f.evidence.set('consumer-win32.json', jsonBytes(smoke('win32', digest(f.archive), true)));
  f.readiness.installation.consumer_locked_platforms = ['linux', 'darwin'];
  f.evidence.set('readiness.json', jsonBytes(f.readiness));
  await sums(f.candidate, f.evidence);
  await assert.rejects(f.freeze(), /three-platform/);
  assert.deepEqual(f.store.writes, []);
});

test('changed archive, source, symlink input and stale pricing are rejected before remote writes', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.distribution, 'ai-modeling-0.1.3.tgz');
  await writeFile(filename, 'changed');
  await assert.rejects(f.freeze(), /SHA256SUMS/);
  await writeFile(filename, f.archive);
  const target = path.join(f.directory, 'linked.tgz');
  await writeFile(target, f.archive);
  await rm(filename);
  await symlink(target, filename);
  await assert.rejects(f.freeze(), /regular file/);
  await rm(filename);
  await writeFile(filename, f.archive);
  await assert.rejects(
    runNpmPublication(
      f.options({ command: 'prepare', distribution: f.distribution, candidate: f.candidate }),
      { ...f.dependencies, now: () => now + 60 * 3600000 },
    ),
    /current, ready/,
  );
  f.readiness.provenance.source_commit = 'b'.repeat(40);
  f.evidence.set('readiness.json', jsonBytes(f.readiness));
  await sums(f.candidate, f.evidence);
  await assert.rejects(f.freeze(), /tagged commit/);
  f.readiness.provenance.source_commit = context.source;
  assert.deepEqual(f.store.writes, []);
});

test('only the first durable claim invocation authorizes publication, even with the same run ID', async (t) => {
  const f = await fixture(t);
  await f.freeze();
  const first = await runNpmPublication(
    f.options({ beginSubmission: true, runId: '123.1', restore: path.join(f.directory, 'attempt1') }),
    f.dependencies,
  );
  assert.equal(first.action, 'publish');
  assert.equal(first.should_publish, true);
  assert.ok(f.store.assets.has(recordName('submitting')));
  for (const runId of ['123.1', '123.2']) {
    const repeat = await runNpmPublication(
      f.options({ beginSubmission: true, runId, restore: path.join(f.directory, `retry-${runId}`) }),
      f.dependencies,
    );
    assert.equal(repeat.action, 'wait');
    assert.equal(repeat.should_publish, false);
    assert.deepEqual(
      await readFile(path.join(f.directory, `retry-${runId}`, 'distribution', 'ai-modeling-0.1.3.tgz')),
      f.archive,
    );
  }
  assert.equal(f.store.writes.filter((name) => name === recordName('submitting')).length, 1);
});

test('concurrent callers cannot both acquire the immutable submission claim', async (t) => {
  const f = await fixture(t);
  await f.freeze();
  const results = await Promise.allSettled(
    ['left', 'right'].map((runId) =>
      runNpmPublication(
        f.options({ beginSubmission: true, runId, restore: path.join(f.directory, runId) }),
        f.dependencies,
      ),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === 'fulfilled' && result.value.should_publish).length,
    1,
  );
  assert.equal(f.store.writes.filter((name) => name === recordName('submitting')).length, 1);
});

test('lost claim response and failed read-back never authorize npm and remain non-replayable', async (t) => {
  for (const failure of ['response', 'read-back']) {
    const f = await fixture(t);
    await f.freeze();
    if (failure === 'response') f.store.failAfterPut = recordName('submitting');
    else f.store.hideRead = recordName('submitting');
    await assert.rejects(
      runNpmPublication(
        f.options({ beginSubmission: true, runId: '123.1', restore: path.join(f.directory, 'attempt') }),
        f.dependencies,
      ),
      /response lost|read-back/,
    );
    f.store.hideRead = undefined;
    f.store.failAfterPut = undefined;
    assert.ok(f.store.assets.has(recordName('submitting')));
    assert.equal((await runNpmPublication(f.options(), f.dependencies)).action, 'wait');
  }
});

test('failed result persistence leaves the claim; accepted and unknown results never permit a retry on 404', async (t) => {
  for (const outcome of ['accepted', 'unknown'] as const) {
    const f = await fixture(t);
    await f.freeze();
    await runNpmPublication(
      f.options({ beginSubmission: true, runId: '123.1', restore: path.join(f.directory, 'attempt') }),
      f.dependencies,
    );
    const resultOptions = f.options({ submitted: true, runId: '123.1', outcome });
    f.store.failBeforePut = recordName('submitted');
    await assert.rejects(runNpmPublication(resultOptions, f.dependencies), /write rejected/);
    assert.equal((await runNpmPublication(f.options(), f.dependencies)).action, 'wait');
    f.store.failBeforePut = undefined;
    await assert.rejects(
      runNpmPublication({ ...resultOptions, runId: 'other' }, f.dependencies),
      /run claim/,
    );
    await runNpmPublication(resultOptions, f.dependencies);
    const repeated = await runNpmPublication(
      f.options({ beginSubmission: true, runId: '123.2', restore: path.join(f.directory, 'retry') }),
      f.dependencies,
    );
    assert.equal(repeated.state, 'submitted');
    assert.equal(repeated.should_publish, false);
  }
});

test('dry-run prepare, claim, result and verification never write remotely', async (t) => {
  const f = await fixture(t);
  await runNpmPublication(
    f.options({ command: 'prepare', distribution: f.distribution, candidate: f.candidate, dryRun: true }),
    f.dependencies,
  );
  assert.deepEqual(f.store.writes, []);
  await f.freeze();
  const count = f.store.writes.length;
  const preview = await runNpmPublication(
    f.options({
      beginSubmission: true,
      dryRun: true,
      runId: '123.1',
      restore: path.join(f.directory, 'preview'),
    }),
    f.dependencies,
  );
  assert.equal(preview.should_publish, false);
  assert.equal(f.store.writes.length, count);
  await runNpmPublication(
    f.options({ beginSubmission: true, runId: '123.1', restore: path.join(f.directory, 'actual') }),
    f.dependencies,
  );
  const submittedCount = f.store.writes.length;
  await runNpmPublication(
    f.options({ submitted: true, dryRun: true, runId: '123.1', outcome: 'accepted' }),
    f.dependencies,
  );
  const identity = parseRecord(f.store.assets.get(recordName('prepared'))!, context).identity;
  const verified = await runNpmPublication(f.options({ command: 'verify', dryRun: true }), {
    ...f.dependencies,
    fetcher: publicFetcher(identity, f.archive),
  });
  assert.equal(verified.action, 'published');
  assert.equal(verified.state, 'submitting');
  assert.equal(f.store.writes.length, submittedCount);
  assert.equal(f.store.assets.has(recordName('published')), false);
});

test('public verification requires exact identity, SHA-512 metadata and complete downloaded bytes', async (t) => {
  const f = await fixture(t);
  const { identity } = await preparePublicationIdentity(context, f.distribution, f.candidate, now);
  for (const metadata of [
    { name: 'foreign' },
    { version: '0.1.4' },
    { dist: { integrity: 'sha512-wrong' } },
    { dist: { integrity: identity.archive.integrity, tarball: 'https://evil.invalid/archive.tgz' } },
    {
      dist: {
        integrity: identity.archive.integrity,
        tarball: 'https://registry.npmjs.org/@seekskyworld/ai-modeling/-/ai-modeling-0.1.4.tgz',
      },
    },
  ])
    await assert.rejects(verifyPublicArchive(identity, publicFetcher(identity, f.archive, metadata), now));
  for (const bytes of [
    f.archive.subarray(1),
    Buffer.concat([f.archive, Buffer.from('x')]),
    Buffer.alloc(f.archive.length),
  ])
    await assert.rejects(
      verifyPublicArchive(identity, publicFetcher(identity, f.archive, {}, bytes), now),
      /frozen archive/,
    );
  const proof = await verifyPublicArchive(identity, publicFetcher(identity, f.archive), now);
  assert.equal(proof?.sha256, digest(f.archive));
  assert.equal(proof?.sha512, digest(f.archive, 'sha512'));
});

test('published is persisted only after the public tarball is verified; later 404 is not upload permission', async (t) => {
  const f = await fixture(t);
  await f.freeze();
  const identity = parseRecord(f.store.assets.get(recordName('prepared'))!, context).identity;
  await assert.rejects(
    runNpmPublication(f.options({ command: 'verify' }), {
      ...f.dependencies,
      fetcher: publicFetcher(identity, f.archive, {}, Buffer.alloc(f.archive.length)),
    }),
    /Downloaded/,
  );
  assert.equal(f.store.assets.has(recordName('published')), false);
  const result = await runNpmPublication(f.options({ command: 'verify' }), {
    ...f.dependencies,
    fetcher: publicFetcher(identity, f.archive),
  });
  assert.equal(result.action, 'published');
  assert.equal(result.state, 'published');
  assert.equal(
    parseRecord(f.store.assets.get(recordName('published'))!, context).verification?.size,
    f.archive.length,
  );
  assert.equal((await runNpmPublication(f.options(), f.dependencies)).action, 'wait');
  assert.equal((await runNpmPublication(f.options({ command: 'verify' }), f.dependencies)).action, 'wait');
});

test('imported accepted 0.1.3 facts reconcile without historical readiness and can never authorize upload', async (t) => {
  const f = await fixture(t);
  const prepared = await preparePublicationIdentity(context, f.distribution, f.candidate, now);
  const identity = { ...prepared.identity, readiness: null, candidate: [] };
  const imported = {
    ...makeRecord('submitted', identity, now, undefined, { run_id: 'legacy-accepted', outcome: 'accepted' }),
    origin: 'imported_submission' as const,
  };
  f.store.exists = true;
  for (const [name, bytes] of prepared.files) f.store.assets.set(name, bytes);
  f.store.assets.set(recordName('submitted'), jsonBytes(imported));
  const checked = await runNpmPublication(
    f.options({ beginSubmission: true, runId: 'new', restore: path.join(f.directory, 'retry') }),
    f.dependencies,
  );
  assert.equal(checked.action, 'wait');
  assert.equal(checked.should_publish, false);
  assert.deepEqual(f.store.writes, []);
  const verified = await runNpmPublication(f.options({ command: 'verify' }), {
    ...f.dependencies,
    fetcher: publicFetcher(identity, f.archive),
  });
  assert.equal(verified.action, 'published');
  const restored = path.join(f.directory, 'visible-restored');
  const visible = await runNpmPublication(f.options({ restore: restored }), {
    ...f.dependencies,
    fetcher: publicFetcher(identity, f.archive),
  });
  assert.equal(visible.action, 'verify');
  assert.deepEqual(await readFile(path.join(restored, 'distribution', 'ai-modeling-0.1.3.tgz')), f.archive);
});

test('interrupted freeze preserves its identity and refuses repacking or automatic retry', async (t) => {
  const f = await fixture(t);
  f.store.failAfterPut = 'npm-publication-frozen.json';
  await assert.rejects(f.freeze(), /response lost/);
  assert.equal((await runNpmPublication(f.options(), f.dependencies)).action, 'wait');
  f.store.failAfterPut = undefined;
  f.readiness.checked_at = new Date(now + 1).toISOString();
  f.evidence.set('readiness.json', jsonBytes(f.readiness));
  await sums(f.candidate, f.evidence);
  await assert.rejects(f.freeze(), /cannot change/);
});

test('receipt archive substitution and unavailable registry block submission without mutation', async (t) => {
  const f = await fixture(t);
  await f.freeze();
  const bytes = f.store.assets.get(recordName('prepared'))!;
  const record = parseRecord(bytes, context);
  record.identity.archive.sha256 = 'f'.repeat(64);
  record.identity_sha256 = identityDigest(record.identity);
  f.store.assets.set(recordName('prepared'), jsonBytes(record));
  await assert.rejects(runNpmPublication(f.options(), f.dependencies), /identities differ/);
  f.store.assets.set(recordName('prepared'), bytes);
  const count = f.store.writes.length;
  await assert.rejects(
    runNpmPublication(
      f.options({ beginSubmission: true, runId: 'new', restore: path.join(f.directory, 'attempt') }),
      { ...f.dependencies, fetcher: async () => new Response('{}', { status: 503 }) },
    ),
    /HTTP 503/,
  );
  assert.equal(f.store.writes.length, count);
});

test('GitHub asset download strips tokens at its explicit approved redirect boundary', async () => {
  const requests: { input: string; authorization: string | null }[] = [];
  const store = new GitHubPublicationStore(context.repository, 'synthetic-token', async (input, options) => {
    requests.push({
      input: String(input),
      authorization: new Headers(options?.headers).get('authorization'),
    });
    if (requests.length === 1)
      return new Response(null, {
        status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/synthetic?signature=fixture' },
      });
    return new Response('bytes');
  });
  assert.deepEqual(
    await store.read(
      { id: 10, tag: context.tag, draft: true, assets: [{ id: 3, name: 'file', size: 5 }] },
      'file',
      5,
    ),
    Buffer.from('bytes'),
  );
  assert.equal(requests[0]?.authorization, 'Bearer synthetic-token');
  assert.equal(requests[1]?.authorization, null);
});

test('GitHub restore finds draft-only releases through authenticated listing and resolves annotated tags', async () => {
  const requests: string[] = [];
  const store = new GitHubPublicationStore(context.repository, 'synthetic-token', async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/git/ref/tags/v0.1.3'))
      return new Response(JSON.stringify({ object: { type: 'tag', sha: 'b'.repeat(40) } }));
    if (url.endsWith('/git/tags/' + 'b'.repeat(40)))
      return new Response(JSON.stringify({ object: { type: 'commit', sha: context.source } }));
    if (url.endsWith('/releases?per_page=100&page=1'))
      return new Response(JSON.stringify([{ id: 10, tag_name: context.tag, draft: true }]));
    if (url.endsWith('/releases/10/assets?per_page=100&page=1')) return new Response('[]');
    throw new Error('Unexpected request: ' + url);
  });
  await store.assertTag(context);
  assert.equal((await store.load(context))?.draft, true);
  assert.equal(
    requests.some((url) => url.includes('/releases/tags/')),
    false,
  );
  const missingInventory = new GitHubPublicationStore(
    context.repository,
    'synthetic-token',
    async () => new Response('{}', { status: 404 }),
  );
  await assert.rejects(missingInventory.load(context), /absence is not established/);
  await assert.rejects(new GitHubPublicationStore(context.repository).load(context), /draft releases/);
});

test('CLI validates command combinations and never exposes a publish command', () => {
  const common = [
    '--repository',
    context.repository,
    '--tag',
    context.tag,
    '--source',
    context.source,
    '--out',
    '/tmp/new.json',
  ];
  assert.equal(parseNpmPublicationArgs(['check', ...common])?.command, 'check');
  assert.equal(parseNpmPublicationArgs(['--help']), undefined);
  for (const args of [
    ['publish', ...common],
    ['check', ...common, '--begin-submission'],
    ['check', ...common, '--outcome', 'accepted'],
    ['prepare', ...common],
    ['verify', ...common, '--run-id', '123'],
    ['check', ...common, '--dry-run', '--dry-run'],
    ['check', ...common, '--submitted', '--run-id', '123', '--outcome', 'rejected'],
  ])
    assert.throws(() => parseNpmPublicationArgs(args));
});
