/** UV压缩组合的来源/回执/字节证明和恢复测试，不调用真实网页或钱包。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture, quote } from './helpers.ts';
import { uvImportFixture, uvFixtureChunks, uvFixtureGlb } from './uv-import-fixture.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Job } from '../studio/contracts/types.ts';
import type { StudioClient } from '../studio/api/client.ts';
import { prepareUvImport, freezeUvImportLayout } from '../cli/compat/uv-import.ts';
import {
  uvImportPolicyKey,
  uvImportProofKey,
  rejectUvImportContinuation,
} from '../cli/core/uv-import-policy.ts';
import { ensureUvImport } from '../cli/artifacts/uv-import-output.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { executePlan, taskResult, type Application } from '../cli/compat/runtime.ts';
import { validatePlanFiles } from '../cli/compat/plan-files.ts';

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
async function sourceFor(f: Awaited<ReturnType<typeof fixture>>): Promise<Job> {
  const bytes = await uvImportFixture(false),
    file = path.join(f.dir, 'original.glb');
  await writeFile(file, bytes);
  const job = f.jobs.prepare(
    'test-account',
    'uv-original',
    'uv_commit',
    normalize('uv_commit', {
      project_id: 'project',
      current_operator_id: 'base',
      candidate_operator_id: 'candidate',
    }),
    quote,
  );
  return f.jobs.update(job.job_id, 'succeeded', {
    remote_ids: { project_id: 'project', operator_id: 'applied' },
    artifacts: [
      {
        artifact_id: 'model',
        kind: 'model',
        format: 'glb',
        index: 0,
        local_path: file,
        sha256: hash(bytes),
        bytes: bytes.length,
      },
    ],
  });
}
function context(f: Awaited<ReturnType<typeof fixture>>) {
  return { jobs: f.jobs, gateway: f.gateway, dataDir: f.dir, account: 'test-account' };
}
const input = () =>
  normalize('import_model', { model_path: 'upstream', name: 'uv-compressed', use_original_uv: true });
async function imported(f: Awaited<ReturnType<typeof fixture>>, source: Job, request: string): Promise<Job> {
  const parameters = await prepareUvImport(context(f), request, input(), source);
  const job = f.jobs.prepare('test-account', request, 'import_model', parameters, quote);
  return f.jobs.update(job.job_id, 'succeeded', {
    remote_ids: { project_id: 'imported', operator_id: 'new' },
    artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
  });
}

test('UV压缩显式组合及恢复布局固定；旧UV链不能隐式追加导入', async () => {
  const f = await fixture();
  try {
    const plan = processingPlan('uv', '@source', { param: { bake: false, compress: 'geometry' } });
    assert.deepEqual(
      plan.steps.map((step) => step.operation),
      ['uv_generate', 'uv_commit', 'import_model'],
    );
    assert.equal(plan.steps.at(-1)!.uvImportFromChain, true);
    assert.deepEqual(await validatePlanFiles(plan), []);
    freezeUvImportLayout(context(f), plan, 'layout');
    freezeUvImportLayout(context(f), plan, 'layout');
    assert.throws(() => freezeUvImportLayout(context(f), processingPlan('uv', '@source', {}), 'layout'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.throws(
      () => processingPlan('uv', '@source', { param: { compress: 'geometry', export_orientation: '+x' } }),
      { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
    );
    const source = await sourceFor(f);
    f.jobs.prepare('test-account', 'old-0', 'uv_commit', source.input, quote);
    assert.throws(() => freezeUvImportLayout(context(f), plan, 'old'), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.throws(
      () =>
        freezeUvImportLayout(context(f), { ...plan, steps: [...plan.steps, plan.steps[0]!] }, 'continued'),
      { code: 'UV_COMPRESSION_CONTINUATION_UNVERIFIED' },
    );
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('UV源和输入在导入前冻结，断点重入不重新下载且换选项/源拒绝', async () => {
  const f = await fixture();
  try {
    const source = await sourceFor(f),
      parameters = await prepareUvImport(context(f), 'pending', input(), source);
    assert.equal(f.gateway.posts, 0);
    assert.ok(f.jobs.requestPolicy('test-account', uvImportPolicyKey('pending')));
    await rm(source.artifacts[0]!.local_path!);
    f.gateway.artifactUrl = async () => {
      throw Error('Frozen cache must be used');
    };
    assert.deepEqual(await prepareUvImport(context(f), 'pending', input(), source), parameters);
    await assert.rejects(
      f.service.submit('import_model', 'pending', { ...parameters, use_original_uv: false }, 10),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    await assert.rejects(prepareUvImport(context(f), 'pending', { ...input(), name: 'changed' }, source), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await writeFile(String(parameters.model_path), await uvImportFixture(true));
    await assert.rejects(f.service.submit('import_model', 'pending', parameters, 10), {
      code: 'INPUT_CHANGED',
    });
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.find('test-account', 'pending'), undefined);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('无下载也验证实际UV压缩与坐标，后续列表/离线交付复用原证明', async () => {
  const f = await fixture();
  try {
    const source = await sourceFor(f),
      job = await imported(f, source, 'result'),
      native = await uvImportFixture(true);
    assert.equal(f.service.summary(job).state, 'needs_attention');
    await ensureUvImport(job, f.jobs, f.dir, f.gateway, async () => new Response(new Uint8Array(native)));
    f.gateway.artifactUrl = async () => {
      throw Error('Offline');
    };
    const view = await f.service.get(job.job_id);
    assert.equal(view.state, 'succeeded');
    assert.equal(
      (view.uv_compression_validation as Record<string, unknown>).original_uv_task_id,
      source.job_id,
    );
    assert.deepEqual(taskResult(view).uv_compression_validation, view.uv_compression_validation);
    assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'succeeded');
    const saved = await f.service.download(job.job_id, 'model', 'compressed.glb');
    const proof = f.jobs.requestPolicy('test-account', uvImportProofKey(job, job.artifacts[0]!))!;
    assert.equal(hash(await readFile(String(saved.local_path))), proof.sha256);
    assert.equal(proof.maximum_position_error, 0);
    assert.equal(proof.matched_faces, 2);
    assert.throws(() => rejectUvImportContinuation(f.jobs, job), {
      code: 'UV_COMPRESSION_CONTINUATION_UNVERIFIED',
    });
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('UV错误产物保留远端成功回执，缺证明及更换身份均不能报告通过', async () => {
  const f = await fixture();
  try {
    const source = await sourceFor(f),
      job = await imported(f, source, 'bad'),
      changed = await uvImportFixture(true, 'uv');
    await assert.rejects(
      ensureUvImport(job, f.jobs, f.dir, f.gateway, async () => new Response(new Uint8Array(changed))),
      { code: 'UV_COMPRESSION_REQUIREMENT_FAILED' },
    );
    assert.equal(f.jobs.get(job.job_id).state, 'succeeded');
    assert.equal(f.jobs.requestPolicy('test-account', uvImportProofKey(job, job.artifacts[0]!)), undefined);
    assert.equal(f.service.summary(job).state, 'needs_attention');
    f.gateway.artifactUrl = async () => {
      f.jobs.update(job.job_id, 'succeeded', {
        remote_ids: { project_id: 'imported', operator_id: 'changed' },
      });
      return 'https://cdn.tripo3d.ai/original.glb';
    };
    await assert.rejects(
      ensureUvImport(job, f.jobs, f.dir, f.gateway, async () => new Response(new Uint8Array(changed))),
      { code: 'UV_COMPRESSION_IDENTITY_CHANGED' },
    );
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

for (const unquoted of [false, true])
  test(`完整兼容运行器串接三步骤，无下载终态验收且重入不追加提交（未预报价=${unquoted}）`, async () => {
    const f = await fixture();
    try {
      const submitted: Array<{ operation: string; maximum: number | undefined }> = [];
      const submit = f.service.submit.bind(f.service);
      f.service.submit = async (operation, request, params, maximum) => {
        submitted.push({ operation, maximum });
        return await submit(operation, request, params, maximum);
      };
      if (unquoted)
        f.service.pricing.quote = async (operation) =>
          operation === 'import_model'
            ? { ...quote, known: false, credits: undefined, variable: true }
            : quote;
      const source = await sourceFor(f),
        native = await uvImportFixture(true),
        nativePath = path.join(f.dir, 'imported.glb');
      await writeFile(nativePath, native);
      f.gateway.submit = async (job) => {
        f.gateway.posts++;
        return {
          remote_ids: {
            project_id: job.operation === 'import_model' ? 'imported' : 'project',
            operator_id: job.operation,
          },
          status: {
            state: 'succeeded' as const,
            progress: 100,
            artifacts:
              job.operation === 'uv_generate'
                ? []
                : job.operation === 'uv_commit'
                  ? source.artifacts
                  : [
                      {
                        artifact_id: 'model',
                        kind: 'model' as const,
                        format: 'glb',
                        index: 0,
                        local_path: nativePath,
                        sha256: hash(native),
                        bytes: native.length,
                      },
                    ],
          },
        };
      };
      const client = {
        request: async () => {
          throw Error('No network read needed for an exact local source');
        },
      } as unknown as StudioClient;
      const app = { service: f.service, studio: { client } } as Application,
        plan = processingPlan('uv', source.job_id, {
          param: { bake: false, compress: 'geometry', ...(unquoted ? { accept_variable_cost: true } : {}) },
        }),
        flags = { requestId: 'full-uv', wait: true, download: false };
      const first = await executePlan(app, plan, flags);
      assert.equal(first.status, 'success');
      assert.equal(first.type, 'smart_uv');
      assert.equal((first.uv_compression_validation as Record<string, unknown>).status, 'verified');
      assert.equal(f.gateway.posts, 3);
      assert.deepEqual(submitted, [
        { operation: 'uv_generate', maximum: 10 },
        { operation: 'uv_commit', maximum: 10 },
        { operation: 'import_model', maximum: unquoted ? undefined : 10 },
      ]);
      await rm(source.artifacts[0]!.local_path!);
      f.gateway.artifactUrl = async () => {
        throw Error('Recovery must use frozen files');
      };
      if (unquoted)
        f.service.pricing.quote = async () => {
          throw Error('Already-submitted original jobs must recover without requiring a new price review.');
        };
      const again = await executePlan(app, plan, flags);
      assert.equal(again.task_id, first.task_id);
      assert.equal(f.gateway.posts, 3);
      if (unquoted)
        await assert.rejects(
          executePlan(
            app,
            processingPlan('uv', source.job_id, { param: { bake: false, compress: 'geometry' } }),
            flags,
          ),
          { code: 'IDEMPOTENCY_CONFLICT' },
        );
      await assert.rejects(
        executePlan(app, processingPlan('texture', String(first.task_id), {}), {
          requestId: 'bad-continuation',
          download: false,
        }),
        { code: 'UV_COMPRESSION_CONTINUATION_UNVERIFIED' },
      );
      assert.equal(f.gateway.posts, 3);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  });

test('静态布局前置约束在首个UV付费前拒绝，不产生半条收费链', async () => {
  const f = await fixture();
  try {
    const source = await sourceFor(f),
      original = await readFile(source.artifacts[0]!.local_path!),
      parsed = uvFixtureChunks(original);
    parsed.json.skins = [{}];
    const unsupported = uvFixtureGlb(parsed.json, parsed.binary);
    await writeFile(source.artifacts[0]!.local_path!, unsupported);
    f.jobs.update(source.job_id, 'succeeded', {
      artifacts: [{ ...source.artifacts[0]!, sha256: hash(unsupported), bytes: unsupported.length }],
    });
    const client = {
      request: async () => {
        throw Error('No remote call should be needed');
      },
    } as unknown as StudioClient;
    await assert.rejects(
      executePlan(
        { service: f.service, studio: { client } } as Application,
        processingPlan('uv', source.job_id, { param: { bake: false, compress: 'geometry' } }),
        { requestId: 'unsupported-source', download: false },
      ),
      { code: 'UV_COMPRESSION_UNSUPPORTED' },
    );
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.find('test-account', 'unsupported-source-0'), undefined);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
