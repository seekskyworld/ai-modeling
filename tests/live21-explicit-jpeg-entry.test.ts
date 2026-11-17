/** 显式 JPEG 在付费前冻结同一纯纹理意图；测试 CLI 入口、透明拒绝与已创建任务恢复。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { fixture } from './helpers.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { applyDefaultExportJpeg } from '../cli/compat/export-jpeg-default.ts';
import { exportJpegPolicyKey, exportJpegRequested } from '../cli/core/export-jpeg-policy.ts';
import type { Gateway } from '../studio/api/gateway.ts';

async function imageModel(alpha = 255): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const positions = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const image = await sharp(Buffer.from([20, 100, 250, alpha]), { raw: { width: 1, height: 1, channels: 4 } })
    .png()
    .toBuffer();
  const texture = doc.createTexture().setMimeType('image/png').setImage(image);
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', positions)
    .setMaterial(doc.createMaterial().setBaseColorTexture(texture));
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
  return Buffer.from(await new NodeIO().writeBinary(doc));
}
const explicitPlan = () =>
  processingPlan('convert', 'project', {
    format: 'GLTF',
    textureFormat: 'JPEG',
    textureSize: 1024,
    exportOrientation: '+x',
    param: { with_animation: false, animate_in_place: false },
  });
const input = () => ({
  ...explicitPlan().steps[0]!.parameters,
  project_id: 'project',
  expected_operator_id: 'source',
});

test('explicit JPEG preflight freezes the requested encoding and never changes it to a default intent', async () => {
  const f = await fixture();
  try {
    const gateway = f.gateway as Gateway;
    let sourceReads = 0;
    gateway.jpegSource = async () => {
      sourceReads++;
      return { operator_id: 'source', url: 'https://cdn.tripo3d.ai/source.glb' };
    };
    const context = { jobs: f.jobs, gateway, dataDir: f.dir, accountRef: () => 'test-account' };
    const bytes = await imageModel(),
      parameters = input();
    const warnings = await applyDefaultExportJpeg(
      context,
      'explicit',
      parameters,
      undefined,
      async () => bytes,
    );
    assert.match(warnings[0]!, /requested JPEG.*texture-only/);
    assert.equal(f.jobs.requestPolicy('test-account', exportJpegPolicyKey('explicit'))?.explicit, true);
    await applyDefaultExportJpeg(context, 'explicit', input(), undefined, async () => {
      throw Error('Must not reread');
    });
    assert.equal(sourceReads, 1);
    await assert.rejects(
      applyDefaultExportJpeg(
        context,
        'explicit',
        { ...input(), texture_format: undefined },
        undefined,
        async () => bytes,
        false,
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    await assert.rejects(
      applyDefaultExportJpeg(
        context,
        'explicit',
        { ...input(), texture_size: 2048 },
        undefined,
        async () => bytes,
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('explicit JPEG rejects transparency or uninspectable sources before a policy or paid job exists', async () => {
  const f = await fixture();
  try {
    const gateway = f.gateway as Gateway;
    const context = { jobs: f.jobs, gateway, dataDir: f.dir, accountRef: () => 'test-account' };
    await assert.rejects(applyDefaultExportJpeg(context, 'missing', input()), {
      code: 'TEXTURE_ENCODING_UNSUPPORTED',
    });
    gateway.jpegSource = async () => ({ operator_id: 'source', url: 'https://cdn.tripo3d.ai/source.glb' });
    await assert.rejects(
      applyDefaultExportJpeg(context, 'transparent', input(), undefined, async () => imageModel(254)),
      { code: 'TEXTURE_ENCODING_UNSUPPORTED' },
    );
    for (const request of ['missing', 'transparent']) {
      assert.equal(f.jobs.requestPolicy('test-account', exportJpegPolicyKey(request)), undefined);
      assert.equal(f.jobs.find('test-account', request), undefined);
    }
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('CLI explicit JPEG without default markers resumes its frozen pure-texture policy and submits once', async () => {
  const f = await fixture();
  try {
    const gateway = f.gateway as Gateway;
    gateway.jpegSource = async () => ({ operator_id: 'source', url: 'https://cdn.tripo3d.ai/source.glb' });
    const context = { jobs: f.jobs, gateway, dataDir: f.dir, accountRef: () => 'test-account' };
    await applyDefaultExportJpeg(context, 'cli-explicit-0', input(), undefined, async () => imageModel());
    gateway.jpegSource = async () => {
      throw Error('Frozen source must not be read again');
    };
    const app = {
      service: f.service,
      studio: {
        client: {
          request: async () => ({
            id: 'project',
            is_owner: true,
            operator: { operator_id: 'source', is_rigged: false },
          }),
        },
      },
    } as unknown as Application;
    const plan = explicitPlan();
    assert.deepEqual(plan.steps[0]!.exportDefaults, []);
    assert.match(plan.warnings.join('\n'), /texture-only/);
    assert.doesNotMatch(plan.warnings.join('\n'), /Blender/);
    const flags = { requestId: 'cli-explicit', wait: false, download: false };
    const first = await executePlan(app, plan, flags);
    const second = await executePlan(app, explicitPlan(), flags);
    assert.equal(first.task_id, second.task_id);
    assert.equal(f.gateway.posts, 1);
    assert.ok(exportJpegRequested(f.jobs, f.jobs.get(String(first.task_id))));
    const changed = processingPlan('convert', 'project', {
      format: 'GLTF',
      param: { with_animation: false },
    });
    await assert.rejects(executePlan(app, changed, flags), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
