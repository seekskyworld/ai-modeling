import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, stat, symlink, rename, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { fixture, quote } from './helpers.ts';
import { JobStore } from '../cli/storage/jobs.ts';
import { object, array, text, TripoError } from '../studio/contracts/errors.ts';
import { detectFormat } from '../studio/files.ts';
import type { Artifact } from '../studio/contracts/types.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { downloadTask, type Application } from '../cli/compat/runtime.ts';
import { labReferenceEditPlan } from '../cli/compat/lab-reference-edit-plan.ts';
import {
  inspectLabReferenceGeometry,
  verifyLabReferenceGeometry,
} from '../cli/compat/lab-reference-edit-geometry.ts';
import {
  executeLabReferenceEdit,
  assertLabReferenceEditPlan,
  redoLabReferenceEditPlan,
} from '../cli/compat/lab-reference-edit-runtime.ts';
import { labJournalStep } from '../cli/compat/lab-reference-edit-journal.ts';
import type { LabGraphIO } from '../cli/compat/lab-reference-edit-graph.ts';
import { labReferenceKey, labReferenceProofKey } from '../cli/compat/lab-reference-edit-policy.ts';
import { saveVerifiedOutputCache } from '../cli/artifacts/verified-output-cache.ts';

const bbox: [[number, number, number], [number, number, number]] = [
  [-0.5, 0.1, -0.1],
  [0.5, 0.5, 0.1],
];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function geometry(change = false, outsideShift = 0, normals = true, reverse = false): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const positions = [
    -0.2 + outsideShift,
    -0.2,
    0,
    0.2 + outsideShift,
    -0.2,
    0,
    outsideShift,
    0,
    0,
    -0.2,
    0.2,
    0,
    0.2,
    0.2,
    0,
    0,
    change ? 0.45 : 0.4,
    0,
  ];
  const p = doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', p)
    .setIndices(
      doc
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Uint16Array(reverse ? [0, 2, 1, 3, 4, 5] : [0, 1, 2, 3, 4, 5]))
        .setBuffer(buffer),
    );
  if (normals)
    primitive.setAttribute(
      'NORMAL',
      doc
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array(Array.from({ length: 6 }, () => [0, 0, 1]).flat()))
        .setBuffer(buffer),
    );
  doc
    .createScene()
    .addChild(doc.createNode('source').setMesh(doc.createMesh('source').addPrimitive(primitive)));
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

async function setup(t: TestContext) {
  const f = await fixture();
  t.after(async () => {
    f.service.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  const source = await geometry(),
    output = await geometry(true),
    image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#0044cc' } })
      .png()
      .toBuffer();
  const modelPath = path.join(f.dir, 'source.glb'),
    imagePath = path.join(f.dir, 'source.png'),
    outputPath = path.join(f.dir, 'remote.glb');
  await Promise.all([
    writeFile(modelPath, source),
    writeFile(imagePath, image),
    writeFile(outputPath, output),
  ]);
  f.service.pricing = {
    quote: async () => ({
      ...quote,
      known: false,
      credits: undefined,
      variable: true,
      explanation: 'variable Lab fixture',
    }),
  };
  let posts = 0,
    remoteReads = 0;
  f.gateway.submit = async () => {
    posts++;
    return { remote_ids: { task_id: `remote-lab-${posts}` } };
  };
  const artifacts: Artifact[] = [
    {
      artifact_id: 'edited',
      kind: 'model',
      format: 'glb',
      index: 1,
      local_path: outputPath,
      sha256: digest(output),
      bytes: output.length,
    },
    {
      artifact_id: 'preview',
      kind: 'image',
      format: 'png',
      index: 0,
      local_path: imagePath,
      sha256: digest(image),
      bytes: image.length,
    },
  ];
  f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts });
  f.gateway.artifactUrl = async () => {
    remoteReads++;
    throw new Error('Unexpected raw source/output network read');
  };
  let graph: Record<string, unknown> = {
    canvas: { canvasId: 'canvas', projectId: 'project', revision: '0' },
    nodes: [],
    edges: [],
  };
  const counts = { create: 0, uploads: 0, save: 0, calls: 0 },
    uploaded = new Map<string, Buffer>();
  const io: LabGraphIO = {
    call: async (name, input) => {
      counts.calls++;
      if (name === 'create') {
        counts.create++;
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
        counts.save++;
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
      throw new Error(`Unexpected call ${name}`);
    },
    upload: async (_project, file) => {
      counts.uploads++;
      const bytes = await readFile(file),
        format = detectFormat(bytes),
        kind = format === 'glb' ? 'model' : 'image';
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
        uploaded_format: format,
      };
    },
    bytes: async (id) => uploaded.get(id)!,
    pause: async () => {},
  };
  const app = { service: f.service, studio: {}, close: () => {} } as Application;
  const plan = processingPlan('edit', modelPath, {
    refImage: imagePath,
    bbox,
    param: { accept_variable_cost: true },
  });
  return {
    ...f,
    app,
    io,
    plan,
    source,
    output,
    image,
    artifacts,
    modelPath,
    imagePath,
    counts,
    posts: () => posts,
    remoteReads: () => remoteReads,
    setGraph: (next: Record<string, unknown>) => {
      graph = next;
    },
  };
}

