/** 三步流程的离线原生原件夹具；不连接账号或生产数据库。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import { modelIO } from '../cli/local/gltf.ts';
import { fixture, quote } from './helpers.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import type { Application } from '../cli/compat/runtime.ts';
import { smartSegmentIdentity } from '../cli/compat/smartsegment-scale-plan.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';

export const scaleMatrix = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1];
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export async function scaleModel(matrix = smartSegmentIdentity, roughness = 0.5): Promise<Buffer> {
  const d = new Document(),
    b = d.createBuffer();
  const positions = [
    [-0.5, -0.4, -0.3],
    [0.5, -0.4, -0.3],
    [0, 0.4, -0.3],
    [0, 0, 0.3],
  ];
  const values = positions.flatMap((p) =>
    [0, 1, 2].map(
      (i) => matrix[i]! * p[0]! + matrix[4 + i]! * p[1]! + matrix[8 + i]! * p[2]! + matrix[12 + i]!,
    ),
  );
  const a = (type: 'VEC3' | 'VEC2', data: number[]) =>
    d.createAccessor().setType(type).setArray(new Float32Array(data)).setBuffer(b);
  const p = d
    .createPrimitive()
    .setAttribute('POSITION', a('VEC3', values))
    .setAttribute('NORMAL', a('VEC3', [1, 0, 0, 0, 1, 0, 0, 0, 1, -1, 0, 0]))
    .setAttribute('TEXCOORD_0', a('VEC2', [0, 0, 1, 0, 0, 1, 0.8, 0.7]))
    .setIndices(
      d
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Uint16Array([0, 1, 2, 0, 3, 1, 1, 3, 2, 2, 3, 0]))
        .setBuffer(b),
    )
    .setMaterial(d.createMaterial().setMetallicFactor(0).setRoughnessFactor(roughness));
  d.createScene().addChild(d.createNode('editable-mesh').setMesh(d.createMesh().addPrimitive(p)));
  return Buffer.from(await (await modelIO()).writeBinary(d));
}
const emptyMetadata = (): Record<string, unknown> => ({
  children_deleted: [],
  children_rename: {},
  children_transform_matrix: {},
  material_factor: { metallic: 0, roughness: 0.5 },
});
export async function scaleFixture(
  options: {
    reference?: boolean;
    wrongOutput?: boolean;
    matrix?: number[];
    nativeRoughness?: number;
    sourceBytes?: Buffer;
    outputBytes?: Buffer;
  } = {},
) {
  const f = await fixture(),
    matrix = options.matrix ?? scaleMatrix,
    input = path.join(f.dir, 'source.glb'),
    native = path.join(f.dir, 'native.glb'),
    output = path.join(f.dir, 'segmented.glb');
  const sourceBytes =
      options.sourceBytes ?? (await scaleModel(smartSegmentIdentity, options.nativeRoughness)),
    outputBytes =
      options.outputBytes ??
      (await scaleModel(options.wrongOutput ? smartSegmentIdentity : matrix, options.nativeRoughness));
  await writeFile(input, sourceBytes);
  await writeFile(native, sourceBytes);
  await writeFile(output, outputBytes);
  const model = (file: string, bytes: Buffer): Artifact => ({
    artifact_id: 'model',
    kind: 'model',
    format: 'glb',
    index: 0,
    local_path: file,
    sha256: sha(bytes),
    bytes: bytes.length,
  });
  const sourceArtifact = model(native, sourceBytes),
    outputArtifact = model(output, outputBytes);
  const original = f.jobs.prepare(
    'test-account',
    'fixture-original',
    'import_model',
    { name: 'original', model_path: native },
    quote,
  );
  f.jobs.update(original.job_id, 'succeeded', {
    remote_ids: { project_id: 'original-project', operator_id: 'original-one' },
    artifacts: [sourceArtifact],
  });
  const states = new Map<string, Record<string, unknown>>([['original-one', emptyMetadata()]]);
  let current = 'base-one';
  const submissions: Job[] = [],
    reads: string[] = [];
  const client = {
    forAccount(account: string) {
      assert.equal(account, f.service.accountRef());
      return client;
    },
    async request(method: string, url: string) {
      assert.equal(method, 'GET');
      reads.push(url);
      const parsed = new URL(url, 'https://example.invalid'),
        project = parsed.pathname.split('/').at(-1)!,
        operator =
          parsed.searchParams.get('operator_id') ??
          (project === 'original-project' ? 'original-one' : current);
      return {
        id: project,
        is_owner: true,
        model_url: 'https://example.invalid/source.glb',
        operator: {
          operator_id: operator,
          status: 'success',
          is_rigged: false,
          metadata: states.get(operator) ?? emptyMetadata(),
        },
      };
    },
  };
  f.gateway.submit = async (job: Job) => {
    f.gateway.posts++;
    submissions.push(job);
    const operator =
      job.operation === 'project_edit'
        ? 'edit-one'
        : job.operation === 'segment'
          ? 'segment-one'
          : 'base-one';
    if (['project_edit', 'segment'].includes(job.operation))
      assert.equal(job.input.expected_operator_id, current);
    if (job.operation === 'project_edit') {
      assert.deepEqual(job.input.expected_metadata, states.get(current));
      states.set(
        operator,
        Object.fromEntries(
          ['children_deleted', 'children_rename', 'children_transform_matrix', 'material_factor'].map((k) => [
            k,
            job.input[k],
          ]),
        ),
      );
    } else states.set(operator, emptyMetadata());
    current = operator;
    return { remote_ids: { project_id: 'private-copy-project', operator_id: operator } };
  };
  f.gateway.status = async (job: Job) => ({
    state: 'succeeded',
    progress: 100,
    artifacts:
      job.operation === 'segment'
        ? [outputArtifact, { artifact_id: 'semantic-mask', kind: 'image', format: 'png', index: 1 }]
        : [sourceArtifact],
  });
  f.gateway.artifactUrl = async () => {
    throw new TripoError(
      'NETWORK_ERROR',
      'The original URL is intentionally unavailable in this fixture.',
      'read',
    );
  };
  const app = { service: f.service, studio: { client } } as unknown as Application;
  const source = options.reference ? original.job_id : input;
  return {
    ...f,
    app,
    input,
    native,
    output,
    source,
    sourceBytes,
    outputBytes,
    sourceArtifact,
    outputArtifact,
    original,
    submissions,
    reads,
    states,
    client,
    flags: { requestId: 'metadata-scale', maxCredits: 100, download: false, open: false },
    plan: (override?: number[]) =>
      processingPlan('smartsegment', source, {
        param: { transform: override ?? matrix, granularity: 'coarse', hint: 'head' },
      }),
    current: () => current,
    setCurrent: (value: string) => {
      current = value;
    },
    modelJob: () => f.jobs.find('test-account', 'metadata-scale-2')!,
    originalMetadata: () => object(states.get('original-one')),
    readOutput: () => readFile(output),
    close: async () => {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    },
  };
}
