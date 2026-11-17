import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
  parsePublicationNotesArgs,
  renderPublicationNotes,
  runPublicationNotes,
} from '../scripts/publication-notes.ts';
import { digest } from '../scripts/npm-publication-state.ts';

const execute = promisify(execFile);
const packageName = '@seekskyworld/ai-modeling';
const version = '0.1.2';
const originalPrice = {
  reviewed_at: '2026-01-01T00:00:00.000Z',
  expires_at: '2026-01-08T00:00:00.000Z',
  source: 'Reviewed original fixture; historical expiry is deliberately retained.',
  credits: { GenerateBase: 10, GPT_image_2_5: 20 },
  evidence: [
    { url: 'https://tripo-webapp-assets.tripo3d.ai/studio-prod/_nuxt/fixture.js', sha256: 'b'.repeat(64) },
  ],
};
const sourcePricing = Buffer.from(JSON.stringify(originalPrice, null, 2) + '\n');

function tgz(files: [string, Buffer][]): Buffer {
  const entries: Buffer[] = [];
  for (const [name, bytes] of files) {
    const header = Buffer.alloc(512);
    header.write(`package/${name}`);
    header.write('0000644\0', 100);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write(
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    const body = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
    bytes.copy(body);
    entries.push(header, body);
  }
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function fixture(
  price: Buffer | null = Buffer.from(JSON.stringify(originalPrice)),
  packageVersion = version,
  metadata = Buffer.from(JSON.stringify({ name: packageName, version: packageVersion })),
) {
  const files: [string, Buffer][] = [['package.json', metadata]];
  if (price) files.push(['dist/studio/api/reviewed-prices.json', price]);
  const archive = tgz(files);
  const sha512 = digest(archive, 'sha512');
  return {
    archive,
    sourcePricing,
    verification: {
      schema_version: 1,
      name: packageName,
      version,
      repository: 'maintainer/ai-modeling',
      tag: `v${version}`,
      source: 'a'.repeat(40),
      action: 'published',
      state: 'published',
      dry_run: false,
      registry_tarball_downloaded: true,
      archive_sha256: digest(archive),
      archive_sha512: sha512,
      verification: {
        checked_at: '2026-02-01T00:00:00.000Z',
        metadata_url: `https://registry.npmjs.org/%40seekskyworld%2Fai-modeling/${version}`,
        tarball_url: `https://registry.npmjs.org/${packageName}/-/ai-modeling-${version}.tgz`,
        size: archive.length,
        sha256: digest(archive),
        sha512,
        integrity: `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`,
        shasum: digest(archive, 'sha1'),
      },
    },
  };
}

async function files(t: TestContext, input = fixture()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-publication-notes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    verification: path.join(directory, 'verified.json'),
    archive: path.join(directory, 'original.tgz'),
    out: path.join(directory, 'notes.md'),
  };
  await writeFile(options.verification, JSON.stringify(input.verification));
  await writeFile(options.archive, input.archive);
  return { directory, options, input };
}

test('historical notes bind the fixed source and original JSON bytes while permitting compiler whitespace changes', () => {
  const input = fixture();
  const text = renderPublicationNotes(input);
  const url = `https://raw.githubusercontent.com/maintainer/ai-modeling/${input.verification.source}/studio/api/reviewed-prices.json`;
  const rawDigest = digest(sourcePricing);
  assert.notEqual(rawDigest, digest(Buffer.from(JSON.stringify(originalPrice))));
  assert.ok(text.includes(`npm install --global ${packageName}@0.1.2`));
  assert.ok(text.includes(`Source JSON SHA-256: \`${rawDigest}\``));
  assert.ok(text.includes(`ai-modeling pricing update "${url}" --sha256 ${rawDigest}`));
  assert.ok(text.includes(originalPrice.reviewed_at));
  assert.ok(text.includes(originalPrice.expires_at));
  assert.ok(text.includes('Expired snapshots remain rejected'));
  assert.ok(!text.includes('/main/'));
});

for (const field of [
  'dry_run',
  'registry_tarball_downloaded',
  'state',
  'name',
  'source',
  'version',
] as const) {
  test(`publication notes reject invalid publication evidence: ${field}`, () => {
    const input = fixture();
    const invalid: Record<string, unknown> = {
      dry_run: true,
      registry_tarball_downloaded: false,
      state: 'submitted',
      name: 'another-package',
      source: '../main',
      version: '99.0.0',
    };
    Object.assign(input.verification, { [field]: invalid[field] });
    assert.throws(() => renderPublicationNotes(input));
  });
}

test('all public archive proof fields must bind the actual bytes before pricing is described', () => {
  for (const field of ['size', 'sha256', 'sha512', 'integrity', 'shasum'] as const) {
    const input = fixture();
    Object.assign(input.verification.verification, { [field]: field === 'size' ? 1 : 'incorrect' });
    assert.throws(() => renderPublicationNotes(input));
  }
  const changed = fixture();
  changed.archive = Buffer.concat([changed.archive, Buffer.from('changed')]);
  assert.throws(() => renderPublicationNotes(changed), /original publicly verified TGZ/);
  assert.throws(() => renderPublicationNotes(fixture(undefined, '99.0.0')), /package identity/);
  const alternateRegistry = fixture();
  alternateRegistry.verification.verification.tarball_url = 'https://example.invalid/package.tgz';
  assert.throws(() => renderPublicationNotes(alternateRegistry), /registry source/);
});

test('missing or changed frozen prices cannot be replaced by current source prices', () => {
  assert.throws(() => renderPublicationNotes(fixture(null)), /no reviewed pricing JSON/);
  const changed = fixture(Buffer.from(JSON.stringify({ ...originalPrice, credits: { GenerateBase: 99 } })));
  assert.throws(() => renderPublicationNotes(changed), /differs from the original source commit/);
  const differentEvidence = fixture(Buffer.from(JSON.stringify({ ...originalPrice, evidence: [] })));
  assert.throws(() => renderPublicationNotes(differentEvidence), /differs from the original source commit/);
  const invalid = fixture();
  invalid.sourcePricing = Buffer.from('<html>not a pricing response</html>');
  assert.throws(() => renderPublicationNotes(invalid));
  invalid.sourcePricing = Buffer.alloc(1024 * 1024 + 1);
  assert.throws(() => renderPublicationNotes(invalid), /1 MiB/);
});

test('invalid JSON and schema errors never expose original input fragments', () => {
  const secret = 'SYNTHETIC_SECRET_ONLY';
  const malformed = Buffer.from(`{${secret}`);
  const schemaFailure = Buffer.from(JSON.stringify({ ...originalPrice, [secret]: true }));
  for (const bytes of [malformed, schemaFailure]) {
    const original = fixture();
    original.sourcePricing = bytes;
    for (const input of [original, fixture(bytes)])
      assert.throws(
        () => renderPublicationNotes(input),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /pricing JSON/);
          assert.ok(!error.message.includes(secret));
          return true;
        },
      );
  }
  assert.throws(
    () => renderPublicationNotes(fixture(undefined, version, malformed)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Original package metadata JSON could not be parsed.');
      return true;
    },
  );
});

