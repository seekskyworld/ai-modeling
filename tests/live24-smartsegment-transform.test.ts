/** 以完整原生两步模拟核验收费前边界、失败回执、原始源缓存和入口绕过保护。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import { modelIO } from '../cli/local/gltf.ts';
import { fixture } from './helpers.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { smartSegmentRotationZ90 } from '../cli/compat/smartsegment-transform-plan.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import {
  freezeSmartSegmentTransform,
  prepareSmartSegmentTransformSource,
} from '../cli/compat/smartsegment-transform.ts';
import {
  inspectSmartSegmentTransformSource,
  verifySmartSegmentTransformedImport,
} from '../cli/artifacts/smartsegment-transform-proof.ts';
import {
  smartSegmentTransformProofKey,
  smartSegmentTransformSourceKey,
  smartSegmentTransformStepKey,
} from '../cli/core/smartsegment-transform-policy.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
async function model(rotated = false, changed?: string): Promise<Buffer> {
  const d = new Document(),
    buffer = d.createBuffer(),
    positions = [
      [-0.5, -0.4, -0.3],
      [0.5, -0.4, -0.3],
      [0, 0.4, -0.3],
      [0, 0, 0.3],
    ],
    normals = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [-1, 0, 0],
    ];
  if (changed === 'translated')
    positions.forEach((p) => {
      p[0]! += 0.2;
    });
  if (changed === 'scaled')
    positions.forEach((p) => {
      p[0]! *= 2;
    });
  const rotate = (p: number[]): number[] => (rotated ? [-p[1]!, p[0]!, p[2]!] : p);
  const a = (name: string, type: 'VEC3' | 'VEC2', values: number[][]) =>
    d.createAccessor(name).setType(type).setArray(new Float32Array(values.flat())).setBuffer(buffer);
  const uv = [
    [0, 0],
    [1, 0],
    [0, 1],
    [0.8, 0.7],
  ];
  if (changed === 'uv') uv[0]![0] = 0.1;
  if (changed === 'normal') normals[0] = [0, 0, 1];
  const ids =
    changed === 'winding' ? [0, 2, 1, 0, 3, 1, 1, 3, 2, 2, 3, 0] : [0, 1, 2, 0, 3, 1, 1, 3, 2, 2, 3, 0];
  if (changed === 'duplicate') ids.push(...ids.slice(0, 3));
  const primitive = d
    .createPrimitive()
    .setAttribute('POSITION', a('positions', 'VEC3', positions.map(rotate)))
    .setAttribute('NORMAL', a('normals', 'VEC3', normals.map(rotate)))
    .setAttribute('TEXCOORD_0', a('uv', 'VEC2', uv))
    .setIndices(
      d.createAccessor('indices').setType('SCALAR').setArray(new Uint16Array(ids)).setBuffer(buffer),
    )
    .setMaterial(
      d
        .createMaterial('m')
        .setMetallicFactor(0)
        .setRoughnessFactor(changed === 'material' ? 0.8 : 0.5),
    );
  const node = d.createNode('mesh').setMesh(d.createMesh('model').addPrimitive(primitive));
  d.createScene('Scene').addChild(node);
  if (changed === 'hierarchy') d.createNode('child').setTranslation([0, 0, 0.1]).addChild(node);
  if (changed === 'skin') node.setSkin(d.createSkin('skeleton').addJoint(node));
  if (changed === 'morph')
    primitive.addTarget(d.createPrimitiveTarget().setAttribute('POSITION', a('delta', 'VEC3', positions)));
  return Buffer.from(await (await modelIO()).writeBinary(d));
}

test('only exact Rz90 file/URL plans acquire the guarded native import chain', () => {
  for (const source of ['/tmp/model.glb', 'https://example.invalid/model?file=1']) {
    const plan = processingPlan('smartsegment', source, {
      param: { transform: smartSegmentRotationZ90, granularity: 'coarse', hint: 'head' },
    });
    assert.deepEqual(
      plan.steps.map((s) => s.operation),
      ['import_model', 'segment'],
    );
    assert.deepEqual(plan.steps[0]!.parameters.transform_matrix, smartSegmentRotationZ90);
    assert.equal(plan.steps[0]!.parameters.use_original_uv, true);
    assert.equal(plan.steps[1]!.parameters.segmentation_granularity, 'simple');
    assert.equal(plan.steps[1]!.parameters.prompt, 'head');
    assert.equal(plan.steps[1]!.parameters.transform, undefined);
    assert.deepEqual(plan.smartSegmentTransform?.matrix, smartSegmentRotationZ90);
  }
  for (const source of ['/tmp/model.fbx', 'studio_file_model_test'])
    assert.throws(
      () => processingPlan('smartsegment', source, { param: { transform: smartSegmentRotationZ90 } }),
      { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
    );
  for (const source of ['task-example', '@last', '00000000-0000-0000-0000-000000000001']) {
    const plan = processingPlan('smartsegment', source, { param: { transform: smartSegmentRotationZ90 } });
    assert.equal(plan.smartSegmentTransform, undefined);
    assert.deepEqual(
      plan.steps.map((s) => s.operation),
      ['copy', 'project_edit', 'segment'],
    );
  }
  const scale = [1.3, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 1.1, 0, 0, 0, 0, 1];
  const scaled = processingPlan('smartsegment', '/tmp/model.glb', { param: { transform: scale } });
  assert.equal(scaled.smartSegmentTransform, undefined);
  assert.deepEqual(
    scaled.steps.map((s) => s.operation),
    ['import_model', 'project_edit', 'segment'],
  );
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.equal(
    processingPlan('smartsegment', '@last', { param: { transform: identity } }).smartSegmentTransform,
    undefined,
  );
});

test('the imported result must preserve every oriented face and source attribute under Rz90', async () => {
  const source = await model(),
    transformed = await model(true);
  const proof = await verifySmartSegmentTransformedImport(source, transformed);
  assert.equal(proof.matched_oriented_faces, 4);
  assert.equal(proof.maximum_position_error, 0);
  assert.equal(proof.maximum_uv_error, 0);
  for (const changed of ['uv', 'normal', 'winding', 'material', 'duplicate'])
    await assert.rejects(verifySmartSegmentTransformedImport(source, await model(true, changed)), {
      code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
    });
  await assert.rejects(verifySmartSegmentTransformedImport(source, source), {
    code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
  });
});

for (const changed of ['translated', 'scaled', 'hierarchy', 'skin', 'morph'])
  test(`${changed} source is rejected before import`, async () => {
    await assert.rejects(inspectSmartSegmentTransformSource(await model(false, changed)), {
      code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
    });
  });

async function setup(changed?: string) {
  const f = await fixture(),
    input = path.join(f.dir, 'original.glb'),
    output = path.join(f.dir, 'native.glb'),
    bytes = await model(true, changed);
  await writeFile(input, await model());
  await writeFile(output, bytes);
  const artifact: Artifact = {
    artifact_id: 'model',
    kind: 'model',
    format: 'glb',
    index: 0,
    local_path: output,
    sha256: hash(bytes),
    bytes: bytes.length,
  };
  f.gateway.submit = async (job: Job) => {
    f.gateway.posts++;
    return {
      remote_ids: {
        project_id: 'project-one',
        operator_id: job.operation === 'import_model' ? 'import-one' : 'segment-one',
      },
    };
  };
  f.gateway.status = async (job: Job) => ({
    state: 'succeeded',
    progress: 100,
    artifacts: [
      artifact,
      ...(job.operation === 'segment'
        ? [{ artifact_id: 'semantic-mask', kind: 'image' as const, format: 'png', index: 0 }]
        : []),
    ],
  });
  f.gateway.artifactUrl = async () => {
    throw Error('Unexpected native download');
  };
  const app = {
    service: f.service,
    studio: {
      client: {
        request: async () => {
          throw Error('Unexpected project read');
        },
      },
    },
  } as unknown as Application;
  const flags = { requestId: 'rotated', maxCredits: 100, download: false, open: false };
  const plan = () =>
    processingPlan('smartsegment', input, {
      param: { transform: smartSegmentRotationZ90, granularity: 'coarse', hint: 'head' },
    });
  return {
    ...f,
    input,
    output,
    app,
    flags,
    plan,
    close: async () => {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    },
  };
}

test('two-step execution freezes the original import, then resumes after the caller file disappears', async () => {
  const f = await setup();
  try {
    const result = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(result.status, 'success');
    assert.equal(result.name, 'original');
    assert.equal(f.gateway.posts, 2);
    const original = f.jobs.find('test-account', 'rotated-0')!,
      segment = f.jobs.find('test-account', 'rotated-1')!;
    assert.equal(segment.input.expected_operator_id, 'import-one');
    const proof = f.jobs.requestPolicy('test-account', smartSegmentTransformProofKey('rotated'))!;
    assert.equal(proof.import_job_id, original.job_id);
    assert.equal(proof.matched_oriented_faces, 4);
    f.jobs.setAlias('test-account', 'previously-persisted-name', segment.job_id);
    await rm(f.input);
    await rm(f.output);
    const resumed = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(resumed.task_id, result.task_id);
    assert.equal(resumed.name, 'previously-persisted-name');
    assert.equal(f.gateway.posts, 2);
    const alternate = processingPlan('smartsegment', f.input, {
      param: { transform: smartSegmentRotationZ90, hint: 'different' },
    });
    await assert.rejects(executePlan(f.app, alternate, f.flags), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(executePlan(f.app, processingPlan('smartsegment', f.input, {}), f.flags), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await assert.rejects(
      f.service.submit('segment', 'rotated-1', { ...segment.input, prompt: 'different' }, 100),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(f.gateway.posts, 2);
  } finally {
    await f.close();
  }
});

test('mismatched native import retains its receipt and prevents segmentation even through the studio service entry', async () => {
  const f = await setup('uv');
  try {
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), {
      code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
    });
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.jobs.find('test-account', 'rotated-0')!.state, 'succeeded');
    assert.equal(f.jobs.find('test-account', 'rotated-1'), undefined);
    await assert.rejects(
      f.service.submit(
        'segment',
        'rotated-1',
        {
          project_id: 'project-one',
          expected_operator_id: 'import-one',
          model_version: 'v2.0-20260430',
          segmentation_granularity: 'simple',
          prompt: 'head',
        },
        100,
      ),
      { code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED' },
    );
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), {
      code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
    });
    assert.equal(f.gateway.posts, 1);
  } finally {
    await f.close();
  }
});

test('a damaged frozen source cache stops recovery without rereading the user file or resubmitting', async () => {
  const f = await setup();
  try {
    const plan = f.plan();
    freezeSmartSegmentTransform(f.jobs, 'test-account', plan, 'rotated');
    const prepared = await prepareSmartSegmentTransformSource(f.app, plan, 'rotated');
    const source = f.jobs.requestPolicy('test-account', smartSegmentTransformSourceKey('rotated'))!;
    const cache = String(prepared.steps[0]!.parameters.model_path);
    const bytes = await readFile(cache);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(cache, bytes);
    assert.equal(source.bytes, bytes.length);
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), {
      code: 'SMARTSEGMENT_TRANSFORM_SOURCE_MISSING',
    });
    assert.equal(f.gateway.posts, 0);
  } finally {
    await f.close();
  }
});

test('a changed import identity cannot use the saved geometric proof', async () => {
  const f = await setup();
  try {
    await executePlan(f.app, f.plan(), f.flags);
    const job = f.jobs.find('test-account', 'rotated-0')!;
    f.jobs.update(job.job_id, 'succeeded', { remote_ids: { ...job.remote_ids, operator_id: 'replaced' } });
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), {
      code: 'SMARTSEGMENT_TRANSFORM_SOURCE_CHANGED',
    });
    assert.equal(f.gateway.posts, 2);
  } finally {
    await f.close();
  }
});

test('a URL downloads once and resumes from the frozen source after the server and URL cache disappear', async () => {
  const f = await setup(),
    bytes = await model(),
    oldNoProxy = process.env.no_proxy;
  let gets = 0;
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    gets++;
    response.writeHead(200, { 'content-type': 'model/gltf-binary' });
    response.end(bytes);
  });
  process.env.no_proxy = '127.0.0.1';
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/source`,
      plan = () =>
        processingPlan('smartsegment', url, { param: { transform: smartSegmentRotationZ90, hint: 'head' } });
    const result = await executePlan(f.app, plan(), f.flags);
    assert.equal(result.status, 'success');
    assert.equal(gets, 1);
    assert.equal(f.gateway.posts, 2);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(path.join(f.dir, 'input-cache'), { recursive: true, force: true });
    const resumed = await executePlan(f.app, plan(), f.flags);
    assert.equal(resumed.task_id, result.task_id);
    assert.equal(gets, 1);
    assert.equal(f.gateway.posts, 2);
    await assert.rejects(
      executePlan(
        f.app,
        processingPlan('smartsegment', `${url}?changed=1`, {
          param: { transform: smartSegmentRotationZ90, hint: 'head' },
        }),
        f.flags,
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  } finally {
    server.closeAllConnections();
    server.close();
    if (oldNoProxy === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = oldNoProxy;
    await f.close();
  }
});

test('a new cache root preserves the original import input and proof instead of rebinding its path', async () => {
  const f = await setup();
  try {
    const first = await executePlan(f.app, f.plan(), f.flags),
      source = f.jobs.requestPolicy('test-account', smartSegmentTransformSourceKey('rotated'))!,
      job = f.jobs.find('test-account', 'rotated-0')!;
    const relocated = path.join(f.dir, 'cloned-data');
    await mkdir(relocated);
    f.service.config.dataDir = relocated;
    const resumed = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(resumed.task_id, first.task_id);
    assert.equal(f.gateway.posts, 2);
    assert.deepEqual(f.jobs.requestPolicy('test-account', smartSegmentTransformSourceKey('rotated')), source);
    assert.deepEqual(f.jobs.get(job.job_id).input, job.input);
    assert.equal(
      f.jobs.get(job.job_id).input.model_path,
      source.import_parameters && (source.import_parameters as Record<string, unknown>).model_path,
    );
  } finally {
    await f.close();
  }
});

test('switching accounts during the saved proof cache read cannot create a task in the new account', async () => {
  const f = await setup();
  try {
    await executePlan(f.app, f.plan(), f.flags);
    const readPolicy = f.jobs.requestPolicy.bind(f.jobs);
    let account = 'test-account',
      changed = false;
    f.service.accountRef = () => account;
    f.jobs.requestPolicy = (owner, key) => {
      const result = readPolicy(owner, key);
      if (!changed && key === smartSegmentTransformProofKey('rotated') && result) {
        changed = true;
        queueMicrotask(() => {
          account = 'other-account';
        });
      }
      return result;
    };
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), { code: 'ACCOUNT_MISMATCH' });
    assert.equal(changed, true);
    assert.equal(f.gateway.posts, 2);
    assert.equal(f.jobs.find('other-account', 'rotated-1'), undefined);
  } finally {
    await f.close();
  }
});

test('an interruption between parent and child intent commits cannot be bypassed with a component request', async () => {
  const f = await setup();
  try {
    const bind = f.jobs.bindRequestPolicy.bind(f.jobs);
    f.jobs.bindRequestPolicy = (account, key, policy) => {
      if (key === smartSegmentTransformStepKey('rotated-0')) throw Error('Simulated interrupted layout');
      return bind(account, key, policy);
    };
    assert.throws(() => freezeSmartSegmentTransform(f.jobs, 'test-account', f.plan(), 'rotated'));
    f.jobs.bindRequestPolicy = bind;
    await assert.rejects(
      f.service.submit(
        'segment',
        'rotated-1',
        {
          project_id: 'project-one',
          expected_operator_id: 'import-one',
          model_version: 'v2.0-20260430',
          segmentation_granularity: 'simple',
          prompt: 'head',
        },
        100,
      ),
      { code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED' },
    );
    assert.equal(f.gateway.posts, 0);
    assert.equal((await executePlan(f.app, f.plan(), f.flags)).status, 'success');
    assert.equal(f.gateway.posts, 2);
  } finally {
    await f.close();
  }
});

for (const boundary of ['budget', 'claimed-await'] as const)
  test(`an import changed during the ${boundary} boundary stops before native segmentation`, async () => {
    const f = await setup();
    try {
      const changeSource = () => {
        const job = f.jobs.find('test-account', 'rotated-0');
        if (job?.state === 'succeeded')
          f.jobs.update(job.job_id, 'succeeded', {
            remote_ids: { ...job.remote_ids, operator_id: 'changed-during-await' },
          });
      };
      if (boundary === 'budget') {
        f.gateway.account = async () => {
          changeSource();
          return { authenticated: true, balance: 100, account_ref: 'test-account' };
        };
        await assert.rejects(executePlan(f.app, f.plan(), f.flags), {
          code: 'SMARTSEGMENT_TRANSFORM_SOURCE_CHANGED',
        });
      } else {
        const claim = f.jobs.claim.bind(f.jobs);
        f.jobs.claim = (id) => {
          const claimed = claim(id);
          if (f.jobs.get(id).operation === 'segment') queueMicrotask(changeSource);
          return claimed;
        };
        const result = await executePlan(f.app, f.plan(), f.flags);
        assert.equal(result.status, 'failed');
        assert.equal((result.error as Record<string, unknown>).code, 'SMARTSEGMENT_TRANSFORM_SOURCE_CHANGED');
      }
      assert.equal(f.gateway.posts, 1);
    } finally {
      await f.close();
    }
  });
