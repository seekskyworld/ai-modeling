import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile, copyFile, link, symlink, lstat, rename, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { executePlan, downloadTask } from '../cli/compat/runtime.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { freezeSmartSegmentScale, assertSmartSegmentLayouts } from '../cli/compat/smartsegment-scale.ts';
import { freezeSmartSegmentTransform } from '../cli/compat/smartsegment-transform.ts';
import { freezeSmartSegmentImage } from '../cli/compat/smartsegment-image.ts';
import { smartSegmentRotationZ90 } from '../cli/compat/smartsegment-transform-plan.ts';
import {
  scaleInputKey,
  scaleIntentKey,
  scaleSourceKey,
  scaleStepKey,
} from '../cli/core/smartsegment-scale-policy.ts';
import { smartSegmentTransformIntentKey } from '../cli/core/smartsegment-transform-policy.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';
import { scaleFixture, scaleMatrix } from './helpers-smartsegment-scale.ts';

test('file positive scales freeze a three-step native chain and verify no-download/get/list', async () => {
  const f = await scaleFixture();
  try {
    const result = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(result.status, 'success');
    assert.equal(f.gateway.posts, 3);
    assert.deepEqual(
      f.submissions.map((j) => j.operation),
      ['import_model', 'project_edit', 'segment'],
    );
    assert.deepEqual(
      f.submissions[0]!.input.transform_matrix,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    );
    assert.deepEqual(object(f.submissions[1]!.input.children_transform_matrix)['editable-mesh'], scaleMatrix);
    assert.equal(f.submissions[2]!.input.expected_operator_id, 'edit-one');
    assert.equal(object(result.smartsegment_transform_validation).status, 'verified');
    assert.equal(
      object((await f.service.get(f.modelJob().job_id)).smartsegment_transform_validation).status,
      'verified',
    );
    assert.equal(
      object(f.service.summary(f.modelJob()).smartsegment_transform_validation).status,
      'verified',
    );
    const reads = f.reads.length;
    await rm(f.input);
    await rm(f.native);
    await rm(f.output);
    const replay = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(replay.task_id, result.task_id);
    assert.equal(f.gateway.posts, 3);
    assert.equal(f.reads.length, reads);
  } finally {
    await f.close();
  }
});

test('an existing model copies its exact historical operator and preserves original metadata', async () => {
  const f = await scaleFixture({ reference: true });
  try {
    const before = structuredClone(f.originalMetadata());
    const result = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(result.status, 'success');
    assert.equal(f.submissions[0]!.operation, 'copy');
    assert.deepEqual(f.submissions[0]!.input, {
      project_id: 'original-project',
      operator_id: 'original-one',
    });
    assert.deepEqual(f.originalMetadata(), before);
    assert(f.reads[0]!.includes('?operator_id=original-one'));
    const reads = f.reads.length;
    f.setCurrent('unrelated-new-head');
    await rm(f.native);
    assert.equal((await executePlan(f.app, f.plan(), f.flags)).task_id, result.task_id);
    assert.equal(f.reads.length, reads);
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

test('an unapplied source delta blocks before creating the native copy', async () => {
  const f = await scaleFixture({ reference: true });
  try {
    f.states.set('original-one', {
      ...f.originalMetadata(),
      children_transform_matrix: { 'editable-mesh': scaleMatrix },
    });
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), { code: 'SMARTSEGMENT_SCALE_SOURCE_EDITED' });
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.find('test-account', 'metadata-scale-0'), undefined);
  } finally {
    await f.close();
  }
});