test('the complete original pricing object is compared before schema normalization', () => {
  const input = fixture();
  input.sourcePricing = Buffer.from(
    JSON.stringify({
      ...originalPrice,
      evidence: originalPrice.evidence.map((entry) => ({ ...entry, private_note: 'SYNTHETIC_SECRET_ONLY' })),
    }),
  );
  assert.throws(
    () => renderPublicationNotes(input),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Frozen runtime pricing differs from the original source commit.');
      return true;
    },
  );
});

test('the updater source is fetched only from the original commit without credentials or redirects', async (t) => {
  const { options, input } = await files(t);
  let calls = 0;
  const result = await runPublicationNotes(options, async (url, init) => {
    calls++;
    assert.equal(
      url,
      `https://raw.githubusercontent.com/maintainer/ai-modeling/${input.verification.source}/studio/api/reviewed-prices.json`,
    );
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(init?.headers, { accept: 'application/json' });
    return new Response(sourcePricing.toString('utf8'));
  });
  assert.equal(calls, 1);
  assert.equal(result.pricing.sha256, digest(sourcePricing));
  assert.equal(await readFile(options.out, 'utf8'), renderPublicationNotes(input));
  await assert.rejects(runPublicationNotes(options), /already exists/);
});

test('source download failures, oversized responses and mismatches leave no release notes', async (t) => {
  const { options } = await files(t);
  for (const fetcher of [
    async () => new Response('not found', { status: 404 }),
    async () => new Response('x'.repeat(1024 * 1024 + 1)),
    async () => new Response(JSON.stringify({ ...originalPrice, credits: {} })),
  ]) {
    await assert.rejects(runPublicationNotes(options, fetcher));
    await assert.rejects(stat(options.out), { code: 'ENOENT' });
  }
});

test('unexpected source and filesystem failures expose only a fixed diagnostic', async (t) => {
  const { directory, options } = await files(t);
  for (const operation of [
    () =>
      runPublicationNotes(options, async () => {
        throw new Error('SYNTHETIC_SECRET_ONLY response');
      }),
    () => runPublicationNotes({ ...options, sourceDir: path.join(directory, 'SYNTHETIC_SECRET_ONLY') }),
    () => runPublicationNotes({ ...options, archive: path.join(directory, 'SYNTHETIC_SECRET_ONLY.tgz') }),
  ]) {
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        'Original publication inputs could not be verified or notes could not be written.',
      );
      return true;
    });
    await assert.rejects(stat(options.out), { code: 'ENOENT' });
  }
});