test('Lab planning keeps native edit without a reference and requires explicit variable-cost selection', () => {
  assert.equal(labReferenceEditPlan('/input.glb', { bbox }), undefined);
  assert.throws(() => labReferenceEditPlan('/input.glb', { bbox, ref_image: '/input.png' }), {
    code: 'VARIABLE_COST_NOT_ACCEPTED',
  });
  for (const input of [
    { face_limit: 100 },
    { compress: 'geometry' },
    { model: 'P2-20260801' },
    { prompt: 'silent-ignored' },
  ])
    assert.throws(
      () =>
        labReferenceEditPlan('/input.glb', {
          bbox,
          ref_image: '/input.png',
          accept_variable_cost: true,
          ...input,
        }),
      { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
    );
});
test('CLI parameters normalize flat/text bbox and retain -p overrides before Lab dispatch', () => {
  for (const region of [bbox, bbox.flat(), bbox.flat().join(',')]) {
    const plan = processingPlan('edit', '/input.glb', {
      bbox: region,
      refImage: '/ignored.png',
      param: { ref_image: '/actual.png', accept_variable_cost: true },
    });
    assert.deepEqual(plan.labReferenceEdit?.bbox, bbox);
    assert.equal(plan.labReferenceEdit?.reference, '/actual.png');
  }
  assert.throws(
    () =>
      processingPlan('edit', '/input.glb', {
        bbox,
        refImage: '/input.png',
        model: 'P2-20260801',
        param: { accept_variable_cost: true },
      }),
    { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
  );
});
test('Lab geometry preserves protected winding, normals and material and requires an inside change', async () => {
  const source = await geometry();
  assert.equal((await verifyLabReferenceGeometry(source, await geometry(true), bbox)).status, 'verified');
  for (const output of [source, await geometry(true, 0.01), await geometry(true, 0, true, true)])
    await assert.rejects(verifyLabReferenceGeometry(source, output, bbox), {
      code: 'LAB_REFERENCE_GEOMETRY_UNVERIFIED',
    });
  await assert.rejects(inspectLabReferenceGeometry(await geometry(false, 0, false)), {
    code: 'LAB_REFERENCE_GEOMETRY_UNVERIFIED',
  });
});
test('Lab rejects empty/full regions before any Canvas write', async (t) => {
  const f = await setup(t);
  for (const region of [
    [
      [2, 2, 2],
      [3, 3, 3],
    ],
    [
      [-2, -2, -2],
      [2, 2, 2],
    ],
  ]) {
    const plan = processingPlan('edit', f.modelPath, {
      bbox: region,
      refImage: f.imagePath,
      param: { accept_variable_cost: true },
    });
    await assert.rejects(
      executeLabReferenceEdit(
        f.app,
        plan,
        { wait: false, download: false },
        `invalid-${region[0]![0]}`,
        f.io,
      ),
      { code: 'LAB_REFERENCE_GEOMETRY_UNVERIFIED' },
    );
  }
  assert.equal(f.counts.create, 0);
  assert.equal(f.posts(), 0);
});
test('Lab --no-wait prepares once, returns queued and verifies on get even without downloads', async (t) => {
  const f = await setup(t);
  const result = await executeLabReferenceEdit(f.app, f.plan, { wait: false, download: false }, 'one', f.io);
  assert.equal(result.status, 'queued');
  assert.equal(f.posts(), 1);
  assert.deepEqual(
    { create: f.counts.create, uploads: f.counts.uploads, save: f.counts.save },
    { create: 1, uploads: 2, save: 1 },
  );
  const job = f.jobs.find('test-account', 'one-0')!;
  const view = await f.service.get(job.job_id);
  assert.equal(view.state, 'succeeded');
  assert.equal(view.task_type, 'mesh_edit');
  assert.equal(object(view.lab_reference_edit_validation).status, 'verified');
  assert.deepEqual(
    array(view.artifacts).map((a) => object(a).artifact_id),
    ['edited'],
  );
  const count = f.counts.calls;
  const resumed = await executeLabReferenceEdit(f.app, f.plan, { wait: false, download: false }, 'one', f.io);
  assert.equal(resumed.status, 'success');
  assert.equal(f.posts(), 1);
  assert.equal(f.counts.calls, count);
  assert.equal(f.remoteReads(), 0);
});
test('Lab output reuses only its registered same-directory and A to B to A deliveries', async (t) => {
  const f = await setup(t);
  const result = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'download',
    f.io,
  );
  await f.service.get(text(result.task_id));
  const originalStats = new Map<string, { inode: number; mtime: number }>();
  for (const name of ['first.glb', 'first.glb', 'second.glb', 'first.glb']) {
    const out = await f.service.download(text(result.task_id), 'edited', name);
    assert.equal(out.sha256, digest(f.output));
    assert.deepEqual(await readFile(text(out.local_path)), f.output);
    const current = await stat(text(out.local_path));
    const actual = { inode: current.ino, mtime: current.mtimeMs };
    const prior = originalStats.get(name);
    if (prior) assert.deepEqual(actual, prior);
    else originalStats.set(name, actual);
  }
  assert.equal(
    f.jobs.get(text(result.task_id)).artifacts.find((a) => a.artifact_id === 'edited')!.frontend_deliveries!
      .length,
    3,
  );
  await assert.rejects(f.service.download(text(result.task_id), 'preview', 'preview.png'), {
    code: 'LAB_REFERENCE_REQUIREMENT_UNVERIFIED',
  });
  assert.equal(f.posts(), 1);
});
test('Lab delivery refuses an unknown same-byte copy, symlink and replaced registered inode', async (t) => {
  const f = await setup(t);
  const result = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'delivery-identity',
    f.io,
  );
  const id = text(result.task_id);
  await f.service.get(id);
  const first = await f.service.download(id, 'edited', 'first.glb');
  const parent = path.dirname(text(first.local_path));
  await writeFile(path.join(parent, 'unknown.glb'), f.output);
  await assert.rejects(f.service.download(id, 'edited', 'unknown.glb'), { code: 'OUTPUT_EXISTS' });
  await symlink(text(first.local_path), path.join(parent, 'link.glb'));
  await assert.rejects(f.service.download(id, 'edited', 'link.glb'));
  await rename(text(first.local_path), path.join(parent, 'prior.glb'));
  await writeFile(text(first.local_path), f.output);
  await assert.rejects(f.service.download(id, 'edited', 'first.glb'), { code: 'OUTPUT_EXISTS' });
  assert.equal(f.posts(), 1);
  assert.equal(f.remoteReads(), 0);
});
test('CLI Lab download cannot bypass registered delivery identity with a same-byte replacement', async (t) => {
  const f = await setup(t);
  f.service.config.outputDir = await realpath(f.service.config.outputDir!);
  const result = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'cli-delivery',
    f.io,
  );
  const id = text(result.task_id),
    out = path.join(f.service.config.outputDir, 'cli-output');
  const delivered = await downloadTask(f.app, await f.service.get(id), { out });
  const file = text(delivered.model_file);
  await rename(file, file + '.original');
  await writeFile(file, f.output);
  await assert.rejects(downloadTask(f.app, await f.service.get(id), { out: path.dirname(file) }), {
    code: 'OUTPUT_EXISTS',
  });
  assert.equal(f.posts(), 1);
  assert.equal(f.remoteReads(), 0);
});
test('Same Lab request rejects changed image bytes, region, source or a bare backend route', async (t) => {
  const f = await setup(t);
  await executeLabReferenceEdit(f.app, f.plan, { wait: false, download: false }, 'same', f.io);
  await writeFile(
    f.imagePath,
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#cc2200' } })
      .png()
      .toBuffer(),
  );
  await assert.rejects(executeLabReferenceEdit(f.app, f.plan, { wait: false }, 'same', f.io), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  assert.throws(
    () =>
      assertLabReferenceEditPlan(f.jobs, 'test-account', 'same', {
        steps: [],
        pending_uploads: [],
        warnings: [],
        multiviewEdit: { source: 'old', prompts: [], model: 'old' },
      }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  assert.equal(f.posts(), 1);
  assert.equal(f.counts.uploads, 2);
});
test('Existing ordinary or multiview task cannot acquire new Lab obligations', async (t) => {
  const f = await setup(t);
  for (const suffix of ['-0', '-multiview']) {
    const parent = `prior${suffix}`;
    f.jobs.prepare('test-account', parent + suffix, 'image', { prompt: 'old' }, quote);
    assert.throws(() => assertLabReferenceEditPlan(f.jobs, 'test-account', parent, f.plan), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  }
  assert.equal(f.counts.create, 0);
});
test('Lab restart retains all preparation receipts and reports geometry failure without regenerating', async (t) => {
  const f = await setup(t);
  const result = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'restart',
    f.io,
  );
  f.jobs.close();
  const reopened = new JobStore(path.join(f.dir, 'jobs.sqlite'));
  f.service.jobs = reopened;
  f.gateway.status = async () => ({
    state: 'succeeded',
    progress: 100,
    artifacts: [
      { ...f.artifacts[0]!, local_path: f.modelPath, sha256: digest(f.source), bytes: f.source.length },
    ],
  });
  const view = await f.service.get(text(result.task_id));
  assert.equal(view.state, 'needs_attention');
  assert.equal(reopened.get(text(result.task_id)).state, 'succeeded');
  const prior = f.counts.calls;
  const retry = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'restart',
    f.io,
  );
  assert.equal(retry.status, 'needs_attention');
  assert.equal(f.posts(), 1);
  assert.equal(f.counts.calls, prior);
  await assert.rejects(f.service.download(text(result.task_id), 'edited', 'failed.glb'), {
    code: 'LAB_REFERENCE_REQUIREMENT_UNVERIFIED',
  });
});
test('Preparation unique attempt blocks another connection and lost create receipt is never resent', async (t) => {
  const f = await setup(t),
    second = new JobStore(path.join(f.dir, 'jobs.sqlite'));
  t.after(() => second.close());
  let sent = 0,
    finish!: (v: Record<string, unknown>) => void;
  const context = { jobs: f.jobs, account: 'test-account', parent: 'race', check: () => {} };
  const first = labJournalStep(context, 'create', { name: 'one' }, async () => {
    sent++;
    return await new Promise((resolve) => {
      finish = resolve;
    });
  });
  await assert.rejects(
    labJournalStep({ ...context, jobs: second }, 'create', { name: 'one' }, async () => {
      sent++;
      return {};
    }),
    { code: 'LAB_PREPARATION_OUTCOME_UNKNOWN' },
  );
  finish({ project_id: 'accepted' });
  await first;
  assert.equal(sent, 1);
  assert.deepEqual(
    await labJournalStep({ ...context, jobs: second }, 'create', { name: 'one' }, async () => {
      throw Error('resent');
    }),
    { project_id: 'accepted' },
  );
  await assert.rejects(
    labJournalStep({ ...context, parent: 'lost' }, 'create', {}, async () => {
      sent++;
      throw Error('connection lost');
    }),
  );
  await assert.rejects(
    labJournalStep({ ...context, jobs: second, parent: 'lost' }, 'create', {}, async () => {
      sent++;
      return {};
    }),
    { code: 'LAB_PREPARATION_OUTCOME_UNKNOWN' },
  );
  assert.equal(sent, 2);
});
test('Lab unknown paid submission is retained and same request does not invoke it twice', async (t) => {
  const f = await setup(t);
  let attempts = 0;
  f.gateway.submit = async () => {
    attempts++;
    throw new TripoError('NETWORK_ERROR', 'response lost', 'unknown');
  };
  const first = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'unknown',
    f.io,
  );
  assert.equal(first.status, 'outcome_unknown');
  const calls = f.counts.calls;
  const next = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'unknown',
    f.io,
  );
  assert.equal(next.status, 'outcome_unknown');
  assert.equal(attempts, 1);
  assert.equal(f.counts.calls, calls);
});
test('Lab registered attachment byte mismatch stops before any paid request', async (t) => {
  const f = await setup(t);
  f.io.bytes = async (id) => (id === 'input-model' ? f.output : f.image);
  await assert.rejects(executeLabReferenceEdit(f.app, f.plan, { wait: false }, 'changed-upload', f.io), {
    code: 'LAB_REFERENCE_REQUIREMENT_UNVERIFIED',
  });
  assert.equal(f.posts(), 0);
  assert.equal(f.counts.uploads, 2);
});
test('Bare TaskService cannot alter frozen Lab prompt; redo waits for a verified original', async (t) => {
  const f = await setup(t);
  const result = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'bound',
    f.io,
  );
  const job = f.jobs.get(text(result.task_id));
  await assert.rejects(f.service.submit('canvas_lab', 'bound-0', { ...job.input, prompt: 'different' }, 0), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  assert.throws(() => redoLabReferenceEditPlan(f.jobs, f.dir, job), {
    code: 'INPUT_NOT_READY',
  });
  assert.equal(f.posts(), 1);
});

