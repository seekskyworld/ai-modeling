/** 用独立小网格验证网页首顶点语义、几何命中、历史和原生保存边界；不只测试注册数量。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { decode } from '@msgpack/msgpack';
import { fixture } from './helpers.ts';
import { segmentationOperations } from '../cli/local/segmentation.ts';
import { segmentationGeometry, brushVertices, pickSegment } from '../cli/local/segmentation-geometry.ts';
import { loadSegmentState, applySegmentActions, segmentAction } from '../cli/local/segmentation-state.ts';
import { validateSegmentationFile } from '../studio/contracts/segmentation.ts';
import { readSegmentation } from '../studio/segmentation.ts';
import { modificationFile } from '../studio/api/advanced-operations.ts';
import { Operations } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import type { Job } from '../studio/contracts/types.ts';
import type { Config } from '../cli/core/config.ts';
import { expandSegmentationPlan, segmentTransforms } from '../cli/compat/segmentation-plan.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';

async function sourceGLB(file: string): Promise<void> {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene();
  for (let i = 0; i < 2; i++) {
    const primitive = doc
      .createPrimitive()
      .setAttribute(
        'POSITION',
        doc
          .createAccessor()
          .setType('VEC3')
          .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]))
          .setBuffer(buffer),
      )
      .setIndices(
        doc
          .createAccessor()
          .setType('SCALAR')
          .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]))
          .setBuffer(buffer),
      );
    scene.addChild(
      doc
        .createNode(`part_${i}`)
        .setMesh(doc.createMesh().addPrimitive(primitive))
        .setTranslation([0, 0, i])
        .setScale([2, 2, 2]),
    );
  }
  await writeFile(file, await new NodeIO().writeBinary(doc));
}
async function local(config: Config, name: string, input: unknown): Promise<Record<string, unknown>> {
  return (await segmentationOperations.find((x) => x.name === name)!.run(config, input)) as Record<
    string,
    unknown
  >;
}

test('ray chooses the closest world triangle and brush matches the web sphere/first-vertex rule', async () => {
  const f = await fixture();
  try {
    const model = path.join(f.dir, 'model.glb');
    await sourceGLB(model);
    const geometry = await segmentationGeometry(model, [f.dir]);
    const hit = pickSegment(geometry.meshes, [0.5, 0.5, 5], [0, 0, -2]);
    assert.equal(hit?.mesh_name, 'part_1');
    assert.equal(hit?.distance, 4);
    assert.deepEqual(hit?.point, [0.5, 0.5, 1]);
    assert.equal(pickSegment(geometry.meshes, [9, 9, 5], [0, 0, -1]), null);
    assert.throws(() => pickSegment(geometry.meshes, [0, 0, 5], [0, 0, 0]), { code: 'INVALID_INPUT' });
    assert.deepEqual([...brushVertices(geometry.meshes[0]!, [2, 0, 0], 0.01)], [0, 1, 2]);
    const state = await loadSegmentState(geometry, undefined, []);
    applySegmentActions(geometry, state, [
      segmentAction.parse({
        action: 'brush',
        point: [2, 0, 0],
        brush_size: 0.01,
        label: 1,
        mesh_names: ['part_0'],
      }),
    ]);
    // 点只触到面0的顶点1，但共享首顶点0也被刷色，所以相邻面1最终同样属于label1。
    assert.deepEqual([...Buffer.from(state.part_indices.part_0!, 'base64')], [1, 1]);
    assert.deepEqual([...Buffer.from(state.snapshot.attribute_indices.part_0!, 'base64')], [1, 1, 1, 0]);
    const transformed = await segmentationGeometry(model, [f.dir], {
      children_deleted: ['part_0'],
      children_rename: {},
      children_transform_matrix: { part_1: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1] },
    });
    assert.equal(transformed.meshes.length, 1);
    assert.equal(pickSegment(transformed.meshes, [0.5, 0.5, 5], [0, 0, -1]), null);
    assert.equal(pickSegment(transformed.meshes, [3.5, 0.5, 5], [0, 0, -1])?.mesh_name, 'part_1');
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('merge, split, rename, selection and undo/redo survive state files and reject stale sources', async () => {
  const f = await fixture();
  try {
    const model = path.join(f.dir, 'model.glb');
    await sourceGLB(model);
    const initial = path.join(f.dir, 'initial.json'),
      edited = path.join(f.dir, 'edited.json');
    const config = { ...f.service.config, outputDir: '' };
    await local(config, 'segmentation_edit', {
      model_path: model,
      destination_path: initial,
      project_id: 'project',
      expected_operator_id: 'original',
      reserved_names: ['ai_modeling_part_new_0'],
    });
    const geometry = await segmentationGeometry(model, [f.dir]),
      state = await loadSegmentState(geometry, initial, [f.dir]);
    applySegmentActions(geometry, state, [
      { action: 'select', labels: [0, 1], mode: 'set' },
      { action: 'merge' },
    ]);
    assert.deepEqual([...Buffer.from(state.part_indices.part_1!, 'base64')], [0, 0]);
    applySegmentActions(geometry, state, [{ action: 'undo' }]);
    assert.deepEqual([...Buffer.from(state.part_indices.part_1!, 'base64')], [1, 1]);
    applySegmentActions(geometry, state, [
      { action: 'redo' },
      { action: 'split', mesh_name: 'part_1', face_indices: [0] },
    ]);
    assert.equal(state.snapshot.part_names['1'], 'ai_modeling_part_new_1');
    assert.deepEqual([...Buffer.from(state.part_indices.part_1!, 'base64')], [1, 1]);
    applySegmentActions(geometry, state, [
      { action: 'rename', label: 1, name: 'top' },
      { action: 'undo' },
      { action: 'redo' },
    ]);
    assert.equal(state.snapshot.part_names['1'], 'top');
    applySegmentActions(geometry, state, [
      { action: 'pick', ray: { origin: [0.5, 0.5, 5], direction: [0, 0, -1] }, mode: 'set' },
    ]);
    assert.deepEqual(state.snapshot.selection, [1]);
    await writeFile(edited, JSON.stringify(state));
    const restored = await loadSegmentState(geometry, edited, [f.dir]);
    assert.deepEqual(restored, state);
    const preview = path.join(f.dir, 'preview.glb');
    await local(config, 'segmentation_preview', {
      model_path: model,
      state_path: edited,
      destination_path: preview,
    });
    const doc = await new NodeIO().read(preview);
    assert.equal(doc.getRoot().listMeshes().length, 2);
    assert.equal(
      doc
        .getRoot()
        .listMeshes()
        .flatMap((m) => m.listPrimitives())
        .reduce((sum, p) => sum + p.getIndices()!.getCount() / 3, 0),
      4,
    );
    await assert.rejects(
      local(config, 'segmentation_edit', {
        model_path: model,
        state_path: edited,
        destination_path: initial,
      }),
      { code: 'OUTPUT_EXISTS' },
    );
    state.source_sha256 = '0'.repeat(64);
    await writeFile(edited, JSON.stringify(state));
    await assert.rejects(loadSegmentState(geometry, edited, [f.dir]), {
      code: 'SEGMENTATION_SOURCE_CHANGED',
    });
    assert.throws(
      () =>
        applySegmentActions(geometry, restored, [
          { action: 'paint', mesh_name: 'part_0', face_indices: [2], label: 0 },
        ]),
      { code: 'SEGMENTATION_SELECTION' },
    );
    assert.throws(() =>
      segmentAction.parse({ action: 'paint', mesh_name: 'part_0', face_indices: [0], label: 256 }),
    );
    const damaged = structuredClone(restored);
    damaged.snapshot.attribute_indices.part_0 = 'AAA=';
    assert.throws(() => validateSegmentationFile(damaged), { code: 'SEGMENTATION_INVALID' });
    applySegmentActions(geometry, restored, [{ action: 'reset' }]);
    assert.equal(restored.history.undo.length, 0);
    assert.deepEqual(restored.snapshot.selection, []);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('native segmentation file uses MessagePack bin, immutable intent, project binding and operator preflight', async () => {
  const f = await fixture();
  try {
    const model = path.join(f.dir, 'model.glb'),
      statePath = path.join(f.dir, 'edit.json');
    await sourceGLB(model);
    await local({ ...f.service.config, outputDir: '' }, 'segmentation_edit', {
      model_path: model,
      destination_path: statePath,
      project_id: 'project',
      expected_operator_id: 'original',
      actions: [{ action: 'merge', labels: [0, 1] }],
    });
    const parameters = { project_id: 'project', indices_path: statePath };
    const job = await f.service.submit('modification', 'same-intent', parameters, 10);
    const saved = f.jobs.get(String(job.job_id));
    assert.equal(saved.input.expected_operator_id, 'original');
    const payload = decode(await modificationFile(saved.input, [f.dir])) as {
      part_indices: Record<string, Uint8Array>;
      part_indices_name: Record<string, string>;
    };
    assert.ok(payload.part_indices.part_0 instanceof Uint8Array);
    assert.deepEqual([...payload.part_indices.part_1!], [0, 0]);
    assert.deepEqual(payload.part_indices_name, { '0': 'part_0' });
    const repeat = await f.service.submit('modification', 'same-intent', parameters, 10);
    assert.equal(repeat.job_id, job.job_id);
    assert.equal(f.gateway.posts, 1);
    await assert.rejects(
      f.service.submit('modification', 'foreign-target', { ...parameters, project_id: 'other' }, 10),
      { code: 'SEGMENTATION_TARGET' },
    );
    let posts = 0;
    const client = {
      request: async (method: string) => {
        if (method !== 'GET') posts++;
        return { is_owner: true, operator: { operator_id: 'changed', status: 'success' } };
      },
    } as unknown as StudioClient;
    await assert.rejects(
      new Operations(client, [f.dir]).build({ ...saved, operation: 'modification' } as Job),
      { code: 'PROJECT_CHANGED' },
    );
    assert.equal(posts, 0);
    const metadataChanged = {
      request: async () => ({
        is_owner: true,
        operator: { operator_id: 'original', status: 'success', metadata: { children_deleted: ['part_1'] } },
      }),
    } as unknown as StudioClient;
    await assert.rejects(new Operations(metadataChanged, [f.dir]).build(saved), {
      code: 'SEGMENTATION_METADATA_CHANGED',
    });
    const content = JSON.parse(await readFile(statePath, 'utf8'));
    content.snapshot.selection = [];
    await writeFile(statePath, JSON.stringify(content));
    await assert.rejects(modificationFile(saved.input, [f.dir]), { code: 'INPUT_CHANGED' });
    await assert.rejects(f.service.submit('modification', 'same-intent', parameters, 10), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(f.gateway.posts, 1);
    await assert.rejects(readSegmentation(statePath, [path.join(f.dir, 'output')]), {
      code: 'INPUT_PATH_DENIED',
    });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('transformed segment saving uses native metadata/export, resumes all steps and rejects mixed transforms before submission', async () => {
  const f = await fixture();
  try {
    const model = path.join(f.dir, 'model.glb'),
      file = path.join(f.dir, 'transformed.json');
    await sourceGLB(model);
    const scale = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    await local({ ...f.service.config, outputDir: '' }, 'segmentation_edit', {
      model_path: model,
      destination_path: file,
      project_id: 'project',
      expected_operator_id: 'original',
      source_metadata: { children_transform_matrix: { part_0: scale, part_1: scale } },
      actions: [
        { action: 'merge', labels: [0, 1] },
        { action: 'rename', label: 0, name: 'merged' },
      ],
    });
    const base = {
      steps: [
        {
          name: 'modification',
          operation: 'modification' as const,
          parameters: { project_id: 'project', indices_path: file },
        },
      ],
      pending_uploads: [],
      warnings: [],
    };
    const plan = await expandSegmentationPlan(base, [f.dir]);
    assert.deepEqual(
      plan.steps.map((s) => s.operation),
      ['modification', 'project_edit', 'export'],
    );
    assert.deepEqual(plan.steps[1]!.parameters.children_transform_matrix, { merged: scale });
    f.gateway.submit = async (job) => {
      f.gateway.posts++;
      return { remote_ids: { project_id: 'project', operator_id: job.operation } };
    };
    const app = { service: f.service, studio: {} } as Application;
    const result = await executePlan(app, plan, { requestId: 'save-matrix', download: false });
    assert.equal(result.status, 'success');
    assert.equal(f.gateway.posts, 3);
    const resumed = await executePlan(app, plan, { requestId: 'save-matrix', download: false });
    assert.equal(resumed.task_id, result.task_id);
    assert.equal(f.gateway.posts, 3);
    const state = (await readSegmentation(file, [f.dir])).state;
    state.source_transforms.part_1![0] = 3;
    assert.throws(() => segmentTransforms(state), { code: 'SEGMENTATION_TRANSFORM_CONFLICT' });
    await writeFile(file, JSON.stringify(state));
    await assert.rejects(executePlan(app, base, { requestId: 'mixed', download: false }), {
      code: 'SEGMENTATION_TRANSFORM_CONFLICT',
    });
    assert.equal(f.gateway.posts, 3);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