test('wrong native geometry remains remote success, needs_attention through get/list, and cannot download', async () => {
  const f = await scaleFixture({ wrongOutput: true });
  try {
    const result = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.remote_state, 'succeeded');
    assert.equal(f.modelJob().state, 'succeeded');
    assert.equal(f.service.summary(f.modelJob()).state, 'needs_attention');
    assert.equal((await f.service.get(f.modelJob().job_id)).state, 'needs_attention');
    assert.equal(f.service.summary(f.modelJob()).state, 'needs_attention');
    await assert.rejects(f.service.download(f.modelJob().job_id, 'model', 'wrong.glb'), {
      code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
    });
    assert.equal(f.gateway.posts, 3);
    await executePlan(f.app, f.plan(), f.flags);
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

const compound = [0, 1.3, 0, 0, -0.7, 0, 0, 0, 0, 0, 1.1, 0, 0.2, -0.3, 0.4, 1];
for (const reference of [false, true])
  test(`native ${reference ? 'copied' : 'imported'} material and web scalar defaults remain independently frozen`, async () => {
    const f = await scaleFixture({ reference, nativeRoughness: 0.899999976 });
    try {
      const result = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(result.status, 'success');
      const source = f.jobs.requestPolicy('test-account', scaleSourceKey('metadata-scale'))!;
      assert.equal(object(object(source.inspection).material_factors).roughness, 0.899999976);
      assert.deepEqual(f.submissions[1]!.input.material_factor, { metallic: 0, roughness: 0.5 });
      assert.equal((await executePlan(f.app, f.plan(), f.flags)).task_id, result.task_id);
      assert.equal(f.gateway.posts, 3);
    } finally {
      await f.close();
    }
  });
for (const reference of [false, true])
  test(`compound TRS ${reference ? 'task' : 'file'} preserves exact metadata and verifies physical geometry`, async () => {
    const f = await scaleFixture({ reference, matrix: compound });
    try {
      const first = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(first.status, 'success');
      assert.deepEqual(object(f.submissions[1]!.input.children_transform_matrix)['editable-mesh'], compound);
      assert.equal(object(first.smartsegment_transform_validation).matched_oriented_faces, 4);
      await rm(f.input);
      await rm(f.native);
      await rm(f.output);
      assert.equal((await executePlan(f.app, f.plan(), f.flags)).task_id, first.task_id);
      assert.equal(f.gateway.posts, 3);
    } finally {
      await f.close();
    }
  });

test('task Rz90 uses its own metadata chain and keeps original history', async () => {
  const f = await scaleFixture({ reference: true, matrix: smartSegmentRotationZ90 });
  try {
    const before = f.jobs.get(f.original.job_id);
    assert.equal((await executePlan(f.app, f.plan(), f.flags)).status, 'success');
    assert.deepEqual(
      f.submissions.map((job) => job.operation),
      ['copy', 'project_edit', 'segment'],
    );
    assert.deepEqual(f.jobs.get(f.original.job_id), before);
    assert.equal(
      f.jobs.requestPolicy('test-account', smartSegmentTransformIntentKey('metadata-scale')),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test('metadata URL is read once and original request survives source and input-cache removal', async () => {
  const f = await scaleFixture({ matrix: compound }),
    oldNoProxy = process.env.no_proxy;
  let gets = 0;
  const server = createServer((_request, response) => {
    gets++;
    response.end(f.sourceBytes);
  });
  process.env.no_proxy = '127.0.0.1';
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const plan = () =>
    processingPlan('smartsegment', `http://127.0.0.1:${address.port}/original.glb`, {
      param: { transform: compound, granularity: 'coarse', hint: 'head' },
    });
  try {
    const first = await executePlan(f.app, plan(), f.flags);
    assert.equal(first.status, 'success');
    assert.equal(gets, 1);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(path.join(f.dir, 'input-cache'), { recursive: true, force: true });
    await rm(f.input);
    assert.equal((await executePlan(f.app, plan(), f.flags)).task_id, first.task_id);
    assert.equal(gets, 1);
    assert.equal(f.gateway.posts, 3);
  } finally {
    server.close();
    if (oldNoProxy === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = oldNoProxy;
    await f.close();
  }
});

test('only registered original delivery nodes can be reused across directories', async () => {
  const f = await scaleFixture();
  try {
    await executePlan(f.app, f.plan(), f.flags);
    const job = f.modelJob();
    const a = String((await f.service.download(job.job_id, 'model', 'a.glb')).local_path);
    const original = await lstat(a);
    await f.service.download(job.job_id, 'model', 'b.glb');
    await f.service.download(job.job_id, 'model', 'a.glb');
    assert.equal((await lstat(a)).ino, original.ino);
    assert.equal((await lstat(a)).mtimeMs, original.mtimeMs);
    for (const [name, create] of [
      ['copy', copyFile],
      ['hardlink', link],
      ['symlink', symlink],
    ] as const) {
      const target = path.join(f.dir, 'output', name + '.glb');
      await create(a, target);
      await assert.rejects(f.service.download(job.job_id, 'model', target), {
        code: 'OUTPUT_EXISTS',
      });
    }
    await rename(a, a + '.original');
    await copyFile(a + '.original', a);
    await assert.rejects(f.service.download(job.job_id, 'model', 'a.glb'), { code: 'OUTPUT_EXISTS' });
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

for (const changed of ['source-cache', 'delivery-inode'])
  test(`task download cannot bypass ${changed} through the same-path shortcut`, async () => {
    const f = await scaleFixture();
    try {
      f.service.config.outputDir = await realpath(f.service.config.outputDir);
      await executePlan(f.app, f.plan(), f.flags);
      const saved = await f.service.download(f.modelJob().job_id, 'model', 'same/model.glb');
      const file = String(saved.local_path),
        job = f.modelJob();
      const view = { ...job, artifacts: job.artifacts.filter((a) => a.kind === 'model') };
      if (changed === 'source-cache') {
        const source = f.jobs.requestPolicy('test-account', scaleSourceKey('metadata-scale'))!;
        await rm(String(object(source.parameters).model_path));
      } else {
        await rename(file, file + '.original');
        await copyFile(file + '.original', file);
      }
      await assert.rejects(downloadTask(f.app, view, { out: path.dirname(file) }), {
        code: changed === 'source-cache' ? 'SMARTSEGMENT_SCALE_SOURCE_MISSING' : 'OUTPUT_EXISTS',
      });
      assert.equal(f.gateway.posts, 3);
    } finally {
      await f.close();
    }
  });

test('verified original bytes recover into two destinations and original path without a new submission', async () => {
  const f = await scaleFixture();
  try {
    await executePlan(f.app, f.plan(), f.flags);
    const job = f.modelJob();
    await rm(f.output);
    const a = await f.service.download(job.job_id, 'model', 'a.glb'),
      b = await f.service.download(job.job_id, 'model', 'b.glb');
    assert.deepEqual(await readFile(String(a.local_path)), f.outputBytes);
    assert.deepEqual(await readFile(String(b.local_path)), f.outputBytes);
    await f.service.download(job.job_id, 'model', 'a.glb');
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

test('changed hint/matrix or removed transform refuses without poisoning original recovery', async () => {
  const f = await scaleFixture();
  try {
    const result = await executePlan(f.app, f.plan(), f.flags);
    for (const plan of [
      f.plan([3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1]),
      processingPlan('smartsegment', f.input, {}),
      processingPlan('smartsegment', f.input, { param: { transform: scaleMatrix, hint: 'different' } }),
    ])
      await assert.rejects(executePlan(f.app, plan, f.flags), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal((await executePlan(f.app, f.plan(), f.flags)).task_id, result.task_id);
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

test('a prepared stage cannot be bypassed or changed via the Studio service entry', async () => {
  const f = await scaleFixture();
  try {
    await executePlan(f.app, f.plan(), f.flags);
    const job = f.modelJob();
    await assert.rejects(
      f.service.submit('segment', job.request_id, { ...job.input, prompt: 'changed' }, 100),
      { code: 'SMARTSEGMENT_SCALE_UNVERIFIED' },
    );
    assert.equal((await f.service.submit('segment', job.request_id, job.input, 100)).state, 'succeeded');
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

test('parent/child policy interruption blocks direct entry and full request resumes safely', async () => {
  const f = await scaleFixture();
  try {
    const bind = f.jobs.bindRequestPolicy.bind(f.jobs);
    let interrupted = false;
    f.jobs.bindRequestPolicy = (account, key, value) => {
      if (key === scaleStepKey('metadata-scale-1') && !interrupted) {
        interrupted = true;
        throw Error('interrupted');
      }
      return bind(account, key, value);
    };
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), /interrupted/);
    await assert.rejects(
      f.service.submit(
        'segment',
        'metadata-scale-2',
        { project_id: 'private-copy-project', expected_operator_id: 'edit-one' },
        100,
      ),
      { code: 'SMARTSEGMENT_SCALE_UNVERIFIED' },
    );
    assert.equal(f.gateway.posts, 0);
    assert.equal((await executePlan(f.app, f.plan(), f.flags)).status, 'success');
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

test('Rz, metadata, and image layout changes reject before touching another namespace', async () => {
  const f = await scaleFixture();
  try {
    const rz = processingPlan('smartsegment', f.input, { param: { transform: smartSegmentRotationZ90 } });
    const image = processingPlan('smartsegment', path.join(f.dir, 'image.png'), { param: { hint: 'head' } });
    freezeSmartSegmentScale(f.app, f.plan(), 'metadata-only');
    assert.throws(() => assertSmartSegmentLayouts(f.app, rz, 'metadata-only'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(
      f.jobs.requestPolicy('test-account', smartSegmentTransformIntentKey('metadata-only')),
      undefined,
    );
    freezeSmartSegmentTransform(f.jobs, 'test-account', rz, 'rz-only');
    await assert.rejects(executePlan(f.app, f.plan(), { ...f.flags, requestId: 'rz-only' }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(f.jobs.requestPolicy('test-account', scaleIntentKey('rz-only')), undefined);
    freezeSmartSegmentImage(f.jobs, 'test-account', image, 'image-only');
    await assert.rejects(executePlan(f.app, f.plan(), { ...f.flags, requestId: 'image-only' }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(f.jobs.requestPolicy('test-account', scaleIntentKey('image-only')), undefined);
    assert.equal(
      (await executePlan(f.app, f.plan(), { ...f.flags, requestId: 'metadata-only' })).status,
      'success',
    );
  } finally {
    await f.close();
  }
});

test('failed metadata readback prevents segment and retains the original metadata receipt', async () => {
  const f = await scaleFixture();
  try {
    const read = f.client.request.bind(f.client);
    f.client.request = async (method, url) => {
      const r = await read(method, url);
      if (r.operator.operator_id === 'edit-one')
        r.operator.metadata = { ...r.operator.metadata, children_transform_matrix: {} };
      return r;
    };
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), {
      code: 'SMARTSEGMENT_SCALE_METADATA_CHANGED',
    });
    assert.equal(f.gateway.posts, 2);
    assert.equal(f.jobs.find('test-account', 'metadata-scale-1')?.state, 'succeeded');
    assert.equal(f.jobs.find('test-account', 'metadata-scale-2'), undefined);
  } finally {
    await f.close();
  }
});

test('changed final receipt invalidates get/list/download proof without a new segment', async () => {
  const f = await scaleFixture();
  try {
    await executePlan(f.app, f.plan(), f.flags);
    const job = f.modelJob();
    f.jobs.update(job.job_id, 'succeeded', { remote_ids: { ...job.remote_ids, operator_id: 'different' } });
    assert.equal(f.service.summary(f.modelJob()).state, 'needs_attention');
    assert.equal((await f.service.get(job.job_id)).state, 'needs_attention');
    await assert.rejects(f.service.download(job.job_id, 'model', 'different.glb'), {
      code: 'SMARTSEGMENT_SCALE_UNVERIFIED',
    });
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

test('a damaged source cache refuses recovery rather than rereading the original input', async () => {
  const f = await scaleFixture();
  try {
    await executePlan(f.app, f.plan(), f.flags);
    const source = f.jobs.requestPolicy('test-account', scaleSourceKey('metadata-scale'))!;
    await writeFile(String(object(source.parameters).model_path), 'damaged');
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), {
      code: 'SMARTSEGMENT_SCALE_SOURCE_MISSING',
    });
    assert.equal(f.gateway.posts, 3);
    assert.equal((await f.service.get(f.modelJob().job_id)).state, 'needs_attention');
  } finally {
    await f.close();
  }
});

test('unknown final submission is not resubmitted on original request replay', async () => {
  const f = await scaleFixture();
  try {
    const submit = f.gateway.submit.bind(f.gateway);
    f.gateway.submit = async (job) => {
      if (job.operation === 'segment') {
        f.gateway.posts++;
        throw new TripoError('NETWORK_ERROR', 'lost reply', 'unknown');
      }
      return await submit(job);
    };
    const first = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(first.status, 'outcome_unknown');
    assert.equal(f.gateway.posts, 3);
    const replay = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(replay.task_id, first.task_id);
    assert.equal(f.gateway.posts, 3);
    assert(f.jobs.requestPolicy('test-account', scaleInputKey('metadata-scale-2')));
  } finally {
    await f.close();
  }
});