test('Lab redo uses the original cached inputs and region through a fresh full preparation chain', async (t) => {
  const f = await setup(t);
  const first = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'redo-origin',
    f.io,
  );
  await f.service.get(text(first.task_id));
  const origin = f.jobs.get(text(first.task_id));
  assert.throws(() => redoLabReferenceEditPlan(f.jobs, f.dir, origin, 5), {
    code: 'STUDIO_CAPABILITY_UNAVAILABLE',
  });
  assert.throws(
    () =>
      redoLabReferenceEditPlan(f.jobs, f.dir, origin, undefined, {
        bbox: [
          [0, 0, 0],
          [1, 1, 1],
        ],
      }),
    { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
  );
  const plan = redoLabReferenceEditPlan(f.jobs, f.dir, origin)!;
  await Promise.all([rm(f.modelPath), rm(f.imagePath)]);
  const result = await executeLabReferenceEdit(
    f.app,
    plan,
    { wait: false, download: false },
    'redo-new',
    f.io,
  );
  assert.equal(result.status, 'queued');
  assert.notEqual(result.task_id, first.task_id);
  assert.equal(f.counts.create, 2);
  assert.equal(f.counts.uploads, 4);
  assert.equal(f.counts.save, 2);
  assert.equal(f.posts(), 2);
  const originalGraph = f.jobs.requestPolicy('test-account', labReferenceKey('redo-origin', 'graph'))!;
  const newGraph = f.jobs.requestPolicy('test-account', labReferenceKey('redo-new', 'graph'))!;
  assert.notEqual(originalGraph.lab_node_id, newGraph.lab_node_id);
  const resumed = await executeLabReferenceEdit(
    f.app,
    plan,
    { wait: false, download: false },
    'redo-new',
    f.io,
  );
  assert.equal(resumed.task_id, result.task_id);
  assert.equal(f.posts(), 2);
});

