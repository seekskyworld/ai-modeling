import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { fixture, quote } from './helpers.ts';
import { array, object, text } from '../studio/contracts/errors.ts';
import { detectFormat } from '../studio/files.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import type { Application } from '../cli/compat/runtime.ts';
import type { LabGraphIO } from '../cli/compat/lab-reference-edit-graph.ts';
import {
  executeLabReferenceEdit,
  redoLabReferenceEditPlan,
} from '../cli/compat/lab-reference-edit-runtime.ts';
import { labReferenceKey, labReferenceProofKey } from '../cli/compat/lab-reference-edit-policy.ts';
import {
  labProjectedSegmentPlan,
  type LabReferenceProjection,
} from '../cli/compat/lab-projected-segment-plan.ts';
import {
  labProjectedSegmentSourceSummary,
  verifyLabProjectedSegment,
} from '../cli/compat/lab-projected-segment-geometry.ts';

const projection: LabReferenceProjection = [
  [20, 0, 0, 8],
  [0, -20, 0, 8],
];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function model(partition = false, swapped = false, moved = false): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene();
  const faces = [
    [-0.2, -0.2, 0, 0.2, -0.2, 0, 0, 0, 0],
    [-0.2, 0.2, 0, 0.2, 0.2, 0, 0, 0.4, 0],
  ];
  if (moved) faces[0]![0]! += 0.01;
  const groups = partition ? faces : [faces.flat()];
  for (const [i, positions] of groups.entries()) {
    const count = positions.length / 3;
    const attribute = (type: 'VEC3' | 'SCALAR', values: number[]) =>
      doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
    const primitive = doc
      .createPrimitive()
      .setAttribute('POSITION', attribute('VEC3', positions))
      .setAttribute('NORMAL', attribute('VEC3', Array.from({ length: count }, () => [0, 0, 1]).flat()));
    const name = partition ? (i === Number(swapped) ? 'mask_e04138' : 'mask_186ee6') : 'original';
    scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(primitive)));
  }
  return Buffer.from(await new NodeIO().writeBinary(doc));
}
async function mask(alpha = false): Promise<Buffer> {
  const pixels = Buffer.alloc(16 * 16 * 3);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) pixels.set(y < 8 ? [24, 110, 230] : [224, 65, 56], (y * 16 + x) * 3);
  const image = sharp(pixels, { raw: { width: 16, height: 16, channels: 3 } });
  return await (alpha ? image.ensureAlpha() : image).png().toBuffer();
}
async function setup(t: TestContext) {
  const f = await fixture();
  t.after(async () => {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  const source = await model(),
    output = await model(true),
    image = await mask();
  const modelPath = path.join(f.dir, 'source.glb'),
    imagePath = path.join(f.dir, 'mask.png'),
    remote = path.join(f.dir, 'remote.glb');
  await Promise.all([writeFile(modelPath, source), writeFile(imagePath, image), writeFile(remote, output)]);
  f.service.pricing = { quote: async () => ({ ...quote, known: false, credits: undefined, variable: true }) };
  let posts = 0,
    create = 0,
    uploads = 0,
    saves = 0;
  const artifact = {
    artifact_id: 'partitioned',
    kind: 'model' as const,
    format: 'glb',
    index: 0,
    local_path: remote,
    sha256: digest(output),
    bytes: output.length,
  };
  f.gateway.submit = async () => ({ remote_ids: { task_id: `lab-${++posts}` } });
  f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [artifact] });
  f.gateway.artifactUrl = async () => {
    throw Error('No remote source or regenerated model is allowed.');
  };
  const uploaded = new Map<string, Buffer>();
  let graph: Record<string, unknown> = {};
  const io: LabGraphIO = {
    call: async (name, input) => {
      if (name === 'create') {
        create++;
        graph = { canvas: { canvasId: 'canvas', projectId: 'project', revision: '0' }, nodes: [], edges: [] };
        return {
          project: { projectId: 'project', canvasId: 'canvas' },
          canvas: { projectId: 'project', canvasId: 'canvas' },
        };
      }
      if (name === 'input_assets')
        return {
          assets: ['model', 'image'].map((kind) => ({
            assetId: `input-${kind}`,
            kind: `ASSET_KIND_${kind.toUpperCase()}`,
            status: 'INPUT_ASSET_STATUS_READY',
          })),
        };
      if (name === 'get') return structuredClone(graph);
      if (name === 'save') {
        saves++;
        graph = {
          canvas: { canvasId: 'canvas', projectId: 'project', revision: '1' },
          nodes: input.nodes,
          edges: [],
        };
        return { revision: '1', violations: [] };
      }
      if (name === 'lab_inputs')
        return {
          canvas_id: 'canvas',
          node_id: input.nodeId,
          asset_ids: input.assetIds,
          inputs: array(input.assetIds).map((asset_id) => ({ asset_id })),
          missing: false,
          missing_inputs: [],
        };
      throw Error(`Unexpected Canvas operation ${name}`);
    },
    upload: async (_project, file) => {
      uploads++;
      const bytes = await readFile(file),
        kind = detectFormat(bytes) === 'glb' ? 'model' : 'image';
      uploaded.set(`input-${kind}`, bytes);
      return {
        assets: [
          {
            assetId: `input-${kind}`,
            kind: `ASSET_KIND_${kind.toUpperCase()}`,
            status: 'INPUT_ASSET_STATUS_READY',
          },
        ],
        uploaded_sha256: digest(bytes),
        uploaded_format: detectFormat(bytes),
      };
    },
    bytes: async (id) => uploaded.get(id)!,
    pause: async () => {},
  };
  const app = { service: f.service, studio: {}, close: () => {} } as Application;
  const plan = processingPlan('segment', modelPath, {
    param: { ref_image: imagePath, reference_projection: projection, accept_variable_cost: true },
  });
  return {
    ...f,
    app,
    io,
    plan,
    source,
    output,
    image,
    modelPath,
    imagePath,
    artifact,
    counts: () => ({ posts, create, uploads, saves }),
  };
}

