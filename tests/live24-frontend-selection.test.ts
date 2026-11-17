/** 网页零独立动作选择必须显式保存，不能借默认值丢动作或在重入时改变选择。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fixture, tinyGlb } from './helpers.ts';
import { StudioClient } from '../studio/api/client.ts';
import { frontendExportSource } from '../studio/api/frontend-export-source.ts';
import {
  exportFrontend,
  frontendExportSchema,
  type FrontendExportRuntime,
} from '../cli/core/frontend-export.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import { object, text } from '../studio/contracts/errors.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const orientation = { forward_axis: '-y', pivot_to_center_bottom: true } as const;
const motion = [{ animation_id: 'separate-motion', url: 'https://cdn.tripo3d.ai/separate-motion.glb' }];
async function setup(retarget: unknown = []) {
  const f = await fixture(),
    bytes = tinyGlb(),
    detail: Record<string, unknown> = {
      id: 'selection-project',
      project_name: 'Exact main model',
      is_owner: true,
      model_url: 'https://cdn.tripo3d.ai/exact-main.glb',
      operator: { operator_id: 'selection-operator', status: 'success', metadata: {}, retarget },
    },
    requests: string[] = [],
    counts = { read: 0, convert: 0 };
  const client = new StudioClient(f.service.credentials, async (url, init) => {
    assert.equal(init.method, 'GET');
    requests.push(url);
    return Response.json({ code: 0, data: detail });
  });
  const input = {
    project_id: 'selection-project',
    operator_id: 'selection-operator',
    request_id: 'selection-intent',
    destination_path: path.join(f.dir, 'output', 'main.glb'),
    max_credits: 10,
    ...orientation,
  };
  const runtime: FrontendExportRuntime = {
    read: async (url) => {
      counts.read++;
      assert.equal(url, detail.model_url);
      return bytes;
    },
    convert: async (source) => {
      counts.convert++;
      assert.deepEqual(source, bytes);
      return {
        bytes,
        proof: { source_sha256: hash(bytes), output_sha256: hash(bytes), metadata: orientation },
      };
    },
  };
  f.gateway.submit = async () => {
    f.gateway.posts++;
    return {
      remote_ids: { project_id: input.project_id, operator_id: input.operator_id },
      status: { state: 'succeeded', progress: 100, artifacts: [] },
    };
  };
  const source = (selection: { exclude_retarget?: boolean } = {}) =>
    frontendExportSource(client, 'test-account', input.project_id, input.operator_id, selection);
  const run = (selection: Record<string, unknown> = {}) =>
    exportFrontend(f.service, client, { ...input, ...selection }, runtime);
  return { ...f, bytes, client, input, runtime, detail, requests, counts, source, run };
}
async function close(f: Awaited<ReturnType<typeof setup>>) {
  f.jobs.close();
  await rm(f.dir, { recursive: true, force: true });
}
function changeProof(f: Awaited<ReturnType<typeof setup>>, change: (proof: Record<string, unknown>) => void) {
  const key = `frontend-export-proof:${f.input.request_id}`,
    proof = f.jobs.requestPolicy('test-account', key)!;
  change(proof);
  const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
  try {
    db.prepare('UPDATE request_policies SET policy=? WHERE account_ref=? AND request_id=?').run(
      JSON.stringify(proof),
      'test-account',
      key,
    );
  } finally {
    db.close();
  }
}

test('selection is optional without a new default and accepts only explicit booleans', async () => {
  const f = await setup();
  try {
    assert.equal(Object.hasOwn(frontendExportSchema.parse(f.input), 'exclude_retarget'), false);
    for (const value of [true, false])
      assert.equal(
        frontendExportSchema.parse({ ...f.input, exclude_retarget: value }).exclude_retarget,
        value,
      );
    for (const value of ['true', 'false', null, 0, 1])
      assert.equal(frontendExportSchema.safeParse({ ...f.input, exclude_retarget: value }).success, false);
  } finally {
    await close(f);
  }
});

test('only explicit true selects the exact main model without separate retarget files', async () => {
  const f = await setup(motion);
  try {
    await assert.rejects(f.source(), { code: 'FRONTEND_SOURCE_UNSUPPORTED' });
    await assert.rejects(f.source({ exclude_retarget: false }), { code: 'FRONTEND_SOURCE_UNSUPPORTED' });
    const source = await f.source({ exclude_retarget: true });
    assert.equal(source.url, f.detail.model_url);
    assert.deepEqual(source.metadata, {});
    assert.equal(f.requests.length, 3);
    assert.ok(f.requests.every((url) => url.endsWith('/selection-project?operator_id=selection-operator')));
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('excluding retarget never bypasses malformed metadata, ownership, or unfinished source guards', async () => {
  const f = await setup(motion);
  try {
    for (const retarget of ['motion', 1, { animation_id: 'motion' }]) {
      object(f.detail.operator).retarget = retarget;
      await assert.rejects(f.source({ exclude_retarget: true }), { code: 'CONTRACT_CHANGED' });
    }
    object(f.detail.operator).retarget = motion;
    object(f.detail.operator).metadata = { children_deleted: [1] };
    await assert.rejects(f.source({ exclude_retarget: true }), { code: 'FRONTEND_SOURCE_UNSUPPORTED' });
    object(f.detail.operator).metadata = {};
    f.detail.is_owner = false;
    await assert.rejects(f.source({ exclude_retarget: true }), { code: 'OWNERSHIP_REQUIRED' });
    f.detail.is_owner = true;
    f.detail.running_operator = { operator_id: 'running' };
    await assert.rejects(f.source({ exclude_retarget: true }), { code: 'PROJECT_BUSY' });
    delete f.detail.running_operator;
    object(f.detail.operator).status = 'running';
    await assert.rejects(f.source({ exclude_retarget: true }), { code: 'ARTIFACT_NOT_READY' });
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('explicit selection reaches both source checks and survives a local restart with immutable intent', async () => {
  const f = await setup(motion);
  let restarted: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const result = await f.run({ exclude_retarget: true });
    assert.equal(object(result.motion_selection).exclude_retarget, true);
    assert.match(text(object(result.motion_selection).description), /skeletons and embedded clips/);
    assert.deepEqual(await readFile(f.input.destination_path), f.bytes);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.counts, { read: 1, convert: 1 });
    assert.equal(f.gateway.posts, 1);
    const proof = f.jobs.requestPolicy('test-account', `frontend-export-proof:${f.input.request_id}`)!;
    assert.equal(object(proof.input).exclude_retarget, true);
    assert.equal(proof.intent, fingerprint(proof.input));
    restarted = await fixture(f.dir);
    const forbidden = async (): Promise<never> => {
      throw Error('No upstream or conversion on recovery');
    };
    restarted.gateway.submit = forbidden;
    restarted.gateway.status = forbidden;
    restarted.gateway.artifactUrl = forbidden;
    const destination = path.join(f.dir, 'output', 'restarted.glb');
    const run = (changes: Record<string, unknown>) =>
      exportFrontend(
        restarted!.service,
        f.client,
        { ...f.input, destination_path: destination, ...changes },
        { source: forbidden, read: forbidden, convert: forbidden },
      );
    const recovered = await run({ exclude_retarget: true, runtime_dir: '/not-needed-after-authorization' });
    assert.equal(recovered.job_id, result.job_id);
    assert.deepEqual(await readFile(destination), f.bytes);
    await assert.rejects(run({}), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(run({ exclude_retarget: false }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(restarted.jobs.list('test-account').length, 1);
    assert.equal(f.requests.length, 2);
    changeProof(f, (value) => {
      object(value.input).exclude_retarget = false;
    });
    assert.equal((await restarted.service.get(text(result.job_id))).state, 'needs_attention');
    await assert.rejects(restarted.service.download(text(result.job_id), 'model', 'tampered.glb'), {
      code: 'FRONTEND_OUTPUT_IDENTITY_CHANGED',
    });
  } finally {
    restarted?.jobs.close();
    await close(f);
  }
});

test('default intent retains the old fingerprint and rejects newly appeared separate motions before authorization', async () => {
  const f = await setup();
  try {
    const original = f.runtime.convert!;
    f.runtime.convert = async (...args) => {
      const output = await original(...args);
      object(f.detail.operator).retarget = motion;
      return output;
    };
    await assert.rejects(f.run(), { code: 'FRONTEND_SOURCE_UNSUPPORTED' });
    assert.equal(f.requests.length, 2);
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.list('test-account').length, 0);
    const proof = f.jobs.requestPolicy('test-account', `frontend-export-proof:${f.input.request_id}`)!;
    assert.equal(Object.hasOwn(object(proof.input), 'exclude_retarget'), false);
    assert.equal(
      proof.intent,
      fingerprint({
        project_id: f.input.project_id,
        operator_id: f.input.operator_id,
        format: 'glb',
        ...orientation,
        name: null,
      }),
    );
    await assert.rejects(f.run({ exclude_retarget: true }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(f.requests.length, 2);
  } finally {
    await close(f);
  }
});

test('legacy no-selection proofs recover without inventing a new frozen default', async () => {
  const f = await setup();
  try {
    f.gateway.failSubmit = undefined;
    // 在首次授权前模拟旧证明形状；已绑定产物的证明仍禁止任何事后改写。
    await assert.rejects(
      exportFrontend(f.service, f.client, f.input, {
        ...f.runtime,
        validatePrepared: () => {
          throw Error('Pause before authorization');
        },
      }),
      /Pause before authorization/,
    );
    changeProof(f, (proof) => {
      proof.version = 1;
      delete proof.input;
      delete proof.source_is_pbr;
    });
    const recovered = await f.run();
    assert.equal(recovered.sha256, hash(f.bytes));
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.requests.length, 2);
    assert.equal(
      f.jobs.requestPolicy('test-account', `frontend-export-proof:${f.input.request_id}`)!.input,
      undefined,
    );
    await assert.rejects(f.run({ exclude_retarget: false }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(f.gateway.posts, 1);
  } finally {
    await close(f);
  }
});