test('Lab task inputs prefer the exact verified delivery cache without querying an original operator', async (t) => {
  const f = await setup(t);
  const prepared = f.jobs.prepare('test-account', 'original-model', 'model', { mode: 'image' }, quote);
  f.jobs.update(prepared.job_id, 'submitted');
  const artifact: Artifact = {
    artifact_id: 'native',
    kind: 'model',
    format: 'glb',
    index: 0,
    sha256: digest(f.source),
    bytes: f.source.length,
  };
  const source = f.jobs.update(prepared.job_id, 'succeeded', {
    remote_ids: { project_id: 'frozen-project', operator_id: 'frozen-operator' },
    artifacts: [artifact],
  });
  await saveVerifiedOutputCache(
    source,
    artifact,
    { sha256: artifact.sha256!, bytes: artifact.bytes! },
    f.source,
    f.dir,
  );
  const plan = processingPlan('edit', source.job_id, {
    bbox,
    refImage: f.imagePath,
    param: { accept_variable_cost: true },
  });
  const result = await executeLabReferenceEdit(
    f.app,
    plan,
    { wait: false, download: false },
    'task-input',
    f.io,
  );
  assert.equal(result.status, 'queued');
  assert.equal(f.remoteReads(), 0);
  assert.equal(
    object(object(f.jobs.requestPolicy('test-account', labReferenceKey('task-input', 'source'))).model)
      .sha256,
    digest(f.source),
  );
});

