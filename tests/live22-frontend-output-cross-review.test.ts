/** 独立检查授权任务的本地产物闭环；伪上游只隔离网络，SQLite、缓存、查询和下载均走生产实现。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile, rm, writeFile, lstat, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, tinyGlb } from './helpers.ts';
import { StudioClient } from '../studio/api/client.ts';
import { TripoError, object, text } from '../studio/contracts/errors.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import { submitFrontendExport, type FrontendExportRuntime } from '../cli/core/frontend-export.ts';

const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const metadata = { forward_axis: '-y', pivot_to_center_bottom: true } as const;
async function outputFixture() {
  const f = await fixture(),
    bytes = tinyGlb();
  const counts = { source: 0, read: 0, convert: 0, forbidden: 0 };
  const forbidden = async (): Promise<never> => {
    counts.forbidden++;
    throw Error('No upstream access is allowed during local output recovery');
  };
  const client = new StudioClient(f.service.credentials, forbidden);
  const runtime: FrontendExportRuntime = {
    source: async () => {
      counts.source++;
      return { url: 'https://cdn.tripo3d.ai/frozen-model.glb', name: 'Frozen source', metadata: {} };
    },
    read: async () => {
      counts.read++;
      return bytes;
    },
    convert: async () => {
      counts.convert++;
      return { bytes, proof: { source_sha256: hash(bytes), output_sha256: hash(bytes), metadata } };
    },
  };
  const input = {
    project_id: 'output-project',
    operator_id: 'output-operator',
    request_id: 'output-request',
    ...metadata,
    max_credits: 10,
  };
  f.gateway.submit = async () => {
    f.gateway.posts++;
    if (f.gateway.failSubmit) throw f.gateway.failSubmit;
    return {
      remote_ids: { project_id: input.project_id, operator_id: input.operator_id },
      status: { state: 'succeeded' as const, progress: 100, artifacts: [] },
    };
  };
  f.gateway.status = forbidden;
  f.gateway.artifactUrl = forbidden;
  const run = (changes: Record<string, unknown> = {}, overrides: FrontendExportRuntime = {}) =>
    submitFrontendExport(f.service, client, { ...input, ...changes }, { ...runtime, ...overrides });
  const cache = path.join(f.dir, 'verified-output-cache', hash('test-account'), `${hash(bytes)}.glb`);
  const mutate = (action: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
    try {
      action(db);
    } finally {
      db.close();
    }
  };
  const cleanup = async () => {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  };
  return { ...f, bytes, counts, client, runtime, input, run, forbidden, cache, mutate, cleanup };
}

test('frontend authorization without delivery survives restart through get, list and exact cache download', async () => {
  const f = await outputFixture();
  let restored: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const first = await f.run(),
      job = object(first.export_lite_job),
      id = text(first.export_lite_job_id);
    assert.equal(job.state, 'succeeded');
    assert.equal(job.task_type, 'frontend_export');
    assert.equal((job.artifacts as unknown[]).length, 1);
    assert.equal(f.gateway.posts, 1);
    restored = await fixture(f.dir);
    restored.gateway.submit = f.forbidden;
    restored.gateway.status = f.forbidden;
    restored.gateway.artifactUrl = f.forbidden;
    const viewed = await restored.service.get(id);
    assert.equal(viewed.state, 'succeeded');
    assert.equal(object(viewed.frontend_output_validation).status, 'verified');
    assert.equal(object((restored.service.list(20, 0).jobs as unknown[])[0]).state, 'succeeded');
    const output = path.join(f.dir, 'output', 'recovered.glb');
    const downloaded = await restored.service.download(id, 'model', output);
    assert.equal(downloaded.sha256, hash(f.bytes));
    assert.deepEqual(await readFile(output), f.bytes);
    assert.deepEqual(f.counts, { source: 2, read: 1, convert: 1, forbidden: 0 });
    assert.equal(restored.gateway.posts, 0);
    const repeated = await restored.service.download(id, 'model', output);
    assert.equal(repeated.sha256, downloaded.sha256);
    assert.equal(repeated.local_path, downloaded.local_path);
    assert.equal(f.counts.forbidden, 0);
  } finally {
    restored?.jobs.close();
    await f.cleanup();
  }
});

test('frontend output aliases reuse only the original regular file and reject unrelated, corrupted or linked targets', async () => {
  const f = await outputFixture();
  try {
    const first = await f.run(),
      id = text(first.export_lite_job_id);
    const directory = path.join(f.dir, 'output'),
      target = path.join(directory, 'original.glb');
    const downloaded = await f.service.download(id, 'model', target);
    const before = await lstat(target);
    const alias = path.join(f.dir, 'same-output-directory');
    await symlink(directory, alias, 'dir');
    f.service.config.outputDir = '';
    const aliased = await f.service.download(id, 'model', path.join(alias, 'original.glb'));
    assert.equal(aliased.local_path, downloaded.local_path);
    assert.equal(aliased.sha256, hash(f.bytes));
    const after = await lstat(target);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);

    const differentName = path.join(directory, 'another.glb');
    const differentDirectory = path.join(f.dir, 'different-output-directory');
    await mkdir(differentDirectory);
    const differentParent = path.join(differentDirectory, 'original.glb');
    for (const existing of [differentName, differentParent]) {
      await writeFile(existing, f.bytes);
      const prior = await lstat(existing);
      await assert.rejects(f.service.download(id, 'model', existing), { code: 'OUTPUT_EXISTS' });
      assert.deepEqual(await readFile(existing), f.bytes);
      assert.equal((await lstat(existing)).mtimeMs, prior.mtimeMs);
    }
    const corruption = Buffer.alloc(f.bytes.length);
    await writeFile(target, corruption);
    await assert.rejects(f.service.download(id, 'model', path.join(alias, 'original.glb')), {
      code: 'OUTPUT_EXISTS',
    });
    assert.deepEqual(await readFile(target), corruption);
    await rm(target);
    await symlink(differentName, target);
    await assert.rejects(f.service.download(id, 'model', path.join(alias, 'original.glb')), {
      code: 'OUTPUT_EXISTS',
    });
    assert.equal((await lstat(target)).isSymbolicLink(), true);
    assert.deepEqual(await readFile(differentName), f.bytes);
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.counts.forbidden, 0);
  } finally {
    await f.cleanup();
  }
});

test('frontend proof namespaces reject standalone/pipeline and prefixed-request collisions before a second authorization', async () => {
  for (const direct of [false, true]) {
    const f = await outputFixture();
    try {
      const original = direct ? { authorizationRequestId: f.input.request_id } : {};
      const other = direct ? {} : { authorizationRequestId: f.input.request_id };
      const first = await f.run({}, original);
      await assert.rejects(f.run({}, other), { code: 'IDEMPOTENCY_CONFLICT' });
      if (!direct)
        await assert.rejects(
          f.run(
            { request_id: `frontend-export:${f.input.request_id}` },
            {
              authorizationRequestId: `frontend-export:${f.input.request_id}`,
            },
          ),
          { code: 'IDEMPOTENCY_CONFLICT' },
        );
      await assert.rejects(
        f.run(
          { request_id: 'another-intent' },
          {
            authorizationRequestId: 'unrelated-authorization',
          },
        ),
        { code: 'INVALID_INPUT' },
      );
      assert.equal((await f.run({}, original)).export_lite_job_id, first.export_lite_job_id);
      assert.equal(f.gateway.posts, 1);
      assert.deepEqual(f.counts, { source: 2, read: 1, convert: 1, forbidden: 0 });
    } finally {
      await f.cleanup();
    }
  }
});

test('unknown frontend authorization has no downloadable output and is never retried or converted again', async () => {
  const f = await outputFixture();
  try {
    f.gateway.failSubmit = new TripoError('NETWORK_ERROR', 'The response was lost', 'unknown');
    const first = await f.run(),
      id = text(first.export_lite_job_id);
    assert.equal(object(first.export_lite_job).state, 'outcome_unknown');
    assert.deepEqual(object(first.export_lite_job).artifacts, []);
    assert.equal((await f.service.get(id)).state, 'outcome_unknown');
    assert.equal(object((f.service.list(20, 0).jobs as unknown[])[0]).state, 'outcome_unknown');
    const target = path.join(f.dir, 'output', 'unknown.glb');
    await assert.rejects(f.service.download(id, 'model', target), {
      code: 'FRONTEND_AUTHORIZATION_INCOMPLETE',
    });
    assert.equal((await f.run()).export_lite_job_id, id);
    assert.equal(f.gateway.posts, 1);
    assert.deepEqual(f.counts, { source: 2, read: 1, convert: 1, forbidden: 0 });
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  } finally {
    await f.cleanup();
  }
});

test('a rejected convert validation cannot become a successful convert through a plain authorization call', async () => {
  const f = await outputFixture();
  try {
    const intent = {
      version: 1,
      source: '@frozen-source',
      parameters: { format: 'GLTF', bake: false },
      project_id: f.input.project_id,
      operator_id: f.input.operator_id,
    };
    f.jobs.bindRequestPolicy('test-account', `frontend-convert-intent:${f.input.request_id}`, intent);
    await assert.rejects(
      f.run(
        {},
        {
          authorizationRequestId: f.input.request_id,
          validatePrepared: () => {
            throw new TripoError('FRONTEND_CONVERT_UNVERIFIED', 'The texture or pivot effect failed.');
          },
        },
      ),
      { code: 'FRONTEND_CONVERT_UNVERIFIED' },
    );
    assert.equal(f.gateway.posts, 0);
    const sourceProof = f.jobs.requestPolicy('test-account', `frontend-export-proof:${f.input.request_id}`)!;
    assert.ok(sourceProof);
    const native = await f.service.submit(
      'export_lite',
      f.input.request_id,
      {
        project_id: f.input.project_id,
        operator_id: f.input.operator_id,
        format: 'glb',
        public_model: false,
      },
      10,
    );
    const id = text(native.job_id);
    const rejected = await f.service.get(id);
    assert.equal(rejected.state, 'needs_attention');
    assert.deepEqual(rejected.artifacts, []);
    const target = path.join(f.dir, 'output', 'unverified-convert.glb');
    await assert.rejects(f.service.download(id, 'model', target), {
      code: 'FRONTEND_OUTPUT_IDENTITY_CHANGED',
    });
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.counts.forbidden, 0);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
    assert.equal(
      f.jobs.requestPolicy('test-account', `frontend-convert-proof:${f.input.request_id}`),
      undefined,
    );
    assert.equal(
      fingerprint(f.jobs.requestPolicy('test-account', `frontend-convert-intent:${f.input.request_id}`)),
      fingerprint(intent),
    );
  } finally {
    await f.cleanup();
  }
});

test('lost or corrupt frontend cache makes get and history unverified without fetching the model source', async () => {
  for (const mutation of ['lost', 'corrupt']) {
    const f = await outputFixture();
    try {
      const first = await f.run(),
        id = text(first.export_lite_job_id);
      if (mutation === 'lost') await rm(f.cache);
      else await writeFile(f.cache, Buffer.alloc(f.bytes.length));
      const result = await f.service.get(id);
      assert.equal(result.state, 'needs_attention');
      assert.equal(object(result.error).code, 'FRONTEND_CACHE_MISSING');
      assert.deepEqual(result.artifacts, []);
      assert.equal(object((f.service.list(20, 0).jobs as unknown[])[0]).state, 'needs_attention');
      const target = path.join(f.dir, 'output', 'missing.glb');
      await assert.rejects(f.service.download(id, 'model', target), { code: 'FRONTEND_CACHE_MISSING' });
      assert.equal(f.gateway.posts, 1);
      assert.equal(f.counts.forbidden, 0);
      await assert.rejects(lstat(target), { code: 'ENOENT' });
    } finally {
      await f.cleanup();
    }
  }
});

test('original source proof, receipt, artifact and compatibility drift cannot reuse a bound frontend file', async () => {
  for (const field of ['source', 'receipt', 'artifact', 'compatibility']) {
    const f = await outputFixture();
    try {
      const first = await f.run(),
        id = text(first.export_lite_job_id);
      f.mutate((db) => {
        if (field === 'source')
          db.prepare(
            "UPDATE request_policies SET policy=json_set(policy,'$.source_location',?) WHERE request_id=?",
          ).run(hash('different-source'), `frontend-export-proof:${f.input.request_id}`);
        if (field === 'receipt')
          db.prepare(
            "UPDATE jobs SET remote_ids=json_set(remote_ids,'$.operator_id','different-version') WHERE job_id=?",
          ).run(id);
        if (field === 'artifact')
          db.prepare(
            "UPDATE jobs SET artifacts=json_set(artifacts,'$[0].source_sha256',?) WHERE job_id=?",
          ).run(hash('different-source'), id);
        if (field === 'compatibility')
          db.prepare(
            'INSERT INTO request_policies(account_ref,request_id,policy,legacy) VALUES(?,?,?,0)',
          ).run(
            'test-account',
            `frontend-convert-intent:frontend-export:${f.input.request_id}`,
            JSON.stringify({ different_intent: true }),
          );
      });
      const result = await f.service.get(id);
      assert.equal(result.state, 'needs_attention');
      assert.deepEqual(result.artifacts, []);
      const target = path.join(f.dir, 'output', 'changed.glb');
      await assert.rejects(
        f.service.download(id, 'model', target),
        (error) =>
          error instanceof TripoError &&
          ['FRONTEND_OUTPUT_IDENTITY_CHANGED', 'FRONTEND_OUTPUT_CONTENT_CHANGED'].includes(error.code),
      );
      assert.equal(f.gateway.posts, 1);
      assert.equal(f.counts.forbidden, 0);
      await assert.rejects(lstat(target), { code: 'ENOENT' });
    } finally {
      await f.cleanup();
    }
  }
});

test('legacy frontend proof with original prefixed authorization binds the retained file without a new submission', async () => {
  const f = await outputFixture();
  try {
    const first = await f.run(),
      id = text(first.export_lite_job_id);
    f.mutate((db) => {
      db.prepare('DELETE FROM request_policies WHERE request_id=?').run(`frontend-output:${id}`);
      db.prepare(
        "UPDATE request_policies SET policy=json_remove(policy,'$.authorization_request_id') WHERE request_id=?",
      ).run(`frontend-export-proof:${f.input.request_id}`);
      db.prepare("UPDATE jobs SET artifacts='[]' WHERE job_id=?").run(id);
    });
    const result = await f.service.get(id);
    assert.equal(result.state, 'succeeded');
    const target = path.join(f.dir, 'output', 'legacy.glb');
    await f.service.download(id, 'model', target);
    assert.deepEqual(await readFile(target), f.bytes);
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.counts.forbidden, 0);
  } finally {
    await f.cleanup();
  }
});

test('frontend output persistence migrates old schema while retaining original jobs and proofs', async () => {
  const f = await outputFixture();
  let migrated: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const first = await f.run(),
      id = text(first.export_lite_job_id);
    const before = f.jobs.get(id);
    f.mutate((db) => db.exec('PRAGMA user_version=10'));
    migrated = await fixture(f.dir);
    f.mutate((db) => assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 18));
    assert.deepEqual(migrated.jobs.get(id), before);
    migrated.gateway.status = f.forbidden;
    migrated.gateway.artifactUrl = f.forbidden;
    assert.equal((await migrated.service.get(id)).state, 'succeeded');
    assert.equal(f.counts.forbidden, 0);
  } finally {
    migrated?.jobs.close();
    await f.cleanup();
  }
});
