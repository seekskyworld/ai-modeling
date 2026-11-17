/** 独立交叉审查：固定来源、未知 metadata、真实字节和 runtime 边界；不调用真实账号或网络。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { mat4 } from 'gl-matrix';
import { fixture, quote } from './helpers.ts';
import { exportFrontend, type FrontendExportRuntime } from '../cli/core/frontend-export.ts';
import { verifyStudioFrontend } from '../cli/artifacts/studio-assimp-proof.ts';
import { restoreFrontendDefaults } from '../cli/artifacts/studio-assimp-rest.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { frontendExportSource } from '../studio/api/frontend-export-source.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import { loadStudioAssimpAssets, studioAssimpFiles } from '../cli/artifacts/studio-assimp-assets.ts';
import {
  normalizeFrontendAnimation,
  readFrontendDocument,
  validateFrontendGlb,
} from '../cli/artifacts/studio-assimp-normalize.ts';

const session = {
  accountRef: 'frontend-review-account',
  cookie: 'frontend-review-not-a-real-cookie',
  deviceId: 'frontend-review-device',
  importedAt: '2026-11-15T00:00:00.000Z',
};
const detail = (operator: Record<string, unknown> = {}) => ({
  id: 'review-project',
  project_name: 'review model',
  is_owner: true,
  model_url: 'https://cdn.tripo3d.ai/exact-model.glb',
  operator: { operator_id: 'review-version', status: 'success', metadata: {}, ...operator },
});
const sourceClient = (value: unknown, afterRead?: (credentials: MemoryCredentials) => void) => {
  const credentials = new MemoryCredentials(session);
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const client = new StudioClient(credentials, async (url, init) => {
    requests.push({ url, method: init.method });
    afterRead?.(credentials);
    return new Response(JSON.stringify({ code: 0, data: value }));
  });
  return { client, requests };
};
const readSource = (client: StudioClient) =>
  frontendExportSource(client, session.accountRef, 'review-project', 'review-version');

async function modelBytes(animation = false, nonfinite = false): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const positions = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([nonfinite ? NaN : 0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const indices = doc
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2]))
    .setBuffer(buffer);
  const node = doc
    .createNode('triangle')
    .setMesh(
      doc
        .createMesh()
        .addPrimitive(doc.createPrimitive().setAttribute('POSITION', positions).setIndices(indices)),
    );
  doc.createScene().addChild(node);
  if (animation) {
    const input = doc
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Float32Array([0, 2]))
      .setBuffer(buffer);
    const output = doc
      .createAccessor()
      .setType('VEC4')
      .setArray(new Int16Array([0, 0, 0, 32767, 0, 23170, 0, 23170]))
      .setNormalized(true)
      .setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
    const channel = doc
      .createAnimationChannel()
      .setSampler(sampler)
      .setTargetNode(node)
      .setTargetPath('rotation');
    doc.createAnimation('turn').addSampler(sampler).addChannel(channel);
  }
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

test('frontend source reads the exact version and rejects changed identities or account switches', async () => {
  const good = sourceClient(detail());
  const result = await readSource(good.client);
  assert.equal(result.url, 'https://cdn.tripo3d.ai/exact-model.glb');
  assert.deepEqual(good.requests, [
    {
      url: 'https://api.tripo3d.ai/v2/studio/project/detail/v3/review-project?operator_id=review-version',
      method: 'GET',
    },
  ]);
  await assert.rejects(readSource(sourceClient(detail({ operator_id: 'different-version' })).client), {
    code: 'PROJECT_CHANGED',
    certainty: 'not_submitted',
  });
  await assert.rejects(
    readSource(
      sourceClient(detail(), (credentials) => {
        credentials.save({ ...session, accountRef: 'different-account' });
      }).client,
    ),
    { code: 'ACCOUNT_MISMATCH' },
  );
});

test('frontend source does not discard nondefault or malformed editor and retarget metadata', async () => {
  for (const metadata of [
    { future_editor_field: {} },
    { transform_matrix: [1, 0, 0, 0] },
    { children_deleted: [1] },
    { children_rename: { mesh: 1 } },
    { material_factor: { metallic: 1.3, roughness: 0.5 } },
  ]) {
    const value = sourceClient(detail({ metadata }));
    await assert.rejects(readSource(value.client), { code: 'FRONTEND_SOURCE_UNSUPPORTED' });
    assert.equal(value.requests.length, 1);
  }
  for (const metadata of ['unsupported', [], 0])
    await assert.rejects(readSource(sourceClient(detail({ metadata })).client), { code: 'CONTRACT_CHANGED' });
  await assert.rejects(readSource(sourceClient(detail({ retarget: [{ animation_id: 'motion' }] })).client), {
    code: 'FRONTEND_SOURCE_UNSUPPORTED',
  });
  for (const retarget of [{ animation_id: 'motion' }, 'motion', 1])
    await assert.rejects(readSource(sourceClient(detail({ retarget })).client), { code: 'CONTRACT_CHANGED' });
});

test('frontend normalized animation decodes storage without changing time, interpolation or node transforms', async () => {
  const input = await modelBytes(true),
    before = await readFrontendDocument(input);
  const normalized = await normalizeFrontendAnimation(input),
    after = await readFrontendDocument(normalized.bytes);
  const oldSampler = before.getRoot().listAnimations()[0]!.listSamplers()[0]!;
  const newSampler = after.getRoot().listAnimations()[0]!.listSamplers()[0]!;
  assert.equal(normalized.proof.changed_accessors, 1);
  assert.equal(newSampler.getOutput()!.getComponentType(), 5126);
  assert.equal(newSampler.getOutput()!.getNormalized(), false);
  assert.deepEqual([...newSampler.getInput()!.getArray()!], [...oldSampler.getInput()!.getArray()!]);
  assert.equal(newSampler.getInterpolation(), oldSampler.getInterpolation());
  for (let index = 0; index < oldSampler.getOutput()!.getCount(); index++) {
    const expected = oldSampler.getOutput()!.getElement(index, []);
    const actual = newSampler.getOutput()!.getElement(index, []);
    assert.ok(actual.every((value, axis) => Math.abs(value - expected[axis]!) < 0.0000001));
  }
  assert.deepEqual(after.getRoot().listNodes()[0]!.getMatrix(), before.getRoot().listNodes()[0]!.getMatrix());
  const staticInput = await modelBytes();
  const staticOutput = await normalizeFrontendAnimation(staticInput);
  assert.equal(staticOutput.proof.changed_accessors, 0);
  assert.ok(staticOutput.bytes.equals(staticInput));
});

test('frontend byte checks reject short headers and nonfinite accessors with structured errors', async () => {
  for (const size of [0, 4, 12, 15, 19])
    assert.throws(
      () => validateFrontendGlb(Buffer.alloc(size)),
      (error: unknown) => error instanceof TripoError,
    );
  await assert.rejects(readFrontendDocument(await modelBytes(false, true)), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
});

test('pinned runtime downloads use exact public URLs without credentials and reject redirect or oversized data', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tripo-frontend-review-'));
  try {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    await assert.rejects(
      loadStudioAssimpAssets({ dataDir: directory }, async (url, init) => {
        requests.push({ url, init });
        return new Response(null, {
          status: 302,
          headers: { location: 'https://untrusted.invalid/runtime.js' },
        });
      }),
      { code: 'FRONTEND_RUNTIME_DOWNLOAD' },
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, 'https://studio.tripo3d.ai/_assimp/wasm/' + studioAssimpFiles.glue.name);
    assert.equal(requests[0]!.init.redirect, 'error');
    assert.equal(requests[0]!.init.headers, undefined);
    await assert.rejects(
      loadStudioAssimpAssets(
        { dataDir: directory },
        async () => new Response(new Uint8Array(studioAssimpFiles.glue.bytes + 1)),
      ),
      { code: 'FRONTEND_RUNTIME_INTEGRITY' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime cache tampering and directory escapes are rejected without a download fallback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tripo-frontend-review-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'tripo-frontend-outside-'));
  let calls = 0;
  const forbiddenFetch = async () => {
    calls++;
    throw Error('Network must not be reached');
  };
  try {
    await writeFile(
      path.join(directory, studioAssimpFiles.glue.name),
      Buffer.alloc(studioAssimpFiles.glue.bytes),
    );
    await assert.rejects(
      loadStudioAssimpAssets({ dataDir: directory, runtimeDir: directory }, forbiddenFetch),
      {
        code: 'FRONTEND_RUNTIME_INTEGRITY',
      },
    );
    const root = path.join(directory, 'cache');
    await mkdir(root);
    await symlink(outside, path.join(root, 'studio-frontend'));
    await assert.rejects(loadStudioAssimpAssets({ dataDir: root }, forbiddenFetch), {
      code: 'FRONTEND_RUNTIME_PATH',
    });
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const metadata = { forward_axis: '-y', pivot_to_center_bottom: true } as const;
const fixtureConversion = (bytes: Buffer, source = bytes, diagnostic: Record<string, unknown> = {}) => ({
  bytes,
  proof: { source_sha256: hash(source), output_sha256: hash(bytes), metadata, ...diagnostic },
});
const receipt = () => ({
  remote_ids: { project_id: 'review-project', operator_id: 'review-version' },
  status: { state: 'succeeded' as const, progress: 100, artifacts: [] },
});
async function frontendFixture() {
  const f = await fixture(),
    bytes = await modelBytes(),
    counts = { source: 0, read: 0, convert: 0 };
  const client = sourceClient(detail()).client;
  const source = {
    url: 'https://cdn.tripo3d.ai/exact.glb?signature=signed-only-value',
    name: 'Frozen name',
    metadata: {},
  };
  const runtime: FrontendExportRuntime = {
    source: async () => {
      counts.source++;
      return source;
    },
    read: async () => {
      counts.read++;
      return bytes;
    },
    convert: async () => {
      counts.convert++;
      return fixtureConversion(bytes, bytes, { independent_fixture: true });
    },
  };
  const input = {
    project_id: 'review-project',
    operator_id: 'review-version',
    request_id: 'independent-review',
    destination_path: path.join(f.dir, 'output', 'first.glb'),
    ...metadata,
    max_credits: 10,
  };
  f.gateway.submit = async () => {
    f.gateway.posts++;
    if (f.gateway.failSubmit) throw f.gateway.failSubmit;
    return receipt();
  };
  const run = (changes: Record<string, unknown> = {}) =>
    exportFrontend(f.service, client, { ...input, ...changes }, runtime);
  const cached = path.join(f.dir, 'verified-output-cache', hash('test-account'), hash(bytes) + '.glb');
  const cleanup = async () => {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  };
  return { ...f, client, source, runtime, counts, bytes, input, cached, run, cleanup };
}
function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function absent(file: string): Promise<void> {
  await assert.rejects(lstat(file), { code: 'ENOENT' });
}

test('standalone frontend recovery reuses its exact verified destination without upstream or rewriting', async () => {
  const f = await frontendFixture();
  try {
    const first = await f.run();
    const originalStat = await lstat(f.input.destination_path),
      counts = { ...f.counts };
    f.runtime.source =
      f.runtime.read =
      f.runtime.convert =
        async () => {
          throw Error('Recovery must remain local');
        };
    f.gateway.submit = async () => {
      throw Error('Recovery must not submit again');
    };
    const second = await f.run();
    assert.equal(second.job_id, first.job_id);
    assert.equal(second.sha256, first.sha256);
    assert.deepEqual(f.counts, counts);
    const after = await lstat(f.input.destination_path);
    for (const key of ['ino', 'dev', 'size', 'mtimeMs', 'ctimeMs'] as const)
      assert.equal(after[key], originalStat[key]);
    f.service.config.outputDir = '';
    const alias = path.join(f.dir, 'output-alias');
    await symlink(path.dirname(f.input.destination_path), alias);
    assert.equal((await f.run({ destination_path: path.join(alias, 'first.glb') })).sha256, first.sha256);
    assert.equal(f.jobs.list('test-account').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('standalone frontend recovery rejects another existing copy, changed intent and corrupted original', async () => {
  const f = await frontendFixture();
  try {
    await f.run();
    const other = path.join(f.dir, 'output', 'other.glb');
    await writeFile(other, f.bytes);
    const counts = { ...f.counts };
    await assert.rejects(f.run({ destination_path: other }), { code: 'OUTPUT_EXISTS' });
    await assert.rejects(f.run({ name: 'changed-intent' }), { code: 'IDEMPOTENCY_CONFLICT' });
    await writeFile(f.input.destination_path, Buffer.from('corrupt'));
    await assert.rejects(f.run(), { code: 'OUTPUT_EXISTS' });
    await rm(f.input.destination_path);
    await symlink(other, f.input.destination_path);
    await assert.rejects(f.run(), { code: 'OUTPUT_EXISTS' });
    assert.deepEqual(f.counts, counts);
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.jobs.list('test-account').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('frontend recovery freezes conversion bytes, name and authorization while allowing another destination', async () => {
  const f = await frontendFixture();
  try {
    const first = await f.run(),
      secondPath = path.join(f.dir, 'caller-selected.glb');
    assert.equal(typeof first.export_lite_job_id, 'string');
    assert.equal(
      first.export_lite_job_id,
      f.jobs.find('test-account', 'frontend-export:independent-review')!.job_id,
    );
    assert.equal(first.sha256, hash(f.bytes));
    assert.deepEqual(await readFile(f.input.destination_path), f.bytes);
    f.source.name = 'Changed source name after authorization';
    f.source.url = 'https://cdn.tripo3d.ai/changed-after-authorization.glb';
    f.service.config.outputDir = '';
    const second = await f.run({
      destination_path: secondPath,
      max_credits: 0,
      runtime_dir: '/unused-on-recovery',
    });
    assert.equal(second.export_lite_job_id, first.export_lite_job_id);
    assert.deepEqual(await readFile(secondPath), f.bytes);
    assert.deepEqual(f.counts, { source: 2, read: 1, convert: 1 });
    assert.equal(f.gateway.posts, 1);
    const proof = f.jobs.requestPolicy('test-account', 'frontend-export-proof:independent-review')!;
    assert.equal(proof.name, 'Frozen name');
    assert.equal(proof.output_sha256, hash(f.bytes));
    assert.ok(!JSON.stringify(proof).includes('signed-only-value'));
    assert.ok(!JSON.stringify(proof).includes(f.cached));
    assert.deepEqual(await readFile(f.cached), f.bytes);
  } finally {
    await f.cleanup();
  }
});

test('two SQLite connections share one frontend authorization and recover only after its receipt', async () => {
  const f = await frontendFixture(),
    other = await fixture(f.dir);
  const entered = barrier(),
    release = barrier();
  f.gateway.submit = async () => {
    f.gateway.posts++;
    entered.resolve();
    await release.promise;
    return receipt();
  };
  let pending: Promise<Record<string, unknown>> | undefined;
  try {
    pending = f.run();
    await entered.promise;
    const secondPath = path.join(f.dir, 'output', 'second-connection.glb');
    await assert.rejects(
      exportFrontend(other.service, f.client, { ...f.input, destination_path: secondPath }, f.runtime),
      {
        code: 'FRONTEND_AUTHORIZATION_INCOMPLETE',
        certainty: 'read',
      },
    );
    await absent(secondPath);
    assert.equal(f.gateway.posts + other.gateway.posts, 1);
    release.resolve();
    const first = await pending;
    const second = await exportFrontend(
      other.service,
      f.client,
      { ...f.input, destination_path: secondPath },
      f.runtime,
    );
    assert.equal(second.export_lite_job_id, first.export_lite_job_id);
    assert.deepEqual(await readFile(secondPath), f.bytes);
    assert.equal(f.gateway.posts + other.gateway.posts, 1);
    assert.deepEqual(f.counts, { source: 2, read: 1, convert: 1 });
  } finally {
    release.resolve();
    await pending?.catch(() => undefined);
    other.jobs.close();
    await f.cleanup();
  }
});

test('concurrent preparations with identical bytes retain the first proof and authorize once', async () => {
  const f = await frontendFixture(),
    other = await fixture(f.dir);
  const bothConverting = barrier(),
    release = barrier();
  let conversions = 0;
  f.runtime.convert = async () => {
    const ordinal = ++conversions;
    if (ordinal === 2) bothConverting.resolve();
    await release.promise;
    return fixtureConversion(f.bytes, f.bytes, { diagnostic_ordinal: ordinal });
  };
  other.gateway.submit = async () => {
    other.gateway.posts++;
    return receipt();
  };
  let pending: Promise<Record<string, unknown>[]> | undefined;
  try {
    pending = Promise.all([
      f.run(),
      exportFrontend(
        other.service,
        f.client,
        { ...f.input, destination_path: path.join(f.dir, 'output', 'concurrent.glb') },
        f.runtime,
      ),
    ]);
    await bothConverting.promise;
    release.resolve();
    const [a, b] = await pending;
    assert.equal(typeof a!.export_lite_job_id, 'string');
    assert.equal(a!.export_lite_job_id, b!.export_lite_job_id);
    assert.deepEqual(a!.conversion, b!.conversion);
    assert.equal(f.gateway.posts + other.gateway.posts, 1);
    assert.equal(conversions, 2);
  } finally {
    release.resolve();
    await pending?.catch(() => undefined);
    other.jobs.close();
    await f.cleanup();
  }
});

test('a losing concurrent preparation cannot replace frozen output bytes or reuse their authorization', async () => {
  const f = await frontendFixture(),
    other = await fixture(f.dir);
  const firstConverting = barrier(),
    bothConverting = barrier(),
    firstRelease = barrier(),
    secondRelease = barrier();
  let conversions = 0;
  f.runtime.convert = async () => {
    const ordinal = ++conversions;
    if (ordinal === 1) firstConverting.resolve();
    if (ordinal === 2) bothConverting.resolve();
    await (ordinal === 1 ? firstRelease.promise : secondRelease.promise);
    return fixtureConversion(
      ordinal === 1 ? f.bytes : Buffer.concat([f.bytes, Buffer.from('different')]),
      f.bytes,
    );
  };
  let first: Promise<Record<string, unknown>> | undefined,
    second: Promise<Record<string, unknown>> | undefined;
  try {
    first = f.run();
    await firstConverting.promise;
    second = exportFrontend(
      other.service,
      f.client,
      { ...f.input, destination_path: path.join(f.dir, 'output', 'loser.glb') },
      f.runtime,
    );
    const secondResult = second.then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error }),
    );
    await bothConverting.promise;
    firstRelease.resolve();
    await first;
    secondRelease.resolve();
    const result = await secondResult;
    assert.equal((result.error as TripoError).code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(
      f.jobs.requestPolicy('test-account', 'frontend-export-proof:independent-review')!.output_sha256,
      hash(f.bytes),
    );
    assert.equal(f.gateway.posts + other.gateway.posts, 1);
    await absent(path.join(f.dir, 'output', 'loser.glb'));
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    await Promise.allSettled([first, second]);
    other.jobs.close();
    await f.cleanup();
  }
});

test('unknown frontend authorization survives retry without reconversion, resubmission or publication', async () => {
  const f = await frontendFixture();
  try {
    f.gateway.failSubmit = new TripoError('RECEIPT_LOST', 'Independent unknown receipt fixture.', 'unknown');
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(f.run(), { code: 'FRONTEND_AUTHORIZATION_INCOMPLETE', certainty: 'unknown' });
    assert.equal(f.jobs.find('test-account', 'frontend-export:independent-review')?.state, 'outcome_unknown');
    assert.equal(f.gateway.posts, 1);
    assert.deepEqual(f.counts, { source: 2, read: 1, convert: 1 });
    await absent(f.input.destination_path);
    assert.deepEqual(await readFile(f.cached), f.bytes);
  } finally {
    await f.cleanup();
  }
});

test('same-version source mutation is rejected before authorization while signed-URL rotation is allowed', async () => {
  for (const change of ['metadata', 'path', 'business-query', 'signature']) {
    const f = await frontendFixture();
    try {
      const originalSource = f.runtime.source!;
      f.runtime.source = async (...args) => {
        const value = await originalSource(...args);
        if (f.counts.source < 2) return value;
        return change === 'metadata'
          ? { ...value, metadata: { children_deleted: ['triangle'] } }
          : {
              ...value,
              url:
                change === 'path'
                  ? 'https://cdn.tripo3d.ai/replacement.glb'
                  : change === 'business-query'
                    ? 'https://cdn.tripo3d.ai/exact.glb?variant=different-model&signature=new-signature'
                    : 'https://cdn.tripo3d.ai/exact.glb?signature=new-signature',
            };
      };
      if (change === 'signature') {
        await f.run();
        assert.equal(f.gateway.posts, 1);
      } else {
        await assert.rejects(f.run(), { code: 'PROJECT_CHANGED', certainty: 'not_submitted' });
        assert.equal(f.gateway.posts, 0);
        await absent(f.input.destination_path);
      }
    } finally {
      await f.cleanup();
    }
  }
});

test('account switches during conversion or after authorization prevent publication', async () => {
  for (const when of ['conversion', 'authorization']) {
    const f = await frontendFixture();
    try {
      const switchAccount = () =>
        f.service.credentials.save({ ...f.service.credentials.load()!, accountRef: 'switched-account' });
      if (when === 'conversion') {
        const convert = f.runtime.convert!;
        f.runtime.convert = async (...args) => {
          const result = await convert(...args);
          switchAccount();
          return result;
        };
      } else
        f.gateway.submit = async () => {
          f.gateway.posts++;
          switchAccount();
          return receipt();
        };
      await assert.rejects(f.run(), { code: 'ACCOUNT_MISMATCH' });
      await absent(f.input.destination_path);
      assert.equal(f.gateway.posts, when === 'conversion' ? 0 : 1);
      assert.equal(
        Boolean(f.jobs.requestPolicy('test-account', 'frontend-export-proof:independent-review')),
        when === 'authorization',
      );
    } finally {
      await f.cleanup();
    }
  }
});

test('replacing the output directory during conversion or authorization cannot redirect publication', async () => {
  for (const when of ['conversion', 'authorization']) {
    const f = await frontendFixture();
    try {
      const outside = path.join(f.dir, 'outside-configured-root');
      await mkdir(outside);
      const replaceDirectory = async () => {
        await rename(f.service.config.outputDir, path.join(f.dir, 'original-output-directory'));
        await symlink(outside, f.service.config.outputDir);
      };
      if (when === 'conversion') {
        const convert = f.runtime.convert!;
        f.runtime.convert = async (...args) => {
          const result = await convert(...args);
          await replaceDirectory();
          return result;
        };
      } else
        f.gateway.submit = async () => {
          f.gateway.posts++;
          await replaceDirectory();
          return receipt();
        };
      await assert.rejects(f.run(), { code: 'OUTPUT_PATH_DENIED' });
      assert.equal(f.gateway.posts, when === 'conversion' ? 0 : 1);
      await absent(path.join(outside, 'first.glb'));
      await absent(path.join(f.dir, 'original-output-directory', 'first.glb'));
    } finally {
      await f.cleanup();
    }
  }
});

test('missing, corrupt or symlinked frontend cache cannot trigger recomputation or a second authorization', async () => {
  for (const mutation of ['missing', 'corrupt', 'file-link', 'bucket-link']) {
    const f = await frontendFixture();
    try {
      await f.run();
      const target = path.join(f.dir, 'output', 'after-tampering.glb');
      if (mutation === 'missing') await rm(f.cached);
      if (mutation === 'corrupt') {
        const bytes = Buffer.from(f.bytes);
        bytes[bytes.length - 1]! ^= 1;
        await writeFile(f.cached, bytes);
      }
      if (mutation === 'file-link') {
        await rm(f.cached);
        await symlink(f.input.destination_path, f.cached);
      }
      if (mutation === 'bucket-link') {
        const moved = path.join(f.dir, 'moved-cache');
        await rename(path.dirname(f.cached), moved);
        await symlink(moved, path.dirname(f.cached));
      }
      await assert.rejects(f.run({ destination_path: target }), {
        code: mutation === 'bucket-link' ? 'VERIFIED_CACHE_PATH_DENIED' : 'FRONTEND_CACHE_MISSING',
      });
      assert.equal(f.gateway.posts, 1);
      assert.deepEqual(f.counts, { source: 2, read: 1, convert: 1 });
      await absent(target);
    } finally {
      await f.cleanup();
    }
  }
});

test('frontend intent mismatch, preexisting authorization, invalid paths and names fail before side effects', async () => {
  const f = await frontendFixture();
  try {
    for (const changes of [
      { destination_path: path.join(f.dir, 'wrong.fbx') },
      { name: '../unsafe' },
      { name: 'control\u007f' },
      { forward_axis: '+z' },
      { pivot_to_center_bottom: 'false' },
    ])
      await assert.rejects(f.run(changes));
    assert.deepEqual(f.counts, { source: 0, read: 0, convert: 0 });
    await f.run();
    for (const changes of [
      { project_id: 'different-project' },
      { operator_id: 'different-version' },
      { name: 'different-name' },
      { forward_axis: '+y' },
      { pivot_to_center_bottom: false },
    ])
      await assert.rejects(
        f.run({ destination_path: path.join(f.dir, 'output', 'changed.glb'), ...changes }),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
    await assert.rejects(f.run({ request_id: 'another-request' }), { code: 'OUTPUT_EXISTS' });
    f.jobs.prepare('test-account', 'frontend-export:already-authorized', 'export_lite', {}, quote);
    await assert.rejects(
      f.run({
        request_id: 'already-authorized',
        destination_path: path.join(f.dir, 'output', 'already-authorized.glb'),
      }),
      {
        code: 'IDEMPOTENCY_CONFLICT',
      },
    );
    assert.equal(f.gateway.posts, 1);
    assert.deepEqual(f.counts, { source: 2, read: 1, convert: 1 });
  } finally {
    await f.cleanup();
  }
});

test('a successful frontend receipt for another version never publishes a file', async () => {
  const f = await frontendFixture();
  try {
    f.gateway.submit = async () => {
      f.gateway.posts++;
      return { ...receipt(), remote_ids: { project_id: 'review-project', operator_id: 'wrong-version' } };
    };
    await assert.rejects(f.run(), { code: 'CONTRACT_CHANGED' });
    await assert.rejects(f.run(), { code: 'CONTRACT_CHANGED' });
    assert.equal(f.gateway.posts, 1);
    await absent(f.input.destination_path);
  } finally {
    await f.cleanup();
  }
});

async function transformedOutput(source: Buffer): Promise<Document> {
  const doc = await new NodeIO().readBinary(source),
    scene = doc.getRoot().listScenes()[0]!;
  const root = doc.createNode('FrontendRoot'),
    transform = mat4.create();
  mat4.rotateY(transform, transform, -Math.PI / 2);
  mat4.translate(transform, transform, [-0.5, 0, 0]);
  root.setMatrix(Array.from(transform) as Parameters<typeof root.setMatrix>[0]);
  for (const node of scene.listChildren()) {
    scene.removeChild(node);
    root.addChild(node);
  }
  scene.addChild(root);
  return doc;
}

test('frontend preservation proof rejects extra unnamed output geometry', async () => {
  const source = await modelBytes(),
    output = await transformedOutput(source),
    io = new NodeIO();
  await verifyStudioFrontend(source, Buffer.from(await io.writeBinary(output)), metadata);
  output
    .getRoot()
    .listScenes()[0]!
    .addChild(output.createNode().setMesh(output.getRoot().listMeshes()[0]!).setTranslation([100, 0, 0]));
  await assert.rejects(verifyStudioFrontend(source, Buffer.from(await io.writeBinary(output)), metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
});

test('frontend metadata and binary chunk extensions cannot be silently discarded', async () => {
  const source = await modelBytes(),
    io = new NodeIO(),
    doc = await io.readBinary(source);
  doc.getRoot().listNodes()[0]!.setExtras({ authored_property: 'must survive' });
  await assert.rejects(normalizeFrontendAnimation(Buffer.from(await io.writeBinary(doc))), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
  const extraChunk = Buffer.alloc(12);
  extraChunk.writeUInt32LE(4, 0);
  extraChunk.write('TEST', 4);
  const withChunk = Buffer.concat([source, extraChunk]);
  withChunk.writeUInt32LE(withChunk.length, 8);
  assert.throws(() => validateFrontendGlb(withChunk), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
});

test('frontend proof rejects nonfinite rotations, nonunit quaternions, changed time and dropped clips', async () => {
  const source = await modelBytes(true),
    io = new NodeIO();
  for (const mutation of ['nonfinite', 'nonunit', 'time', 'clip']) {
    const output = await transformedOutput(source),
      animation = output.getRoot().listAnimations()[0]!;
    const sampler = animation.listSamplers()[0]!;
    if (mutation === 'clip') animation.dispose();
    else if (mutation === 'time') sampler.getInput()!.setArray(new Float32Array([0, 3]));
    else
      sampler
        .getOutput()!
        .setNormalized(false)
        .setArray(
          new Float32Array([mutation === 'nonfinite' ? NaN : 2, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2]),
        );
    await assert.rejects(verifyStudioFrontend(source, Buffer.from(await io.writeBinary(output)), metadata), {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    });
  }
});

test('rest restoration isolates a new constant channel from a shared original sampler', async () => {
  const io = new NodeIO(),
    source = await io.readBinary(await modelBytes()),
    buffer = source.getRoot().listBuffers()[0]!;
  const resting = source.createNode('resting').setRotation([0, 0.0001, 0, Math.sqrt(1 - 0.0001 ** 2)]);
  source.getRoot().listScenes()[0]!.addChild(resting);
  const times = source
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Float32Array([0, 2]))
    .setBuffer(buffer);
  const values = source
    .createAccessor()
    .setType('VEC4')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]))
    .setBuffer(buffer);
  const sampler = source.createAnimationSampler().setInput(times).setOutput(values);
  const channel = source
    .createAnimationChannel()
    .setTargetNode(source.getRoot().listNodes()[0]!)
    .setTargetPath('rotation')
    .setSampler(sampler);
  source.createAnimation('shared').addSampler(sampler).addChannel(channel);
  const sourceBytes = Buffer.from(await io.writeBinary(source)),
    output = await io.readBinary(sourceBytes);
  const animation = output.getRoot().listAnimations()[0]!,
    outputRest = output
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === 'resting')!;
  outputRest.setRotation([0, 0, 0, 1]);
  animation.addChannel(
    output
      .createAnimationChannel()
      .setTargetNode(outputRest)
      .setTargetPath('rotation')
      .setSampler(animation.listSamplers()[0]!),
  );
  const restored = await restoreFrontendDefaults(sourceBytes, Buffer.from(await io.writeBinary(output)));
  const result = await io.readBinary(restored.bytes),
    channels = result.getRoot().listAnimations()[0]!.listChannels();
  assert.equal(restored.proof.restored_constant_tracks, 1);
  assert.deepEqual([...channels[0]!.getSampler()!.getOutput()!.getArray()!], [0, 0, 0, 1, 0, 0, 0, 1]);
  assert.notEqual(channels[0]!.getSampler(), channels[1]!.getSampler());
  assert.ok(Math.abs(channels[1]!.getSampler()!.getOutput()!.getElement(0, [])[1]! - 0.0001) < 1e-10);
});

function rewriteGlbJson(bytes: Buffer, update: (json: Record<string, unknown>) => void): Buffer {
  const length = bytes.readUInt32LE(12),
    json = JSON.parse(bytes.toString('utf8', 20, 20 + length)) as Record<string, unknown>;
  update(json);
  const content = Buffer.from(JSON.stringify(json)),
    padding = Buffer.alloc((4 - (content.length % 4)) % 4, 0x20);
  const header = Buffer.from(bytes.subarray(0, 20)),
    binary = bytes.subarray(20 + length);
  header.writeUInt32LE(content.length + padding.length, 12);
  header.writeUInt32LE(20 + content.length + padding.length + binary.length, 8);
  return Buffer.concat([header, content, padding, binary]);
}

test('normalized animation rewrite preserves tiny source TRS fields exactly in GLB JSON', async () => {
  const trs = {
    translation: [1e-9, 2e-9, 3e-9],
    rotation: [0, 1e-7, 0, Math.sqrt(1 - 1e-14)],
    scale: [1 + 1e-10, 1, 1],
  };
  const source = rewriteGlbJson(await modelBytes(true), (json) => {
    Object.assign((json.nodes as Array<Record<string, unknown>>)[0]!, trs);
  });
  const result = await normalizeFrontendAnimation(source);
  const output = JSON.parse(result.bytes.toString('utf8', 20, 20 + result.bytes.readUInt32LE(12))) as {
    nodes: Array<Record<string, unknown>>;
  };
  for (const key of Object.keys(trs)) assert.deepEqual(output.nodes[0]![key], trs[key as keyof typeof trs]);
  assert.equal(result.proof.changed_accessors, 1);
});

test('rest restoration preserves original STEP interpolation with exact samples and times', async () => {
  const io = new NodeIO(),
    source = await io.readBinary((await normalizeFrontendAnimation(await modelBytes(true))).bytes);
  source.getRoot().listAnimations()[0]!.listSamplers()[0]!.setInterpolation('STEP');
  const sourceBytes = Buffer.from(await io.writeBinary(source)),
    output = await io.readBinary(sourceBytes);
  output.getRoot().listAnimations()[0]!.listSamplers()[0]!.setInterpolation('LINEAR');
  const restored = await restoreFrontendDefaults(sourceBytes, Buffer.from(await io.writeBinary(output)));
  const result = (await io.readBinary(restored.bytes)).getRoot().listAnimations()[0]!.listSamplers()[0]!;
  const original = source.getRoot().listAnimations()[0]!.listSamplers()[0]!;
  assert.equal(restored.proof.restored_interpolations, 1);
  assert.equal(result.getInterpolation(), 'STEP');
  assert.deepEqual(result.getInput()!.getArray(), original.getInput()!.getArray());
  assert.deepEqual(result.getOutput()!.getArray(), original.getOutput()!.getArray());
});

test('frontend proof rejects additional scenes even when the expected scene is preserved', async () => {
  const source = await modelBytes(),
    output = await transformedOutput(source);
  output
    .createScene('extra-scene')
    .addChild(output.createNode('unverified-extra').setMesh(output.getRoot().listMeshes()[0]!));
  await assert.rejects(
    verifyStudioFrontend(source, Buffer.from(await new NodeIO().writeBinary(output)), metadata),
    {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    },
  );
});

test('frontend proof rejects preserved geometry detached from the output scene', async () => {
  const source = await modelBytes(),
    output = await transformedOutput(source),
    scene = output.getRoot().listScenes()[0]!;
  for (const node of scene.listChildren()) scene.removeChild(node);
  await assert.rejects(
    verifyStudioFrontend(source, Buffer.from(await new NodeIO().writeBinary(output)), metadata),
    {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    },
  );
});

test('added constant tracks preserve rest values and cannot lengthen the original clip', async () => {
  const source = await modelBytes(true),
    output = await transformedOutput(source),
    io = new NodeIO();
  const buffer = output.getRoot().listBuffers()[0]!,
    animation = output.getRoot().listAnimations()[0]!;
  const input = output
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Float32Array([0, 2]))
    .setBuffer(buffer);
  const values = output.createAccessor().setType('VEC3').setArray(new Float32Array(6)).setBuffer(buffer);
  const sampler = output.createAnimationSampler().setInput(input).setOutput(values);
  animation.addSampler(sampler).addChannel(
    output
      .createAnimationChannel()
      .setSampler(sampler)
      .setTargetPath('translation')
      .setTargetNode(
        output
          .getRoot()
          .listNodes()
          .find((node) => node.getName() === 'triangle')!,
      ),
  );
  await verifyStudioFrontend(source, Buffer.from(await io.writeBinary(output)), metadata);
  input.setArray(new Float32Array([0, 99]));
  await assert.rejects(verifyStudioFrontend(source, Buffer.from(await io.writeBinary(output)), metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
});
