/** 原件快照、逐面缩放证明与查询/下载入口共用同一身份，未验证情况不影响正常导入。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { uvImportFixture, uvFixtureChunks, uvFixtureGlb } from './uv-import-fixture.ts';
import { fixture, quote } from './helpers.ts';
import { verifyImportNormalization } from '../cli/artifacts/import-normalization-proof.ts';
import { executePlan, taskResult, type Application } from '../cli/compat/runtime.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import {
  importNormalizationSourceKey,
  importNormalizationProofKey,
  importNormalizationSummary,
  assertImportNormalizationBytes,
} from '../cli/core/import-normalization-policy.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import { TripoError } from '../studio/contracts/errors.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('fixed source normalization verifies all oriented faces and leaves both byte arrays unchanged', async () => {
  const source = await uvImportFixture(false),
    output = await uvImportFixture(true),
    hashes = [hash(source), hash(output)],
    proof = await verifyImportNormalization(source, output);
  assert.equal(proof.normalize_scale, 0.5);
  assert.deepEqual(proof.source_center, [3, 4, 4]);
  assert.equal(proof.matched_oriented_faces, 2);
  assert.equal(proof.maximum_position_error, 0);
  assert.equal(proof.model_bytes_modified, false);
  assert.equal(proof.native_response_field, false);
  assert.deepEqual([hash(source), hash(output)], hashes);
});

for (const change of ['winding', 'uv', 'scale', 'geometry', 'material'])
  test(`source-derived scale cannot be accepted by bbox alone when ${change} differs`, async () => {
    await assert.rejects(
      verifyImportNormalization(await uvImportFixture(false), await uvImportFixture(true, change)),
      { code: 'IMPORT_NORMALIZATION_UNVERIFIED' },
    );
  });

async function setup(change = '') {
  const f = await fixture(),
    input = path.join(f.dir, 'source.glb'),
    output = path.join(f.dir, 'native.glb'),
    sourceBytes = await uvImportFixture(false),
    outputBytes = await uvImportFixture(true, change);
  await writeFile(input, sourceBytes);
  await writeFile(output, outputBytes);
  const artifact: Artifact = {
    artifact_id: 'model',
    kind: 'model',
    format: 'glb',
    index: 0,
    local_path: output,
    sha256: hash(outputBytes),
    bytes: outputBytes.length,
  };
  f.gateway.submit = async (job: Job) => {
    f.gateway.posts++;
    return { remote_ids: { project_id: 'project-one', operator_id: `operator-${job.request_id}` } };
  };
  f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [artifact] });
  f.gateway.artifactUrl = async () => {
    throw new TripoError('DOWNLOAD_FAILED', 'The original artifact URL is unavailable.', 'read');
  };
  const parameters = { model_path: input, name: 'scale proof' };
  return {
    ...f,
    input,
    output,
    sourceBytes,
    outputBytes,
    artifact,
    parameters,
    submit: async (request = 'normalize', values = parameters) =>
      f.service.submit('import_model', request, values, 100),
    close: async () => {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    },
  };
}

test('new import freezes exact source before submission and get/list/taskResult retain verified scale', async () => {
  const f = await setup();
  try {
    const submitted = await f.submit(),
      source = f.jobs.requestPolicy('test-account', importNormalizationSourceKey('normalize'))!;
    assert.equal(source.status, 'eligible');
    assert.equal(source.source_sha256, hash(f.sourceBytes));
    assert.equal(submitted.normalize_scale, undefined);
    await rm(f.input);
    const result = await f.service.get(String(submitted.job_id));
    assert.equal(result.state, 'succeeded');
    assert.equal(result.normalize_scale, 0.5);
    assert.equal(result.normalize_scale_provenance, 'derived_from_verified_studio_import');
    assert.equal(taskResult(result).normalize_scale, 0.5);
    assert.equal(f.service.summary(f.jobs.get(String(result.job_id))).normalize_scale, 0.5);
    assert.equal((await f.service.get(String(result.job_id))).normalize_scale, 0.5);
    assert.equal(f.gateway.posts, 1);
  } finally {
    await f.close();
  }
});

test('changed surface keeps native success while omitting the unverified optional scalar', async () => {
  const f = await setup('geometry');
  try {
    const submitted = await f.submit(),
      result = await f.service.get(String(submitted.job_id));
    assert.equal(result.state, 'succeeded');
    assert.equal(result.normalize_scale, undefined);
    assert.equal((result.normalize_scale_validation as Record<string, unknown>).status, 'unverified');
    assert.equal(
      f.jobs.requestPolicy('test-account', importNormalizationProofKey(f.jobs.get(String(result.job_id)))),
      undefined,
    );
    assert.equal(f.gateway.posts, 1);
  } finally {
    await f.close();
  }
});

test('unsupported static shape and nonidentity request are not new submission restrictions', async () => {
  const f = await setup();
  try {
    const chunks = uvFixtureChunks(f.sourceBytes);
    chunks.json.animations = [{ name: 'unsupported', channels: [], samplers: [] }];
    await writeFile(f.input, uvFixtureGlb(chunks.json, chunks.binary));
    const submitted = await f.submit('animated'),
      result = await f.service.get(String(submitted.job_id));
    assert.equal(result.state, 'succeeded');
    assert.equal(result.normalize_scale, undefined);
    assert.equal(
      f.jobs.requestPolicy('test-account', importNormalizationSourceKey('animated'))!.status,
      'unavailable',
    );
    await writeFile(f.input, f.sourceBytes);
    const rotated = await f.service.submit(
      'import_model',
      'rotated',
      {
        ...f.parameters,
        transform_matrix: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      100,
    );
    const rotatedResult = await f.service.get(String(rotated.job_id));
    assert.equal(rotatedResult.state, 'succeeded');
    assert.equal(rotatedResult.normalize_scale, undefined);
    assert.equal(f.gateway.posts, 2);
  } finally {
    await f.close();
  }
});

test('old success without pre-submission snapshot is never upgraded from the current path', async () => {
  const f = await setup();
  try {
    const job = f.jobs.prepare('test-account', 'old', 'import_model', f.parameters, quote);
    f.jobs.update(job.job_id, 'submitted', { remote_ids: { project_id: 'old', operator_id: 'old' } });
    f.jobs.update(job.job_id, 'succeeded', { artifacts: [f.artifact], progress: 100 });
    const result = await f.service.get(job.job_id);
    assert.equal(result.normalize_scale, undefined);
    assert.match(
      String((result.normalize_scale_validation as Record<string, unknown>).reason),
      /no source snapshot/,
    );
    assert.equal(f.jobs.requestPolicy('test-account', importNormalizationSourceKey('old')), undefined);
    assert.equal(f.gateway.posts, 0);
  } finally {
    await f.close();
  }
});

test('missing frozen source prevents new proof and does not regenerate', async () => {
  const f = await setup();
  try {
    const submitted = await f.submit();
    await rm(path.join(f.dir, 'verified-output-cache'), { recursive: true });
    const result = await f.service.get(String(submitted.job_id));
    assert.equal(result.state, 'succeeded');
    assert.equal(result.normalize_scale, undefined);
    assert.match(
      String((result.normalize_scale_validation as Record<string, unknown>).reason),
      /cache is missing/,
    );
    assert.equal(f.gateway.posts, 1);
  } finally {
    await f.close();
  }
});

test('failed and ambiguous requests never report scale or create a surface proof', async () => {
  const f = await setup();
  try {
    f.gateway.failSubmit = new TripoError('REMOTE_TIMEOUT', 'No receipt', 'unknown');
    f.gateway.submit = async () => {
      f.gateway.posts++;
      throw f.gateway.failSubmit;
    };
    const unknown = await f.submit('unknown');
    assert.equal(unknown.normalize_scale, undefined);
    assert.equal(
      f.jobs.requestPolicy('test-account', importNormalizationProofKey(f.jobs.get(String(unknown.job_id)))),
      undefined,
    );
    assert.equal(f.gateway.posts, 1);
  } finally {
    await f.close();
  }
});

test('proof identity and native bytes guard subsequent downloads and allow exact cache recovery', async () => {
  const f = await setup();
  try {
    const submitted = await f.submit(),
      result = await f.service.get(String(submitted.job_id)),
      job = f.jobs.get(String(result.job_id));
    assert.equal(importNormalizationSummary(f.jobs, job).normalize_scale, 0.5);
    assert.throws(() => assertImportNormalizationBytes(f.jobs, job, f.artifact, f.sourceBytes), {
      code: 'IMPORT_NORMALIZATION_CONTENT_CHANGED',
    });
    await rm(f.output);
    const file = await f.service.download(job.job_id, 'model', 'restored.glb');
    assert.equal(hash(await readFile(String(file.local_path))), hash(f.outputBytes));
    assert.equal(f.gateway.posts, 1);
    const changed = { ...job, remote_ids: { ...job.remote_ids, operator_id: 'changed' } };
    assert.equal(importNormalizationSummary(f.jobs, changed).normalize_scale, undefined);
  } finally {
    await f.close();
  }
});

test('file import pipeline carries initial scale into final CLI JSON and task.json; task IDs do not infer it', async () => {
  const f = await setup();
  try {
    const app = {
        service: f.service,
        studio: {
          client: {
            request: async () => {
              throw Error('Unexpected API read');
            },
          },
        },
      } as unknown as Application,
      plan = processingPlan('import', f.input, {});
    plan.steps.push({
      name: 'decimate',
      operation: 'remesh',
      parameters: { project_id: 'project-one', face_limit: 1000 },
    });
    const result = await executePlan(app, plan, { requestId: 'chain', download: false, maxCredits: 100 });
    assert.equal(result.normalize_scale, 0.5);
    assert.equal((result.chain as Record<string, unknown>[])[0]!.normalize_scale, 0.5);
    assert.equal(taskResult(await f.service.get(String(result.task_id))).normalize_scale, undefined);
    const downloaded = await executePlan(app, plan, {
      requestId: 'chain',
      maxCredits: 100,
      out: path.join(f.dir, 'output', 'chain-output'),
    });
    assert.equal(downloaded.download_error, undefined, JSON.stringify(downloaded.download_error));
    const metadata = JSON.parse(await readFile(String(downloaded.task_file), 'utf8'));
    assert.equal(downloaded.normalize_scale, 0.5);
    assert.equal(metadata.normalize_scale, 0.5);
    assert.equal(metadata.normalize_scale_provenance, 'derived_from_verified_studio_import');
    assert.equal(f.gateway.posts, 2);
  } finally {
    await f.close();
  }
});
