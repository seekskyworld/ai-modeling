import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  distributionNames,
  digest,
  jsonBytes,
  makeRecord,
  type PublicationIdentity,
  type RegistryProof,
} from '../scripts/npm-publication-state.ts';
import { promoteVerifiedReleases, RemotePromotionBackend } from '../scripts/release-promotion.ts';

const repository = 'maintainer/ai-modeling';
const source = 'a'.repeat(40);
const packageName = '@seekskyworld/ai-modeling';
const instant = Date.parse('2026-11-19T00:00:00Z');

function released(version: string, id: number, draft = true) {
  const archive = Buffer.from(`original runtime bytes for ${version}`);
  const sha512 = digest(archive, 'sha512');
  const archiveName = `ai-modeling-${version}.tgz`;
  const assets = new Map<string, Buffer>(
    distributionNames(version).map((name) => [name, name === archiveName ? archive : Buffer.from(name)]),
  );
  const identity: PublicationIdentity = {
    repository,
    tag: `v${version}`,
    source,
    name: packageName,
    version,
    archive: {
      name: archiveName,
      size: archive.length,
      sha256: digest(archive),
      sha512,
      integrity: `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`,
      shasum: digest(archive, 'sha1'),
    },
    distribution: [...assets].map(([name, bytes]) => ({ name, size: bytes.length, sha256: digest(bytes) })),
    candidate: [],
    readiness: null,
  };
  const proof: RegistryProof = {
    checked_at: new Date(instant).toISOString(),
    metadata_url: `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`,
    tarball_url: `https://registry.npmjs.org/@seekskyworld/ai-modeling/-/ai-modeling-${version}.tgz`,
    size: archive.length,
    sha256: identity.archive.sha256,
    sha512,
    integrity: identity.archive.integrity,
    shasum: identity.archive.shasum,
  };
  const record = makeRecord('published', identity, instant, undefined, { verification: proof });
  record.origin = 'imported_submission';
  assets.set('npm-publication-published.json', jsonBytes(record));
  return { id, tag_name: identity.tag, draft, body: 'pending', assets, identity, archive, proof };
}
type TestRelease = ReturnType<typeof released>;

async function remoteFixture(t: TestContext, releases: TestRelease[]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-promotion-remote-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writes: { route: string; body: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  const tags: Record<string, string> = {};
  const control = {
    failChannels: false,
    loseVisibilityResponse: false,
    corruptPublicArchive: false,
    latest: undefined as TestRelease | undefined,
  };
  const assetIndex = (release: TestRelease) =>
    [...release.assets].map(([name, bytes], index) => ({
      id: release.id * 100 + index,
      name,
      size: bytes.length,
    }));
  const visible = (release: TestRelease) => ({
    id: release.id,
    tag_name: release.tag_name,
    draft: release.draft,
    body: release.body,
  });
  const fetcher: typeof fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const route = url.pathname + url.search;
    if ((options.method ?? 'GET') === 'GET') reads.push(route);
    if (url.hostname === 'registry.npmjs.org') {
      assert.equal(new Headers(options.headers).has('authorization'), false);
      if (route.startsWith('/-/package/'))
        return control.failChannels ? new Response('{}', { status: 503 }) : Response.json(tags);
      const release = releases.find(
        (item) =>
          route.endsWith(`/${item.identity.version}`) ||
          route.endsWith(`/ai-modeling-${item.identity.version}.tgz`),
      );
      assert.ok(release, `Unexpected registry request: ${route}`);
      if (route.endsWith('.tgz'))
        return new Response(
          new Uint8Array(control.corruptPublicArchive ? Buffer.from('changed') : release.archive),
        );
      return Response.json({
        name: packageName,
        version: release.identity.version,
        dist: {
          integrity: release.proof.integrity,
          shasum: release.proof.shasum,
          tarball: release.proof.tarball_url,
        },
      });
    }
    assert.equal(url.hostname, 'api.github.com');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer synthetic-token');
    const local = route.replace(`/repos/${repository}`, '');
    if (local.startsWith('/releases?')) {
      const page = Number(url.searchParams.get('page'));
      return Response.json(releases.slice((page - 1) * 100, page * 100).map(visible));
    }
    if (local === '/releases/latest')
      return control.latest ? Response.json(visible(control.latest)) : new Response('{}', { status: 404 });
    if (local.startsWith('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: source } });
    const assetRoute = /^\/releases\/assets\/(\d+)$/.exec(local);
    if (assetRoute) {
      const id = Number(assetRoute[1]);
      const release = releases.find((item) => item.id === Math.floor(id / 100));
      assert.ok(release);
      const entry = [...release.assets][id % 100];
      assert.ok(entry);
      return new Response(new Uint8Array(entry[1]));
    }
    const releaseRoute = /^\/releases\/(\d+)(\/assets.*)?$/.exec(local);
    assert.ok(releaseRoute, `Unexpected GitHub request: ${local}`);
    const release = releases.find((item) => item.id === Number(releaseRoute[1]));
    assert.ok(release);
    if (releaseRoute[2]) return Response.json(assetIndex(release));
    if (options.method === 'PATCH') {
      const body = JSON.parse(Buffer.from(options.body as Uint8Array).toString('utf8')) as Record<
        string,
        unknown
      >;
      writes.push({ route: local, body });
      if (body.make_latest === 'true') control.latest = release;
      if (body.draft === false) {
        release.draft = false;
        release.body = String(body.body);
      }
      if (body.draft === false && control.loseVisibilityResponse)
        throw new Error('Response lost after visibility update');
    }
    return Response.json(visible(release));
  };
  const backend = new RemotePromotionBackend(repository, directory, directory, fetcher, 'synthetic-token');
  t.mock.method(backend, 'notes', async (proofPath: string, archivePath: string, output: string) => {
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    assert.equal(proof.action, 'published');
    assert.equal(proof.dry_run, false);
    assert.equal(proof.registry_tarball_downloaded, true);
    assert.equal(digest(await readFile(archivePath)), proof.archive_sha256);
    await writeFile(output, `Verified notes for ${proof.version}`, { flag: 'wx' });
  });
  t.mock.method(backend, 'npmTag', async (channel: string, version: string) => {
    writes.push({ route: 'npm-dist-tag', body: { channel, version } });
    tags[channel] = version;
  });
  return { backend, directory, writes, reads, tags, control };
}

test('missing or corrupt receipt does not hide the remaining verified backlog', async (t) => {
  const missing = released('0.1.2', 1);
  missing.assets.delete('npm-publication-published.json');
  const corrupt = released('0.1.4', 3);
  corrupt.assets.set('npm-publication-published.json', Buffer.from('{broken'));
  const valid = released('0.1.3', 2);
  const f = await remoteFixture(t, [missing, corrupt, valid]);
  const report = await promoteVerifiedReleases(f.backend);
  assert.deepEqual(report.published, ['0.1.3']);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0]!.tag, 'v0.1.4');
  assert.equal(report.after.latest, '0.1.3');
  assert.equal(corrupt.draft, true);
});