test('Missing processed task bytes never fall back to its original Studio model', async (t) => {
  const f = await setup(t);
  const prepared = f.jobs.prepare('test-account', 'processed-model', 'model', { mode: 'image' }, quote);
  f.jobs.update(prepared.job_id, 'submitted');
  const source = f.jobs.update(prepared.job_id, 'succeeded', {
    remote_ids: { project_id: 'old', operator_id: 'old' },
    artifacts: [
      {
        artifact_id: 'processed',
        kind: 'model',
        format: 'glb',
        index: 0,
        sha256: digest(f.output),
        bytes: f.output.length,
        processing: 'local_delivery',
      },
    ],
  });
  const plan = processingPlan('edit', source.job_id, {
    bbox,
    refImage: f.imagePath,
    param: { accept_variable_cost: true },
  });
  await assert.rejects(executeLabReferenceEdit(f.app, plan, { wait: false }, 'processed-input', f.io), {
    code: 'LAB_REFERENCE_REQUIREMENT_UNVERIFIED',
  });
  assert.equal(f.remoteReads(), 0);
  assert.equal(f.counts.create, 0);
  assert.equal(f.posts(), 0);
});

test('Lost SaveCanvas response reconciles the exact graph and does not save or upload again', async (t) => {
  const f = await setup(t),
    original = f.io.call;
  let lost = true;
  f.io.call = async (name, input) => {
    const value = await original(name, input);
    if (name === 'save' && lost) {
      lost = false;
      throw new TripoError('NETWORK_ERROR', 'save response lost', 'unknown');
    }
    return value;
  };
  await assert.rejects(
    executeLabReferenceEdit(f.app, f.plan, { wait: false, download: false }, 'lost-save', f.io),
  );
  assert.equal(f.posts(), 0);
  assert.equal(f.counts.save, 1);
  const result = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'lost-save',
    f.io,
  );
  assert.equal(result.status, 'queued');
  assert.equal(f.counts.save, 1);
  assert.equal(f.counts.create, 1);
  assert.equal(f.counts.uploads, 2);
  assert.equal(f.posts(), 1);
});