test('Projected mask planning requires explicit camera/cost and never selects a native engine', () => {
  assert.equal(labProjectedSegmentPlan('/source.glb', {}), undefined);
  assert.throws(
    () =>
      labProjectedSegmentPlan('/source.glb', { ref_image: '/mask.png', reference_projection: projection }),
    { code: 'VARIABLE_COST_NOT_ACCEPTED' },
  );
  assert.throws(
    () => labProjectedSegmentPlan('/source.glb', { ref_image: '/mask.png', accept_variable_cost: true }),
    { code: 'INVALID_INPUT' },
  );
  for (const bad of [
    [
      [1, 0, 0, 0],
      [1, 0, 0, 0],
    ],
    [
      [1, 0, 0, 0],
      [0, 2, 0, 0],
    ],
    [
      [0, 0, 0, 0],
      [0, 1, 0, 0],
    ],
  ])
    assert.throws(
      () =>
        labProjectedSegmentPlan('/source.glb', {
          ref_image: '/mask.png',
          reference_projection: bad,
          accept_variable_cost: true,
        }),
      { code: 'INVALID_INPUT' },
    );
  assert.throws(
    () =>
      labProjectedSegmentPlan('/source.glb', {
        ref_image: '/mask.png',
        reference_projection: projection,
        accept_variable_cost: true,
        model: 'v2.0-20260430',
      }),
    { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
  );
  const plan = labProjectedSegmentPlan('/source.glb', {
    ref_image: '/mask.png',
    reference_projection: projection,
    accept_variable_cost: true,
  })!;
  assert.equal(plan.labReferenceEdit?.kind, 'projected_segment');
  assert.equal(plan.labReferenceEdit?.bbox, undefined);
});
test('Projected mask verifies every original face and exact pixel group, rejecting unchanged, swapped and moved geometry', async () => {
  const source = await model(),
    image = await mask();
  const proof = await verifyLabProjectedSegment(source, image, await model(true), projection);
  assert.equal(proof.matched_original_faces, 2);
  assert.equal(proof.wrong_group_faces, 0);
  assert.deepEqual(proof.expected_group_faces, { mask_186ee6: 1, mask_e04138: 1 });
  for (const bad of [source, await model(true, true), await model(true, false, true)])
    await assert.rejects(verifyLabProjectedSegment(source, image, bad, projection), {
      code: 'LAB_PROJECTED_SEGMENT_UNVERIFIED',
    });
});
test('Projected mask rejects a shared mesh plus an orphan even when world faces and groups match', async () => {
  const io = new NodeIO(),
    document = await io.readBinary(await model(true));
  const nodes = document.getRoot().listNodes();
  nodes[1]!.setMesh(nodes[0]!.getMesh()).setTranslation([0, 0.4, 0]);
  const instanced = Buffer.from(await io.writeBinary(document));
  await assert.rejects(verifyLabProjectedSegment(await model(), await mask(), instanced, projection), {
    code: 'LAB_PROJECTED_SEGMENT_UNVERIFIED',
  });
});
test('Projected mask rejects alpha, excessive colors and off-canvas source before preparation', async (t) => {
  const f = await setup(t);
  await assert.rejects(labProjectedSegmentSourceSummary(f.source, await mask(true), projection), {
    code: 'LAB_PROJECTED_SEGMENT_UNVERIFIED',
  });
  const noisyPixels = Buffer.alloc(16 * 16 * 3);
  for (let i = 0; i < 16 * 16; i++) noisyPixels.set([i % 9, 100, 200], i * 3);
  const noisy = await sharp(noisyPixels, { raw: { width: 16, height: 16, channels: 3 } })
    .png()
    .toBuffer();
  await assert.rejects(labProjectedSegmentSourceSummary(f.source, noisy, projection), {
    code: 'LAB_PROJECTED_SEGMENT_UNVERIFIED',
  });
  const blank = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  await assert.rejects(labProjectedSegmentSourceSummary(f.source, blank, projection), {
    code: 'LAB_PROJECTED_SEGMENT_UNVERIFIED',
  });
  const shifted: LabReferenceProjection = [
    [20, 0, 0, 800],
    [0, -20, 0, 8],
  ];
  const plan = labProjectedSegmentPlan(f.modelPath, {
    ref_image: f.imagePath,
    reference_projection: shifted,
    accept_variable_cost: true,
  })!;
  await assert.rejects(executeLabReferenceEdit(f.app, plan, { wait: false }, 'bad-camera', f.io), {
    code: 'LAB_PROJECTED_SEGMENT_UNVERIFIED',
  });
  assert.deepEqual(f.counts(), { posts: 0, create: 0, uploads: 0, saves: 0 });
});
test('Projected mask no-wait, no-download, list, A to B to A and redo retain distinct proof and one original submission', async (t) => {
  const f = await setup(t);
  const submitted = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'mask',
    f.io,
  );
  const id = text(submitted.task_id),
    view = await f.service.get(id);
  assert.equal(view.task_type, 'mesh_segmentation');
  assert.equal(object(view.lab_projected_segment_validation).status, 'verified');
  assert.equal(view.lab_reference_edit_validation, undefined);
  const listed = f.service.list(20, 0);
  assert.equal(
    object(array(listed.jobs).find((j) => object(j).job_id === id)).task_type,
    'mesh_segmentation',
  );
  for (const name of ['a.glb', 'b.glb', 'a.glb']) {
    const out = await f.service.download(id, 'partitioned', name);
    assert.equal(out.sha256, digest(f.output));
  }
  const resumed = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'mask',
    f.io,
  );
  assert.equal(resumed.status, 'success');
  assert.deepEqual(f.counts(), { posts: 1, create: 1, uploads: 2, saves: 1 });
  const job = f.jobs.get(id),
    redo = redoLabReferenceEditPlan(f.jobs, f.dir, job)!;
  assert.equal(redo.labReferenceEdit?.kind, 'projected_segment');
  await Promise.all([rm(f.modelPath), rm(f.imagePath)]);
  const redone = await executeLabReferenceEdit(
    f.app,
    redo,
    { wait: false, download: false },
    'mask-redo',
    f.io,
  );
  assert.equal((await f.service.get(text(redone.task_id))).task_type, 'mesh_segmentation');
  assert.deepEqual(f.counts(), { posts: 2, create: 2, uploads: 4, saves: 2 });
  assert.equal(
    f.jobs.requestPolicy('test-account', labReferenceKey('mask', 'intent'))!.kind,
    'projected_segment',
  );
  assert.equal(
    object(f.jobs.requestPolicy('test-account', labReferenceProofKey(job))!.validation).wrong_group_faces,
    0,
  );
});
test('Projected mask same request rejects camera or task-kind changes without another submission', async (t) => {
  const f = await setup(t);
  await executeLabReferenceEdit(f.app, f.plan, { wait: false, download: false }, 'fixed', f.io);
  const changed = structuredClone(f.plan);
  if (changed.labReferenceEdit?.kind === 'projected_segment') changed.labReferenceEdit.projection[0][3]++;
  await assert.rejects(executeLabReferenceEdit(f.app, changed, { wait: false }, 'fixed', f.io), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  const edit = processingPlan('edit', f.modelPath, {
    refImage: f.imagePath,
    bbox: [
      [-0.5, 0.1, -0.1],
      [0.5, 0.5, 0.1],
    ],
    param: { accept_variable_cost: true },
  });
  await assert.rejects(executeLabReferenceEdit(f.app, edit, { wait: false }, 'fixed', f.io), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  assert.equal(f.counts().posts, 1);
});