test('the actual CLI suppresses invalid Git pricing, proof contents and private argument paths', async (t) => {
  const { directory, options, input } = await files(t);
  const secret = 'SYNTHETIC_SECRET_ONLY';
  const repository = path.join(directory, secret);
  await mkdir(path.join(repository, 'studio/api'), { recursive: true });
  const filename = path.join(repository, 'studio/api/reviewed-prices.json');
  const git = (...args: string[]) => execute('git', args, { cwd: repository });
  await git('init', '--quiet');
  await git('config', 'user.name', 'Publication fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await mkdir(path.join(repository, '.git/empty-hooks'));
  await git('config', 'core.hooksPath', path.join(repository, '.git/empty-hooks'));
  const rejectCli = async (expected: RegExp) => {
    await assert.rejects(
      execute(process.execPath, [
        fileURLToPath(new URL('../scripts/publication-notes.ts', import.meta.url)),
        '--verification',
        options.verification,
        '--archive',
        options.archive,
        '--source-dir',
        repository,
        '--out',
        options.out,
      ]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const result = error as Error & { code: number; stdout: string; stderr: string };
        assert.equal(result.code, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, expected);
        assert.ok(!result.stderr.includes(secret));
        assert.ok(!result.stderr.includes(directory));
        return true;
      },
    );
    await assert.rejects(stat(options.out), { code: 'ENOENT' });
  };
  for (const content of [`{${secret}`, JSON.stringify({ ...originalPrice, [secret]: true })]) {
    await writeFile(filename, content);
    await git('add', 'studio/api/reviewed-prices.json');
    await git('commit', '--quiet', '-m', 'invalid synthetic original pricing');
    input.verification.source = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(options.verification, JSON.stringify(input.verification));
    await rejectCli(/publication notes: .*pricing JSON/);
  }
  await writeFile(options.verification, `{${secret}`);
  await rejectCli(/publication notes: Original verification JSON could not be parsed/);
});

test('local source lookup reads the exact Git object despite working-tree edits or replacement refs', async (t) => {
  const { directory, options, input } = await files(t);
  const repository = path.join(directory, 'source');
  await mkdir(path.join(repository, 'studio/api'), { recursive: true });
  const filename = path.join(repository, 'studio/api/reviewed-prices.json');
  const git = (...args: string[]) => execute('git', args, { cwd: repository });
  await git('init', '--quiet');
  await git('config', 'user.name', 'Publication fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await mkdir(path.join(repository, '.git/empty-hooks'));
  await git('config', 'core.hooksPath', path.join(repository, '.git/empty-hooks'));
  await writeFile(filename, sourcePricing);
  await git('add', 'studio/api/reviewed-prices.json');
  await git('commit', '--quiet', '-m', 'original reviewed snapshot');
  input.verification.source = (await git('rev-parse', 'HEAD')).stdout.trim();
  await writeFile(options.verification, JSON.stringify(input.verification));
  await writeFile(filename, JSON.stringify({ ...originalPrice, credits: {} }));
  await git('add', 'studio/api/reviewed-prices.json');
  await git('commit', '--quiet', '-m', 'different later snapshot');
  const later = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('replace', input.verification.source, later);
  await writeFile(filename, 'uncommitted invalid JSON');
  const result = await runPublicationNotes({ ...options, sourceDir: repository }, async () => {
    throw new Error('Local immutable source lookup must not access the network.');
  });
  assert.equal(result.source, input.verification.source);
  assert.equal(result.pricing.sha256, digest(sourcePricing));
  assert.equal(await readFile(options.out, 'utf8'), renderPublicationNotes(input));
  const cliOutput = path.join(directory, 'notes-cli.md');
  const invocation = await execute(process.execPath, [
    fileURLToPath(new URL('../scripts/publication-notes.ts', import.meta.url)),
    '--verification',
    options.verification,
    '--archive',
    options.archive,
    '--source-dir',
    repository,
    '--out',
    cliOutput,
  ]);
  assert.equal(JSON.parse(invocation.stdout).pricing.sha256, digest(sourcePricing));
  assert.equal(await readFile(cliOutput, 'utf8'), renderPublicationNotes(input));
});

test('notes arguments require explicit original inputs and a new external output', async () => {
  assert.equal(parsePublicationNotesArgs(['--help']), undefined);
  assert.deepEqual(
    parsePublicationNotesArgs([
      '--verification',
      'proof.json',
      '--archive',
      'original.tgz',
      '--out',
      'notes.md',
    ]),
    {
      verification: 'proof.json',
      archive: 'original.tgz',
      out: 'notes.md',
      sourceDir: undefined,
    },
  );
  for (const args of [
    ['--verification'],
    ['--archive', 'x'],
    ['--unknown', 'x'],
    ['--out', 'x', '--out', 'y'],
  ])
    assert.throws(() => parsePublicationNotesArgs(args));
  await assert.rejects(
    runPublicationNotes({ verification: 'missing.json', archive: 'missing.tgz', out: 'notes.md' }),
    /outside the source tree/,
  );
});