test('Lost SaveCanvas response with another graph stays unknown without overwriting it', async (t) => {
  const f = await setup(t),
    original = f.io.call;
  f.io.call = async (name, input) => {
    const result = await original(name, input);
    if (name === 'save') {
      f.setGraph({
        canvas: { canvasId: 'canvas', projectId: 'project', revision: '2' },
        nodes: [],
        edges: [],
      });
      throw new TripoError('NETWORK_ERROR', 'save response lost', 'unknown');
    }
    return result;
  };
  await assert.rejects(executeLabReferenceEdit(f.app, f.plan, { wait: false }, 'ambiguous-save', f.io));
  await assert.rejects(executeLabReferenceEdit(f.app, f.plan, { wait: false }, 'ambiguous-save', f.io), {
    code: 'LAB_PREPARATION_OUTCOME_UNKNOWN',
  });
  assert.equal(f.counts.save, 1);
  assert.equal(f.posts(), 0);
});
test('Finished Lab model proof rejects changed bytes and missing parent before delivery', async (t) => {
  const f = await setup(t);
  const result = await executeLabReferenceEdit(
    f.app,
    f.plan,
    { wait: false, download: false },
    'proof',
    f.io,
  );
  await f.service.get(text(result.task_id));
  const proof = f.jobs.requestPolicy('test-account', labReferenceProofKey(f.jobs.get(text(result.task_id))))!;
  assert.equal(proof.sha256, digest(f.output));
  const tamper = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
  tamper
    .prepare('DELETE FROM request_policies WHERE account_ref=? AND request_id=?')
    .run('test-account', labReferenceKey('proof', 'registered'));
  tamper.close();
  await assert.rejects(f.service.download(text(result.task_id), 'edited', 'blocked.glb'), {
    code: 'LAB_REFERENCE_REQUIREMENT_UNVERIFIED',
  });
  assert.equal(f.posts(), 1);
});