test('remote recovery of the imported 0.1.3 receipt re-downloads original bytes and reads back visibility', async (t) => {
  const original = released('0.1.3', 1);
  const f = await remoteFixture(t, [original]);
  f.control.loseVisibilityResponse = true;
  const report = await promoteVerifiedReleases(f.backend);
  assert.deepEqual(report.failures, []);
  assert.equal(report.after.latest, '0.1.3');
  assert.equal(report.after.githubLatest, '0.1.3');
  assert.equal(original.body, 'Verified notes for 0.1.3');
  assert.equal(f.writes.filter((entry) => entry.body.draft === false).length, 1);
  assert.ok(f.reads.some((route) => route.endsWith('/ai-modeling-0.1.3.tgz')));
  assert.ok(f.reads.some((route) => route === `/repos/${repository}/releases/1`));
});

test('changed public archive cannot publish a release or advance either default channel', async (t) => {
  const f = await remoteFixture(t, [released('0.1.3', 1)]);
  f.control.corruptPublicArchive = true;
  const report = await promoteVerifiedReleases(f.backend);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0]!.stage, 'public-verification');
  assert.deepEqual(f.writes, []);
});

test('unknown current npm channels fail closed before any remote mutation', async (t) => {
  const f = await remoteFixture(t, [released('0.1.3', 1)]);
  f.control.failChannels = true;
  await assert.rejects(promoteVerifiedReleases(f.backend), /current npm channels: HTTP 503/);
  assert.deepEqual(f.writes, []);
});

test('receipt inventory follows pagination before concluding the backlog is empty', async (t) => {
  const releases = Array.from({ length: 101 }, (_, index) => {
    const release = released(`0.0.${index}`, index + 1, false);
    if (index < 100) release.assets.delete('npm-publication-published.json');
    return release;
  });
  const f = await remoteFixture(t, releases);
  const candidates = await f.backend.candidates();
  assert.deepEqual(
    candidates.map((candidate) => candidate.version),
    ['0.0.100'],
  );
  assert.ok(f.reads.some((route) => route.endsWith('per_page=100&page=2')));
  assert.deepEqual(f.writes, []);
});

test('draft inventory requires explicit GitHub authorization instead of assuming invisible releases do not exist', () => {
  assert.throws(
    () => new RemotePromotionBackend(repository, '.', '.', async () => new Response('{}'), ''),
    /draft releases remain visible/,
  );
});

test('notes subprocess failures cannot persist input secrets or local command paths', async (t) => {
  const f = await remoteFixture(t, [released('0.1.3', 1)]);
  const secret = 'SYNTHETIC_SECRET_ONLY';
  t.mock.method(f.backend, 'notes', async () => {
    throw new Error(`${f.directory}/private-source ${secret}`);
  });
  const report = await promoteVerifiedReleases(f.backend);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0]!.stage, 'release-visibility');
  assert.equal(report.failures[0]!.tag, 'v0.1.3');
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(JSON.stringify(report).includes(f.directory), false);
  assert.deepEqual(f.writes, []);
});

test('the actual notes child-process boundary removes argv and stderr from its error', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-notes-private-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = new RemotePromotionBackend(
    repository,
    directory,
    directory,
    async () => {
      throw new Error('No network');
    },
    'synthetic-token',
  );
  const privateInput = path.join(directory, 'SYNTHETIC_SECRET_ONLY.json');
  await writeFile(privateInput, '{"secret":"SYNTHETIC_SECRET_ONLY"');
  await assert.rejects(
    backend.notes(privateInput, path.join(directory, 'missing.tgz'), path.join(directory, 'out.md')),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Frozen release notes could not be verified; publication remains pending.');
      assert.equal(String(error).includes(directory), false);
      assert.equal(String(error).includes('SYNTHETIC_SECRET_ONLY'), false);
      return true;
    },
  );
});
