import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Document, NodeIO } from '@gltf-transform/core';
import { fixture, quote } from './helpers.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import {
  labReferenceKey,
  labReferenceJobKey,
  labReferenceIdentity,
  labReferenceProofKey,
} from '../cli/compat/lab-reference-edit-policy.ts';
import { saveVerifiedOutputCache } from '../cli/artifacts/verified-output-cache.ts';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { object } from '../studio/contracts/errors.ts';

export async function labSourceModel(
  options: {
    normalized?: boolean;
    reversed?: boolean;
    moved?: boolean;
    normalChanged?: boolean;
    materialChanged?: boolean;
    partition?: boolean;
    swapGroups?: boolean;
    reorderGroups?: boolean;
    renameGroup?: boolean;
  } = {},
): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const base = [
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0, 0.5, 0.5,
  ];
  const positions = base.map((v, i) => (options.normalized ? v : v * 4 + [3, -2, 5][i % 3]!));
  if (options.moved) positions[0]! += 0.005;
  const normals = Array.from({ length: 6 }, () => [
    0.3,
    0.4,
    options.normalChanged ? -Math.sqrt(0.75) : Math.sqrt(0.75),
  ]).flat();
  const normalArray = options.normalized
    ? new Int8Array(normals.map((v) => Math.round(v * 127)))
    : new Float32Array(normals);
  const p = doc
    .createPrimitive()
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer),
    )
    .setAttribute(
      'NORMAL',
      doc
        .createAccessor()
        .setType('VEC3')
        .setArray(normalArray)
        .setNormalized(options.normalized ?? false)
        .setBuffer(buffer),
    )
    .setIndices(
      doc
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Uint16Array(options.reversed ? [0, 2, 1, 3, 4, 5] : [0, 1, 2, 3, 4, 5]))
        .setBuffer(buffer),
    );
  if (options.materialChanged) p.setMaterial(doc.createMaterial().setBaseColorFactor([1, 0, 0, 1]));
  const scene = doc.createScene();
  if (options.partition) {
    const groups = [0, 1].map((i) => {
      const primitive = p.clone().setIndices(
        doc
          .createAccessor()
          .setType('SCALAR')
          .setArray(new Uint16Array([i * 3, i * 3 + 1, i * 3 + 2]))
          .setBuffer(buffer),
      );
      const name = ['mask_186ee6', 'mask_e04138'][options.swapGroups ? 1 - i : i]!;
      return doc
        .createNode(options.renameGroup && i === 0 ? 'changed-group' : name)
        .setMesh(doc.createMesh().addPrimitive(primitive));
    });
    if (options.reorderGroups) groups.reverse();
    for (const node of groups) scene.addChild(node);
    p.dispose();
  } else
    scene.addChild(
      doc
        .createNode(options.normalized ? 'short-name' : 'original-name')
        .setMesh(doc.createMesh().addPrimitive(p)),
    );
  return Buffer.from(await new NodeIO().writeBinary(doc));
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function labSourceFixture(t: TestContext, kind?: 'projected_segment') {
  const f = await fixture();
  t.after(async () => {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  const original = await labSourceModel({ partition: Boolean(kind) }),
    normalized = await labSourceModel({ normalized: true, partition: Boolean(kind) }),
    account = 'test-account';
  const parent = 'lab-source-original',
    request = parent + '-0';
  const intent = {
    version: 1,
    backend: 'studio_lab',
    source: '/original.glb',
    reference: '/reference.png',
    ...(kind
      ? {
          kind,
          projection: [
            [0, 0, 440, 256],
            [0, -440, 0, 256],
          ],
        }
      : {
          bbox: [
            [0, 0, 0],
            [1, 1, 1],
          ],
        }),
    accept_variable_cost: true,
  };
  const parameters = {
    node_id: 'lab-node',
    prompt: 'Use reference shape inside the selected box.',
    asset_ids: ['input-model', 'input-image'],
    accept_variable_cost: true,
  };
  const file = {
    sha256: digest(original),
    bytes: original.length,
    format: 'glb',
    cache_path: '/source.glb',
    cache_data_dir: f.dir,
    provenance: {},
  };
  const source = {
    version: 1,
    intent: fingerprint(intent),
    model: file,
    image: { ...file, format: 'png' },
    geometry: kind ? { faces: 2 } : {},
  };
  const graph = {
    version: 1,
    project_id: 'canvas-project',
    canvas_id: 'canvas',
    lab_node_id: 'lab-node',
    model_asset_id: 'input-model',
    image_asset_id: 'input-image',
  };
  f.jobs.bindRequestPolicy(account, labReferenceKey(parent, 'intent'), intent);
  f.jobs.bindRequestPolicy(account, labReferenceKey(parent, 'source'), source);
  f.jobs.bindRequestPolicy(account, labReferenceKey(parent, 'graph'), graph);
  f.jobs.bindRequestPolicy(account, labReferenceKey(parent, 'registered'), {
    version: 1,
    graph: fingerprint(graph),
    model_sha256: file.sha256,
    image_sha256: file.sha256,
  });
  for (const stage of ['create', 'upload-model', 'upload-image', 'save']) {
    const started = { attempt: stage, parameters: { stage }, input: fingerprint({ stage }) };
    f.jobs.bindRequestPolicy(account, labReferenceKey(parent, `${stage}:start`), started);
    f.jobs.bindRequestPolicy(account, labReferenceKey(parent, `${stage}:receipt`), {
      attempt: stage,
      input: started.input,
    });
  }
  f.jobs.bindRequestPolicy(account, labReferenceJobKey(request), {
    version: 1,
    parent,
    intent: fingerprint(intent),
    source,
    parameters,
  });
  const prepared = f.jobs.prepare(account, request, 'canvas_lab', parameters, quote);
  const artifact = { artifact_id: 'lab-artifact', kind: 'model' as const, format: 'glb', index: 0 };
  const job = f.jobs.update(prepared.job_id, 'succeeded', {
    remote_ids: { task_id: 'lab-remote' },
    artifacts: [artifact],
  });
  f.jobs.bindRequestPolicy(account, labReferenceProofKey(job), {
    version: 1,
    parent,
    identity: labReferenceIdentity(job, artifact),
    source_sha256: file.sha256,
    reference_sha256: file.sha256,
    sha256: file.sha256,
    bytes: file.bytes,
    cache_data_dir: f.dir,
    validation: kind
      ? {
          status: 'verified',
          groups: ['mask_186ee6', 'mask_e04138'],
          expected_group_faces: { mask_186ee6: 1, mask_e04138: 1 },
          actual_group_faces: { mask_186ee6: 1, mask_e04138: 1 },
          output: { sha256: file.sha256, bytes: file.bytes, faces: 2 },
          matched_original_faces: 2,
          projection: object(intent).projection,
          reference_sha256: file.sha256,
          native_v2_engine: false,
          vertex_tolerance: 0.00004,
          normal_tolerance_radians: 0.002,
          max_vertex_error: 0,
          max_normal_angle_radians: 0,
          missing_faces: 0,
          wrong_group_faces: 0,
          camera_inferred: false,
          semantic_labels_inferred: false,
          assignment: 'original_world_triangle_centroid_nearest_pixel_including_hidden_faces',
        }
      : { status: 'verified', bbox: object(intent).bbox },
  });
  await saveVerifiedOutputCache(job, artifact, file, original, f.dir);
  const bearer =
    'eyJhbGciOiJIUzI1NiJ9.' +
    Buffer.from(JSON.stringify({ sub: account, exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      'base64url',
    ) +
    '.fixture';
  const credentials = new MemoryCredentials({
    accountRef: account,
    bearer,
    deviceId: 'fixture',
    importedAt: '',
  });
  const modelUrl =
    'https://tripo-data.rg1.data.tripo3d.com/tripo-studio/studio-operator/model.glb?variant=stored&Signature=test&Expires=1';
  const detail = {
    id: 'studio-project',
    operator_id: 'studio-operator',
    type: 'upload',
    status: 'success',
    is_owner: true,
    is_pbr: false,
    model_url: modelUrl,
    metadata: {
      transform_matrix: [],
      children_deleted: [],
      children_transform_matrix: {},
      children_rename: {},
      material_factor: { metallic: 0, roughness: 0.5 },
    },
  };
  const state = {
    lab: {
      jobId: 'lab-remote',
      status: 'completed',
      prompt: parameters.prompt,
      inputs: parameters.asset_ids.map((assetId) => ({ assetId })),
      artifacts: [
        {
          artifactId: artifact.artifact_id,
          nodeAssetId: 'node-asset',
          kind: 'model',
          byteSize: String(original.length),
          studioState: 'STUDIO_ASSET_STATE_READY',
          downloadUrl:
            'https://tripo-data.s3.us-west-2.amazonaws.com/canvas/lab/lab-artifact/edited.glb?x-id=GetObject&X-Amz-Signature=fixture&X-Amz-Expires=1',
        },
      ],
    },
    listed: {
      nodes: [
        {
          nodeId: 'lab-node',
          assets: [
            {
              assetId: 'node-asset',
              nodeId: 'lab-node',
              kind: 'ASSET_KIND_MODEL',
              source: 'ASSET_SOURCE_STUDIO',
              studioState: 'STUDIO_ASSET_STATE_READY',
              url: 'https://tripo-data.rg1.data.tripo3d.com/canvas/lab/lab-artifact/edited.glb',
            },
          ],
        },
      ],
    },
    detail: { assetId: 'node-asset', provider: 'studio', detail },
    project: { id: 'studio-project', is_owner: true, model_url: modelUrl, operator: structuredClone(detail) },
    onRead: (_method: string) => {},
  };
  const calls: string[] = [];
  const client = new StudioClient(credentials, async (url, init) => {
    const method = new Headers(init.headers).get('x-micro-method') ?? new URL(url).pathname;
    calls.push(method);
    state.onRead(method);
    if (method.endsWith('/GetLabJob')) return Response.json(state.lab);
    if (method.endsWith('/ListNodesAssets')) return Response.json(state.listed);
    if (method.endsWith('/GetNodeAssetDetail')) {
      assert.equal(object(JSON.parse(String(init.body))).assetId, 'node-asset');
      return Response.json(state.detail);
    }
    assert.equal(init.method, 'GET');
    assert.equal(new URL(url).searchParams.get('operator_id'), 'studio-operator');
    return Response.json({ code: 0, data: state.project });
  });
  let downloads = 0;
  const context = {
    jobs: f.jobs,
    client,
    dataDir: f.dir,
    accountRef: () => account,
    fetcher: async (_url: string, init: RequestInit) => {
      assert.equal(new Headers(init.headers).has('authorization'), false);
      downloads++;
      return new Response(new Uint8Array(normalized));
    },
  };
  return {
    ...f,
    context,
    original,
    normalized,
    job,
    artifact: { ...artifact, bytes: original.length },
    state,
    calls,
    credentials,
    downloads: () => downloads,
    parent,
  };
}
