/** 独立恢复/交付边界审计；只用临时数据库、内存账号和原件缓存，不连接网络。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm, stat, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { fixture, quote } from './helpers.ts';
import { scaleModel } from './helpers-smartsegment-scale.ts';
import { prepareSegmentEntitySource } from '../cli/artifacts/segment-entity-source.ts';
import { saveVerifiedOutputCache } from '../cli/artifacts/verified-output-cache.ts';
import {
  segmentEntityMarker,
  segmentEntityPolicyKey,
  segmentEntityIntent,
  withSegmentEntityMarker,
  type SegmentEntityPolicy,
} from '../cli/core/segment-entity-policy.ts';
import { segmentResourceFingerprint } from '../studio/api/segment-entity-snapshot.ts';
import { operationSchemas } from '../studio/contracts/schemas.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import type { SubmissionOptions } from '../studio/api/segment-route.ts';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const account = 'test-account',
  request = 'recovery-entity-integration';
const rejected = (error: unknown): boolean =>
  ['SEGMENT_ENTITY_POLICY_CHANGED', 'SEGMENT_ENTITY_SOURCE_CHANGED', 'ACCOUNT_MISMATCH'].includes(
    String(object(error).code),
  );
async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (object(error).code === 'ENOENT') return false;
    throw error;
  }
}
async function setup(legacy = false) {
  const f = await fixture(),
    bytes = await scaleModel();
  f.service.config.outputDir = await realpath(f.service.config.outputDir);
  const input = operationSchemas.segment.parse({
    project_id: 'project',
    model_version: 'v2.0-20260430',
    segmentation_granularity: 'simple',
    prompt: 'original',
  });
  const url = 'https://cdn.tripo3d.ai/fixture/model.glb?part=original&X-Amz-Signature=synthetic-original',
    identity = { account_ref: account, project_id: 'project', operator_id: 'original-operator' },
    proof = await prepareSegmentEntitySource(bytes, identity, {}),
    policy: SegmentEntityPolicy = {
      version: 1,
      account_ref: account,
      request_id: request,
      intent: segmentEntityIntent(input),
      proof,
      resource_fingerprint: segmentResourceFingerprint(url),
      cache_data_dir: f.dir,
    },
    source = {
      ...identity,
      url,
      resource_fingerprint: policy.resource_fingerprint,
      format: 'glb',
      metadata: proof.metadata,
    };
  const cached = await saveVerifiedOutputCache(
    identity,
    { artifact_id: 'source', kind: 'model', format: 'glb', index: 0 },
    proof,
    bytes,
    f.dir,
  );
  if (!legacy)
    f.jobs.bindRequestPolicy(
      account,
      segmentEntityPolicyKey(request),
      policy as unknown as Record<string, unknown>,
    );
  const job = f.jobs.prepare(
      account,
      request,
      'segment',
      legacy ? input : withSegmentEntityMarker(input, policy),
      quote,
    ),
    native = path.join(f.dir, 'native.glb'),
    pngFile = path.join(f.dir, 'native.png'),
    png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#4269a8' } })
      .png()
      .toBuffer();
  await writeFile(native, bytes);
  await writeFile(pngFile, png);
  const model: Artifact = {
      artifact_id: 'model',
      kind: 'model',
      format: 'glb',
      index: 0,
      local_path: native,
      sha256: hash(bytes),
      bytes: bytes.length,
    },
    mask: Artifact = {
      artifact_id: 'semantic-mask',
      kind: 'image',
      format: 'png',
      index: 1,
      local_path: pngFile,
      sha256: hash(png),
      bytes: png.length,
    };
  const state = {
    sourceReads: 0,
    beforeSend: undefined as undefined | (() => Promise<void>),
    duringBudget: undefined as undefined | (() => Promise<void>),
    options: undefined as SubmissionOptions | undefined,
  };
  Object.assign(f.gateway, {
    async segmentEntitySource(selected: string) {
      assert.equal(selected, account);
      state.sourceReads++;
      return structuredClone(source);
    },
  });
  f.gateway.account = async () => {
    await state.duringBudget?.();
    return { authenticated: true, account_ref: account, balance: 100 };
  };
  f.gateway.submit = async (
    _job: Job,
    beforeSend: () => void = () => undefined,
    options?: SubmissionOptions,
  ) => {
    state.options = options;
    await state.beforeSend?.();
    beforeSend();
    f.gateway.posts++;
    return {
      remote_ids: { project_id: 'project', operator_id: 'result-operator' },
      status: { state: 'succeeded' as const, progress: 100, artifacts: [model, mask] },
    };
  };
  f.gateway.artifactUrl = async () => {
    throw new TripoError('NETWORK_ERROR', 'The original URL is unavailable in this offline fixture.', 'read');
  };
  f.gateway.status = async () => {
    throw Error('Completed exact local outputs need no remote poll.');
  };
  const mutate = (action: (db: DatabaseSync) => void): void => {
    const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
    try {
      action(db);
    } finally {
      db.close();
    }
  };
  const losePolicy = (): void =>
    mutate((db) => {
      db.prepare('DELETE FROM request_policies WHERE account_ref=? AND request_id=?').run(
        account,
        segmentEntityPolicyKey(request),
      );
    });
  const changeAccount = (): void =>
    f.service.credentials.save({ ...f.service.credentials.load()!, accountRef: 'different-account' });
  const complete = (): Job =>
    f.jobs.update(job.job_id, 'succeeded', {
      remote_ids: { project_id: 'project', operator_id: 'result-operator' },
      artifacts: [model, mask],
    });
  return {
    ...f,
    input,
    policy,
    source,
    cached,
    job,
    bytes,
    model,
    mask,
    state,
    mutate,
    losePolicy,
    changeAccount,
    complete,
    current: () => f.jobs.get(job.job_id),
    submit: () => f.service.submit('segment', request, input, 100),
    close: async () => {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    },
  };
}

test('legacy prepared requests keep their original route and receive no entity policy', async () => {
  const f = await setup(true);
  try {
    const result = await f.submit();
    assert.equal(result.state, 'succeeded');
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.state.sourceReads, 0);
    assert.equal(f.state.options, undefined);
    assert.equal(f.jobs.requestPolicy(account, segmentEntityPolicyKey(request)), undefined);
    assert.equal(f.current().input[segmentEntityMarker], undefined);
  } finally {
    await f.close();
  }
});
test('prepared entity request restores after URL renewal without changing original policy or identity', async () => {
  const f = await setup();
  try {
    f.source.url = f.source.url.replace('synthetic-original', 'synthetic-renewed');
    f.source.resource_fingerprint = segmentResourceFingerprint(f.source.url);
    const result = await f.submit();
    assert.equal(result.state, 'succeeded');
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.current().job_id, f.job.job_id);
    assert.equal(
      fingerprint(f.jobs.requestPolicy(account, segmentEntityPolicyKey(request))),
      fingerprint(f.policy),
    );
    assert.equal(f.state.options?.segmentRoute?.strategy, 'ordinary');
    assert.equal(f.state.sourceReads, 1);
  } finally {
    await f.close();
  }
});
for (const variant of ['policy', 'cache', 'account'] as const)
  test(`budget await cannot submit after ${variant} changes`, async () => {
    const f = await setup();
    try {
      f.state.duringBudget = async () => {
        if (variant === 'policy') f.losePolicy();
        if (variant === 'cache') await unlink(f.cached.local_path!);
        if (variant === 'account') f.changeAccount();
      };
      await assert.rejects(f.submit(), rejected);
      assert.equal(f.gateway.posts, 0);
      assert.equal(f.current().state, 'prepared');
      assert.equal(f.jobs.list(account, 20).length, 1);
    } finally {
      await f.close();
    }
  });
for (const variant of ['policy', 'account'] as const)
  test(`before-send callback prevents paid POST after ${variant} changes`, async () => {
    const f = await setup();
    try {
      f.state.beforeSend = async () => (variant === 'policy' ? f.losePolicy() : f.changeAccount());
      const response = await f.submit();
      assert.equal(response.state, 'failed');
      assert.equal(f.gateway.posts, 0);
      assert.equal(f.current().state, 'failed');
      assert.deepEqual(f.current().remote_ids, {});
    } finally {
      await f.close();
    }
  });

for (const variant of ['policy', 'marker-and-policy', 'request-and-marker-and-policy'] as const)
  test(`get/list/download preserve remote success while rejecting lost ${variant}`, async () => {
    const f = await setup();
    try {
      f.complete();
      f.losePolicy();
      if (variant !== 'policy')
        f.mutate((db) => {
          db.prepare('UPDATE jobs SET input=?,request_id=? WHERE job_id=?').run(
            JSON.stringify(f.input),
            variant.startsWith('request') ? 'different-request' : request,
            f.job.job_id,
          );
        });
      const got = await f.service.get(f.job.job_id),
        listed = f.service.list(20, 0).jobs as Record<string, unknown>[];
      assert.equal(got.state, 'needs_attention');
      assert.equal(got.remote_state, 'succeeded');
      assert.equal(listed[0]!.state, 'needs_attention');
      const target = path.join(f.service.config.outputDir, 'must-not-exist.glb');
      await assert.rejects(f.service.download(f.job.job_id, 'model', target), rejected);
      assert.equal(await exists(target), false);
      assert.equal(f.current().state, 'succeeded');
      assert.equal(f.gateway.posts, 0);
    } finally {
      await f.close();
    }
  });

test('final SQLite artifact transaction rejects a lost entity policy before binding a path', async () => {
  const f = await setup();
  try {
    f.complete();
    const original = f.current().artifacts;
    f.losePolicy();
    assert.throws(
      () => f.jobs.saveArtifact(f.job.job_id, { ...f.model, local_path: '/unpublished/result.glb' }),
      rejected,
    );
    assert.deepEqual(f.current().artifacts, original);
    assert.equal(f.current().state, 'succeeded');
  } finally {
    await f.close();
  }
});
for (const variant of ['policy', 'account', 'request'] as const)
  test(`download rechecks ${variant} after its original policy read`, async () => {
    const f = await setup();
    try {
      f.complete();
      let injected = false;
      const read = f.jobs.requestPolicy.bind(f.jobs);
      f.jobs.requestPolicy = (owner, key) => {
        const value = read(owner, key);
        if (key === segmentEntityPolicyKey(request) && !injected) {
          injected = true;
          queueMicrotask(() => {
            if (variant === 'policy') f.losePolicy();
            if (variant === 'account') f.changeAccount();
            if (variant === 'request')
              f.mutate((db) =>
                db
                  .prepare('UPDATE jobs SET request_id=? WHERE job_id=?')
                  .run('different-request', f.job.job_id),
              );
          });
        }
        return value;
      };
      const target = path.join(f.service.config.outputDir, 'race.glb');
      await assert.rejects(f.service.download(f.job.job_id, 'model', target), rejected);
      assert.equal(injected, true);
      assert.equal(await exists(target), false);
      assert.equal(f.gateway.posts, 0);
    } finally {
      await f.close();
    }
  });
test('same-path download cannot shortcut a changed policy or rewrite the original file', async () => {
  const f = await setup();
  try {
    f.complete();
    const target = path.join(f.service.config.outputDir, 'stable.glb');
    await f.service.download(f.job.job_id, 'model', target);
    const before = await stat(target),
      digest = hash(await readFile(target));
    f.losePolicy();
    await assert.rejects(f.service.download(f.job.job_id, 'model', target), rejected);
    const after = await stat(target);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(hash(await readFile(target)), digest);
  } finally {
    await f.close();
  }
});

for (const variant of ['policy', 'cache', 'account'] as const)
  test(`real StudioGateway and session refresh recheck ${variant} before the paid transport`, async () => {
    const f = await setup();
    try {
      let whoami = 0,
        paidPosts = 0;
      const jwt = (exp: number): string =>
        [
          'synthetic',
          Buffer.from(JSON.stringify({ sub: 'fixture-subject', exp })).toString('base64url'),
          'synthetic',
        ].join('.');
      const client = new StudioClient(f.service.credentials, async (url, init) => {
        if (url.includes('/project/detail/v3/')) {
          assert.equal(init.method, 'GET');
          f.service.credentials.save({ ...f.service.credentials.load()!, bearer: jwt(1) });
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                id: 'project',
                is_owner: true,
                model_url: f.source.url,
                operator: {
                  operator_id: 'original-operator',
                  status: 'success',
                  is_segmented: true,
                  is_rigged: false,
                  metadata: f.source.metadata,
                },
              },
            }),
          );
        }
        if (url.includes('/whoami')) {
          whoami++;
          await Promise.resolve();
          if (variant === 'policy') f.losePolicy();
          if (variant === 'cache') await unlink(f.cached.local_path!);
          if (variant === 'account') f.changeAccount();
          return new Response(
            JSON.stringify({ code: 0, data: { tokenized: jwt(Math.floor(Date.now() / 1000) + 3600) } }),
          );
        }
        if (init.method === 'POST') paidPosts++;
        throw Error('A paid transport must not be reached after the original binding changes.');
      });
      const gateway = new StudioGateway(client, [], new MemoryLinks());
      f.gateway.submit = (job, beforeSend?: () => void, options?: SubmissionOptions) =>
        gateway.submit(job, beforeSend, options);
      const response = await f.submit();
      assert.equal(response.state, 'failed');
      assert.equal(whoami, 1);
      assert.equal(paidPosts, 0);
      assert.deepEqual(f.current().remote_ids, {});
    } finally {
      await f.close();
    }
  });
