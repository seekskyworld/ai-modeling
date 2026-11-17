/** 多视图组合须保四槽身份并跨中断恢复；用受控网页断言实际POST次数与后续建模输入。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { fixture, quote } from './helpers.ts';
import { generationPlan } from '../cli/compat/planning.ts';
import { executePlan, resolveJob, type Application } from '../cli/compat/runtime.ts';
import { validateExecution } from '../cli/compat/run-plan.ts';
import {
  multiviewBundle,
  multiviewChildren,
  multiviewArtifactSource,
  multiviewSources,
} from '../cli/core/multiview-bundle.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { text, object, TripoError } from '../studio/contracts/errors.ts';
import type { Job } from '../studio/contracts/types.ts';
import { redoPlan } from '../cli/compat/redo.ts';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import sharp from 'sharp';
import { download } from '../cli/artifacts/download.ts';

async function setup(existing?: string) {
  const f = await fixture(existing),
    submitted: Job[] = [];
  f.gateway.submit = async (job) => {
    submitted.push(job);
    return {
      remote_ids:
        job.operation === 'image'
          ? { asset_id: `edited-${job.job_id}` }
          : { project_id: 'model', operator_id: 'op' },
    };
  };
  f.gateway.status = async (job) => ({
    state: 'succeeded',
    progress: 100,
    artifacts: [
      {
        artifact_id: job.operation === 'image' ? 'image-0' : 'model',
        kind: job.operation === 'image' ? 'image' : 'model',
        format: job.operation === 'image' ? 'png' : 'glb',
        index: 0,
      },
    ],
  });
  let source = f.jobs.find('test-account', 'source-views');
  if (!source) {
    source = f.jobs.prepare(
      'test-account',
      'source-views',
      'image_process',
      normalize('image_process', { action: 'multiview', asset_id: 'original-image' }),
      quote,
    );
    source = f.jobs.update(source.job_id, 'succeeded', {
      remote_ids: { asset_id: 'original-four-views' },
      artifacts: [0, 1, 2, 3].map((index) => ({
        artifact_id: `image-${index}`,
        kind: 'image',
        format: 'png',
        index,
      })),
    });
  }
  let sourceReads = 0;
  const client = {
    request: async (_method: string, route: string, body: Record<string, unknown>) => {
      assert.equal(route, '/v2/studio/image/get_image_asset');
      assert.equal(body.asset_id, 'original-four-views');
      sourceReads++;
      return {
        asset_id: 'original-four-views',
        status: 'success',
        type: 'multiview_images',
        output: { data: [{}, {}, {}, {}] },
      };
    },
  };
  const app = { service: f.service, studio: { client } } as unknown as Application;
  return { ...f, source, submitted, app, sourceReads: () => sourceReads };
}
const prompts = [
  { view: 'front', prompt: 'paint the hat red' },
  { view: 'back', prompt: 'paint the back of the hat red' },
];

test('multiview cache recovery preserves real formats and repairs legacy image placeholders without source drift', async () => {
  const f = await setup();
  try {
    const plan = generationPlan('edit-multiview', [f.source.job_id], { param: { prompts } });
    const result = await executePlan(f.app, plan, {
      requestId: 'cached-views',
      wait: false,
      download: false,
    });
    const rootId = text(result.task_id);
    const artifact = f.jobs.get(rootId).artifacts.find((item) => item.index === 1)!;
    const jpeg = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 30, g: 50, b: 80 } },
    })
      .jpeg()
      .toBuffer();
    const saved = await download(
      'https://cdn.tripo3d.ai/original-left',
      f.service.config.outputDir,
      'left.jpeg',
      'image',
      async () => new Response(new Uint8Array(jpeg)),
    );
    f.jobs.saveArtifact(rootId, { ...artifact, ...saved });
    await f.service.get(rootId);
    const refreshed = f.jobs.get(rootId).artifacts.find((item) => item.index === 1)!;
    assert.equal(refreshed.format, 'jpeg');
    assert.equal(refreshed.sha256, saved.sha256);
    // 旧 bug 已经持久化 image 占位时，升级后也须从核验字节恢复，不能依赖一次新下载。
    f.jobs.saveArtifact(rootId, { ...refreshed, format: 'image' });
    await f.service.get(rootId);
    assert.equal(f.jobs.get(rootId).artifacts.find((item) => item.index === 1)!.format, 'image');
    f.gateway.artifactUrl = async () => {
      throw new TripoError('DOWNLOAD_FAILED', 'The original signed URL has expired', 'read');
    };
    await assert.rejects(f.service.download(rootId, artifact.artifact_id, 'wrong-legacy.png'), {
      code: 'OUTPUT_EXTENSION',
    });
    const original = await f.service.download(rootId, artifact.artifact_id, 'left.png', true);
    assert.equal(original.restored_from_cache, true);
    assert.equal(original.local_path, saved.local_path);
    assert.equal(original.sha256, saved.sha256);
    assert.equal(original.format, 'jpeg');
    f.jobs.saveArtifact(rootId, { ...refreshed, format: 'image' });
    const restored = await f.service.download(rootId, artifact.artifact_id, 'left-restored.jpeg');
    assert.equal(restored.restored_from_cache, true);
    assert.deepEqual(await readFile(text(restored.local_path)), jpeg);
    const persisted = f.jobs.get(rootId).artifacts.find((item) => item.index === 1)!;
    assert.equal(persisted.format, 'jpeg');
    f.jobs.saveArtifact(rootId, { ...persisted, format: 'image' });
    const automatic = await f.service.download(rootId, artifact.artifact_id, 'left-automatic.png', true);
    assert.equal(automatic.restored_from_cache, true);
    assert.equal(path.basename(text(automatic.local_path)), 'left-automatic.jpeg');
    assert.deepEqual(await readFile(text(automatic.local_path)), jpeg);
    assert.equal(f.jobs.get(rootId).artifacts.find((item) => item.index === 1)!.format, 'jpeg');
    assert.equal(f.submitted.length, 2);
    const child = multiviewChildren(f.jobs, f.jobs.get(rootId))[0]!;
    f.jobs.update(child.job_id, 'succeeded', { remote_ids: { asset_id: 'a-different-asset' } });
    await assert.rejects(f.service.get(rootId), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(f.service.download(rootId, artifact.artifact_id, 'wrong-source.jpeg'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(f.submitted.length, 2);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('two independent no-wait edits keep untouched slots; repeated request freezes aliases and model consumption', async () => {
  const f = await setup();
  try {
    f.jobs.setAlias('test-account', 'views', f.source.job_id);
    const plan = generationPlan('edit-multiview', ['@views'], { param: { prompts } });
    assert.equal(validateExecution(plan, { wait: false }, false), 1);
    const result = await executePlan(f.app, plan, { requestId: 'views-edit', wait: false, download: false });
    assert.equal(result.type, 'edit_multiview_image');
    assert.equal(result.status, 'success');
    assert.equal(f.submitted.length, 2);
    const root = f.jobs.get(text(result.task_id)),
      slots = multiviewSources(f.jobs, root);
    assert.deepEqual(
      slots.map((slot) => slot.output_index),
      [0, 1, 0, 3],
    );
    assert.deepEqual(
      slots.filter((_, index) => index === 1 || index === 3).map((slot) => slot.asset_id),
      ['original-four-views', 'original-four-views'],
    );
    assert.deepEqual(
      f.submitted.map((job) => object(job.input.image_asset).output_index),
      [0, 2],
    );
    assert.equal(resolveJob(f.app, '@last').job_id, root.job_id);
    const redo = redoPlan(root);
    assert.equal(redo.multiviewEdit!.source, f.source.job_id);
    assert.deepEqual(redo.multiviewEdit!.prompts, prompts);
    assert.throws(() => redoPlan(root, 123), { code: 'STUDIO_CAPABILITY_UNAVAILABLE' });
    assert.equal(
      (f.service.list(50, 0).jobs as Record<string, unknown>[]).find((item) => item.job_id === root.job_id)
        ?.task_type,
      'edit_multiview_image',
    );
    f.jobs.setAlias('test-account', 'views', f.submitted[0]!.job_id);
    assert.equal(
      (await executePlan(f.app, plan, { requestId: 'views-edit', wait: false, download: false })).task_id,
      root.job_id,
    );
    assert.equal(f.submitted.length, 2);
    assert.equal(f.sourceReads(), 1);
    const changed = generationPlan('edit-multiview', ['@views'], {
      param: { prompts: [{ view: 'front', prompt: 'blue' }] },
    });
    await assert.rejects(
      executePlan(f.app, changed, { requestId: 'views-edit', wait: false, download: false }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const model = generationPlan('multiview-to-model', [root.job_id], {
      model: 'tripo-v3.1',
      param: { texture: false },
    });
    await executePlan(f.app, model, { requestId: 'consume-views', wait: false, download: false });
    assert.deepEqual(f.submitted.at(-1)!.input.image_assets, slots);
    for (const artifact of root.artifacts) {
      const source = multiviewArtifactSource(f.jobs, root, artifact);
      assert.equal(source.job.remote_ids.asset_id, slots[artifact.index]!.asset_id);
      assert.equal(source.artifact.index, slots[artifact.index]!.output_index);
    }
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('unknown first edit stops later submissions; restart and reconciliation resume only missing views', async () => {
  const f = await setup();
  let closed = false;
  const plan = generationPlan('edit-multiview', [f.source.job_id], { param: { prompts } });
  f.gateway.submit = async (job) => {
    f.submitted.push(job);
    throw new TripoError('NETWORK_ERROR', 'Lost original receipt', 'unknown');
  };
  try {
    const first = await executePlan(f.app, plan, {
      requestId: 'unknown-views',
      wait: false,
      download: false,
    });
    assert.equal(first.status, 'outcome_unknown');
    assert.equal(f.submitted.length, 1);
    const rootId = text(first.task_id),
      child = multiviewChildren(f.jobs, f.jobs.get(rootId))[0]!;
    f.jobs.close();
    closed = true;
    const restarted = await setup(f.dir);
    try {
      const resumed = await executePlan(restarted.app, plan, {
        requestId: 'unknown-views',
        wait: false,
        download: false,
      });
      assert.equal(resumed.status, 'outcome_unknown');
      assert.equal(restarted.submitted.length, 0);
      assert.equal(restarted.sourceReads(), 0);
      await restarted.service.reconcile(child.job_id, { asset_id: 'reconciled-original' });
      const complete = await executePlan(restarted.app, plan, {
        requestId: 'unknown-views',
        wait: false,
        download: false,
      });
      assert.equal(complete.status, 'success');
      assert.equal(restarted.submitted.length, 1);
      assert.equal(
        multiviewSources(restarted.jobs, restarted.jobs.get(rootId))[0]!.asset_id,
        'reconciled-original',
      );
      await assert.rejects(restarted.service.reconcile(rootId, { asset_id: 'wrong-root-receipt' }), {
        code: 'RECONCILE_CHILD_REQUIRED',
      });
    } finally {
      restarted.jobs.close();
    }
  } finally {
    if (!closed) f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('a pre-submit budget block retains the composite and successful sibling for same-request continuation', async () => {
  const f = await setup();
  const plan = generationPlan('edit-multiview', [f.source.job_id], { param: { prompts } });
  f.service.pricing = {
    quote: async (_operation, input) => ({
      ...quote,
      credits: input.prompt === prompts[1]!.prompt ? 20 : 10,
    }),
  };
  try {
    const partial = await executePlan(f.app, plan, {
      requestId: 'partial-views',
      maxCredits: 10,
      wait: false,
      download: false,
    });
    assert.equal(partial.status, 'needs_attention');
    assert.equal(f.submitted.length, 1);
    assert.equal(object(partial.submission_error).code, 'ESTIMATE_EXCEEDS_BUDGET');
    const complete = await executePlan(f.app, plan, {
      requestId: 'partial-views',
      maxCredits: 20,
      wait: false,
      download: false,
    });
    assert.equal(complete.status, 'success');
    assert.equal(f.submitted.length, 2);
    assert.equal(complete.task_id, partial.task_id);
    const definition = multiviewBundle(f.jobs.get(text(complete.task_id)));
    assert.deepEqual(
      definition.sources.map((source) => source.output_index),
      [0, 1, 2, 3],
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('invalid or duplicate view edits fail before creating a composition', () => {
  for (const value of [
    [
      { view: 'front', prompt: 'one' },
      { view: 'front', prompt: 'two' },
    ],
    [{ view: 'top', prompt: 'new' }],
    [],
  ])
    assert.throws(() => generationPlan('edit-multiview', ['@views'], { param: { prompts: value } }));
  assert.throws(
    () => generationPlan('edit-multiview', ['https://example.test/sheet.png'], { param: { prompts } }),
    { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
  );
});

test('current schema preserves v7 tasks and composition identities during migration', async () => {
  const f = await setup(),
    file = path.join(f.dir, 'jobs.sqlite'),
    id = f.source.job_id;
  f.jobs.close();
  const legacy = new DatabaseSync(file);
  legacy.exec('PRAGMA user_version=7');
  legacy.close();
  const restored = await setup(f.dir);
  try {
    assert.equal(restored.jobs.get(id).remote_ids.asset_id, 'original-four-views');
    const db = new DatabaseSync(file);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 18);
    db.close();
  } finally {
    restored.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
