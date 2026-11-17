import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { checkRegistry, parseRegistryArgs } from '../scripts/registry-check.ts';
import { VERSION } from '../version.ts';

function archive(version = VERSION) {
  const bytes = Buffer.from(JSON.stringify({ name: '@seekskyworld/ai-modeling', version }));
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
  const padded = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
  bytes.copy(padded);
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
}

const response =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

test('registry lookup is public, exact-version, and distinguishes missing publication from server failure', async () => {
  const missing = await checkRegistry(undefined, async (input, options) => {
    assert.equal(input, `https://registry.npmjs.org/%40seekskyworld%2Fai-modeling/${VERSION}`);
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.redirect, 'error');
    assert.deepEqual(options?.headers, { accept: 'application/json' });
    return new Response('{}', { status: 404 });
  });
  assert.equal(missing.published, false);
  assert.equal(missing.archive_matches_registry_digest, null);
  assert.equal(missing.publication_performed, false);
  assert.equal(missing.registry_tarball_downloaded, false);
  await assert.rejects(checkRegistry(undefined, response({}, 503)), /HTTP 503/);
  await assert.rejects(
    checkRegistry(undefined, response({ name: 'another-package', version: VERSION })),
    /another package/,
  );
});

test('registry digest compares the inspected archive bytes, rejecting drift without claiming ownership or download verification', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-registry-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = archive();
  const filename = path.join(directory, 'candidate.tgz');
  await writeFile(filename, bytes);
  const metadata = {
    name: '@seekskyworld/ai-modeling',
    version: VERSION,
    dist: { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
  };
  const match = await checkRegistry(filename, response(metadata));
  assert.equal(match.published, true);
  assert.equal(match.archive_matches_registry_digest, true);
  assert.equal(match.archive_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(match.package_ownership_verified, false);
  const mismatch = await checkRegistry(
    filename,
    response({ ...metadata, dist: { integrity: 'sha512-YWJj' } }),
  );
  assert.equal(mismatch.archive_matches_registry_digest, false);
  const withoutArchive = await checkRegistry(undefined, response(metadata));
  assert.equal(withoutArchive.archive_matches_registry_digest, null);
  await writeFile(filename, archive('99.0.0'));
  await assert.rejects(checkRegistry(filename, response(metadata)), /current ai-modeling/);
});

test('registry refuses unsupported or oversized metadata and duplicate arguments', async () => {
  await assert.rejects(
    checkRegistry(undefined, response({ name: '@seekskyworld/ai-modeling', version: VERSION, dist: {} })),
    /no supported package digest/,
  );
  await assert.rejects(checkRegistry(undefined, response('x'.repeat(1024 * 1024 + 1))), /exceeds/);
  assert.deepEqual(parseRegistryArgs(['--report', 'report.json', '--require-published']), {
    report: 'report.json',
    requirePublished: true,
  });
  assert.equal(parseRegistryArgs(['--help']), undefined);
  for (const args of [
    ['--report'],
    ['--archive', 'x', '--archive', 'y'],
    ['--require-published', '--require-published'],
    ['--registry', 'https://untrusted.invalid'],
  ])
    assert.throws(() => parseRegistryArgs(args));
});
