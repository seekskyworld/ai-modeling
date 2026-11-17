/** 显式不透明意图必须约束原图、全部输出、恢复及编码后的交付，不能被JPEG白底掩盖。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm, access, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { fixture, quote } from './helpers.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import type { Fetcher } from '../studio/api/client.ts';
import { generationPlan } from '../cli/compat/planning.ts';
import { executePlan, taskResult, type Application } from '../cli/compat/runtime.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { redoPlan } from '../cli/compat/redo.ts';
import {
  freezeImageBackgroundPolicy,
  readImageBackground,
  imageBackgroundPolicyKey,
} from '../cli/core/image-background-policy.ts';
import { freezeImageOutputPolicy } from '../cli/core/image-output-policy.ts';
import { freezeImageSizePolicy } from '../cli/core/image-size-policy.ts';
import {
  ensureImageBackground,
  assertOpaqueImageBytes,
  imageBackgroundSummary,
} from '../cli/artifacts/image-background-output.ts';
import { imageSizeSummary } from '../cli/artifacts/image-size-output.ts';
import { JobStore } from '../cli/storage/jobs.ts';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const input = { prompt: 'one cube', model_version: 'gpt_image_2.5_sunburst' };
async function png(alpha = 255): Promise<Buffer> {
  const raw = Buffer.from(Array.from({ length: 6 }, () => [35, 100, 200, 255]).flat());
  raw[3] = alpha;
  return await sharp(raw, { raw: { width: 2, height: 3, channels: 4 } })
    .png()
    .toBuffer();
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function local(f: Fixture, bytes: Buffer, name: string, index = 0): Promise<Artifact> {
  const file = path.join(f.dir, name + '.png');
  await writeFile(file, bytes);
  return {
    artifact_id: `image-${index}`,
    kind: 'image',
    format: 'png',
    index,
    local_path: file,
    sha256: sha(bytes),
    bytes: bytes.length,
  };
}
async function completed(
  f: Fixture,
  images: Buffer[],
  request = 'opaque',
  output?: 'png' | 'jpeg',
  size?: { width: number; height: number },
): Promise<Job> {
  freezeImageBackgroundPolicy(f.jobs, 'test-account', request, 'opaque');
  freezeImageSizePolicy(f.jobs, 'test-account', request, size);
  freezeImageOutputPolicy(f.jobs, 'test-account', request, output);
  const job = f.jobs.prepare(
    'test-account',
    request,
    'image',
    normalize('image', { ...input, amount: images.length }),
    quote,
  );
  const artifacts = await Promise.all(images.map((bytes, i) => local(f, bytes, request + '-' + i, i)));
  f.jobs.claim(job.job_id);
  f.jobs.update(job.job_id, 'submitted', { remote_ids: { asset_id: 'asset-' + request } });
  return f.jobs.update(job.job_id, 'succeeded', { artifacts });
}
async function close(f: Fixture): Promise<void> {
  f.jobs.close();
  await rm(f.dir, { recursive: true, force: true });
}

test('CLI and full MCP preserve opaque intention without sending a fictitious Studio parameter', () => {
  for (const name of ['text-to-image', 'image-to-image']) {
    const plan = generationPlan(name, name === 'text-to-image' ? ['cube'] : ['image.png'], {
      model: 'chat_image_2.5_sunburst',
      prompt: 'cube',
      param: { background: 'opaque', size: '1024x1024' },
    });
    assert.equal(plan.steps[0]!.imageBackground, 'opaque');
    assert.equal(plan.steps[0]!.parameters.background, undefined);
    assert.deepEqual(plan.steps[0]!.imageSize, { width: 1024, height: 1024 });
  }
  assert.equal(
    fullToolPlan('ai_modeling_generate_image', {
      model: 'chat_image_2.5_sunburst',
      prompt: 'cube',
      background: 'opaque',
    }).steps[0]!.imageBackground,
    'opaque',
  );
  for (const background of ['auto', 'transparent', null, '', true])
    assert.throws(
      () =>
        generationPlan('text-to-image', ['cube'], {
          model: 'chat_image_2.5_sunburst',
          param: { background },
        }),
      { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
    );
  assert.throws(() =>
    generationPlan('text-to-image', ['cube'], {
      model: 'chat_image_2.5_sunburst',
      param: { background: 'opaque', quality: 'low' },
    }),
  );
  assert.equal(
    generationPlan('text-to-image', ['cube'], { model: 'chat_image_2', param: { background: 'opaque' } })
      .steps[0]!.imageBackground,
    undefined,
  );
});

test('first intent is immutable across connections and legacy tasks are not assigned opaque retrospectively', async () => {
  const f = await fixture();
  try {
    freezeImageBackgroundPolicy(f.jobs, 'test-account', 'bound', 'opaque');
    freezeImageBackgroundPolicy(f.jobs, 'test-account', 'bound', 'opaque');
    assert.throws(() => freezeImageBackgroundPolicy(f.jobs, 'test-account', 'bound', undefined), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    freezeImageBackgroundPolicy(f.jobs, 'test-account', 'native', undefined);
    assert.throws(() => freezeImageBackgroundPolicy(f.jobs, 'test-account', 'native', 'opaque'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const old = f.jobs.prepare('test-account', 'legacy', 'image', normalize('image', input), quote);
    freezeImageBackgroundPolicy(f.jobs, 'test-account', 'legacy', undefined);
    assert.equal(f.jobs.requestPolicy('test-account', imageBackgroundPolicyKey('legacy')), undefined);
    assert.equal(readImageBackground(f.jobs, old), undefined);
    assert.throws(() => freezeImageBackgroundPolicy(f.jobs, 'test-account', 'legacy', 'opaque'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const other = new JobStore(path.join(f.dir, 'jobs.sqlite'));
    try {
      assert.throws(() => freezeImageBackgroundPolicy(other, 'test-account', 'bound', undefined), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    } finally {
      other.close();
    }
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('all original outputs are decoded and original bytes remain identical on download', async () => {
  const f = await fixture();
  try {
    const bytes = await png(),
      job = await completed(f, [bytes, bytes]);
    const view = await f.service.get(job.job_id);
    assert.equal(view.state, 'succeeded');
    assert.equal((view.image_background_validation as { status: string }).status, 'verified');
    assert.ok(taskResult(view).image_background_validation);
    for (const artifact of f.jobs.get(job.job_id).artifacts) {
      assert.equal(artifact.image_background!.nonopaque_pixels, 0);
      assert.equal(artifact.image_background!.source_sha256, sha(bytes));
      const saved = await f.service.download(job.job_id, artifact.artifact_id, artifact.artifact_id + '.png');
      assert.deepEqual(await readFile(String(saved.local_path)), bytes);
    }
    assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'succeeded');
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('one partial-alpha pixel prevents every delivery and JPEG cannot disguise the original failure', async () => {
  const f = await fixture();
  try {
    const images = [await png(), await png(254)],
      job = await completed(f, images, 'partial', 'jpeg');
    const view = await f.service.get(job.job_id);
    assert.equal(view.state, 'needs_attention');
    assert.equal(view.remote_state, 'succeeded');
    assert.equal((view.error as { code: string }).code, 'IMAGE_BACKGROUND_REQUIREMENT_FAILED');
    assert.equal(f.jobs.get(job.job_id).state, 'succeeded');
    for (const [i, artifact] of f.jobs.get(job.job_id).artifacts.entries()) {
      assert.deepEqual(await readFile(artifact.image_background!.source_cache_path), images[i]);
      assert.equal(artifact.image_background!.nonopaque_pixels, i);
      assert.equal(artifact.image_output, undefined);
    }
    assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'needs_attention');
    await assert.rejects(f.service.download(job.job_id, 'image-0', 'blocked.jpg'), {
      code: 'IMAGE_BACKGROUND_REQUIREMENT_FAILED',
    });
    await assert.rejects(access(path.join(f.dir, 'output', 'blocked.jpg')));
    assert.equal((await f.service.get(job.job_id)).state, 'needs_attention');
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('no-download and same request restore original alpha failure without generating again', async () => {
  const f = await fixture();
  try {
    const artifact = await local(f, await png(0), 'transparent');
    f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [artifact] });
    const app = { service: f.service } as Application,
      plan = generationPlan('text-to-image', ['cube'], {
        model: 'chat_image_2.5_sunburst',
        param: { background: 'opaque' },
      });
    const flags = { requestId: 'no-download', download: false, open: false, yes: true };
    assert.equal((await executePlan(app, plan, flags)).status, 'needs_attention');
    assert.equal((await executePlan(app, plan, flags)).status, 'needs_attention');
    assert.equal(f.gateway.posts, 1);
    await assert.rejects(
      executePlan(
        app,
        generationPlan('text-to-image', ['cube'], { model: 'chat_image_2.5_sunburst' }),
        flags,
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(f.gateway.posts, 1);
  } finally {
    await close(f);
  }
});

test('no-wait freezes opaque before submission and later polling verifies every original pixel', async () => {
  const f = await fixture();
  try {
    const artifact = await local(f, await png(), 'opaque-later');
    f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [artifact] });
    const result = await executePlan(
      { service: f.service } as Application,
      generationPlan('text-to-image', ['cube'], {
        model: 'chat_image_2.5_sunburst',
        param: { background: 'opaque' },
      }),
      { requestId: 'later', wait: false, download: false, open: false, yes: true },
    );
    const job = f.jobs.get(String(result.task_id));
    assert.equal(job.state, 'submitted');
    assert.equal(readImageBackground(f.jobs, job), 'opaque');
    assert.equal((await f.service.get(job.job_id)).state, 'succeeded');
    assert.equal(f.gateway.posts, 1);
  } finally {
    await close(f);
  }
});

test('missing and duplicate slots do not satisfy all-results background verification', async () => {
  const f = await fixture();
  try {
    let job = await completed(f, [await png(), await png()]);
    job = f.jobs.update(job.job_id, 'succeeded', { artifacts: job.artifacts.slice(0, 1) });
    await assert.rejects(ensureImageBackground(job, f.jobs, f.dir, f.gateway), {
      code: 'ARTIFACT_NOT_READY',
    });
    assert.equal(f.service.summary(job).state, 'needs_attention');
    await assert.rejects(
      ensureImageBackground(
        { ...job, artifacts: [job.artifacts[0]!, { ...job.artifacts[0]!, artifact_id: 'image-1' }] },
        f.jobs,
        f.dir,
        f.gateway,
      ),
      { code: 'ARTIFACT_NOT_READY' },
    );
  } finally {
    await close(f);
  }
});

test('exact size and background compose with PNG and JPEG while wrong dimensions cannot be masked', async () => {
  const f = await fixture();
  try {
    for (const format of ['png', 'jpeg'] as const) {
      const job = await completed(f, [await png()], format, format, { width: 2, height: 3 });
      assert.equal((await f.service.get(job.job_id)).state, 'succeeded');
      const saved = await f.service.download(job.job_id, 'image-0', 'combo.' + format);
      await assertOpaqueImageBytes(await readFile(String(saved.local_path)));
      assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'succeeded');
    }
    const wrong = await completed(f, [await png()], 'wrong-size', undefined, { width: 3, height: 2 });
    await ensureImageBackground(wrong, f.jobs, f.dir, f.gateway);
    assert.equal((await f.service.get(wrong.job_id)).state, 'needs_attention');
    assert.equal(f.service.summary(f.jobs.get(wrong.job_id)).state, 'needs_attention');
    await assert.rejects(f.service.download(wrong.job_id, 'image-0', 'wrong.png'), {
      code: 'IMAGE_SIZE_REQUIREMENT_FAILED',
    });
  } finally {
    await close(f);
  }
});

test('damaged alpha cache recovers exact original bytes but rejects changed remote content', async () => {
  const f = await fixture();
  try {
    const bytes = await png();
    let job = await ensureImageBackground(await completed(f, [bytes]), f.jobs, f.dir, f.gateway);
    const proof = job.artifacts[0]!.image_background!;
    await writeFile(proof.source_cache_path, Buffer.alloc(proof.source_bytes));
    await rm(job.artifacts[0]!.local_path!);
    assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'needs_attention');
    const fetcher: Fetcher = async () => new Response(Uint8Array.from(bytes));
    job = await ensureImageBackground(job, f.jobs, f.dir, f.gateway, fetcher);
    assert.equal(job.artifacts[0]!.image_background!.source_sha256, proof.source_sha256);
    await writeFile(job.artifacts[0]!.image_background!.source_cache_path, Buffer.alloc(proof.source_bytes));
    const changed = await png(254);
    await assert.rejects(
      ensureImageBackground(
        job,
        f.jobs,
        f.dir,
        f.gateway,
        async () => new Response(Uint8Array.from(changed)),
      ),
      { code: 'IMAGE_BACKGROUND_CONTENT_CHANGED' },
    );
    assert.equal(f.jobs.get(job.job_id).artifacts[0]!.image_background!.source_sha256, proof.source_sha256);
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('cache symlinks are rejected and alpha proofs cannot be forged by metadata-only saves', async () => {
  const f = await fixture();
  try {
    const job = await ensureImageBackground(await completed(f, [await png()]), f.jobs, f.dir, f.gateway),
      artifact = job.artifacts[0]!;
    assert.throws(() => f.jobs.saveArtifact(job.job_id, { ...artifact, sha256: 'a'.repeat(64) }), {
      code: 'IMAGE_BACKGROUND_CONTENT_CHANGED',
    });
    assert.throws(
      () =>
        f.jobs.saveArtifact(job.job_id, {
          ...artifact,
          image_background: { ...artifact.image_background!, nonopaque_pixels: 1 },
        }),
      { code: 'IMAGE_BACKGROUND_REQUIREMENT_FAILED' },
    );
    const cacheRoot = path.join(f.dir, 'image-background-cache');
    await rm(cacheRoot, { recursive: true });
    const elsewhere = path.join(f.dir, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, cacheRoot);
    assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'needs_attention');
    await assert.rejects(ensureImageBackground(job, f.jobs, f.dir, f.gateway), {
      code: 'IMAGE_CACHE_PATH_DENIED',
    });
    f.jobs.update(job.job_id, 'succeeded', { remote_ids: { asset_id: 'another-asset' } });
    assert.throws(() => f.jobs.saveArtifact(job.job_id, artifact), {
      code: 'IMAGE_BACKGROUND_REQUIREMENT_FAILED',
    });
  } finally {
    await close(f);
  }
});

test('restart restores opacity and encoded delivery with no remote access', async () => {
  const f = await fixture(),
    job = await completed(f, [await png()], 'restart', 'jpeg');
  assert.equal((await f.service.get(job.job_id)).state, 'succeeded');
  f.jobs.close();
  const restored = await fixture(f.dir);
  try {
    restored.gateway.artifactUrl = async () => {
      throw new Error('No network.');
    };
    assert.equal((await restored.service.get(job.job_id)).state, 'succeeded');
    const saved = await restored.service.download(job.job_id, 'image-0', 'restored.jpg');
    await assertOpaqueImageBytes(await readFile(String(saved.local_path)));
    assert.equal(restored.gateway.posts, 0);
  } finally {
    await close(restored);
  }
});

test('summary rechecks live receipt identity after reading an original alpha or size proof', async () => {
  for (const kind of ['background', 'size'] as const) {
    const f = await fixture();
    try {
      const job = await completed(f, [await png()], 'summary-race', undefined, { width: 2, height: 3 });
      assert.equal((await f.service.get(job.job_id)).state, 'succeeded');
      const ready = f.jobs.get(job.job_id),
        original = f.jobs.requestPolicy.bind(f.jobs);
      let changed = false;
      f.jobs.requestPolicy = (account, key) => {
        const value = original(account, key);
        if (!changed && key.startsWith(`image-${kind}-proof:`)) {
          changed = true;
          f.jobs.update(job.job_id, 'succeeded', { remote_ids: { asset_id: 'replaced-during-proof-read' } });
        }
        return value;
      };
      const summary =
        kind === 'background'
          ? imageBackgroundSummary(f.jobs, ready, f.dir)
          : imageSizeSummary(f.jobs, ready, f.dir);
      assert.equal(changed, true);
      assert.equal(summary?.state, 'needs_attention');
      assert.equal(f.gateway.posts, 0);
    } finally {
      await close(f);
    }
  }
});

test('redo carries original frozen background while unknown outcomes remain blocked', async () => {
  const f = await fixture();
  try {
    const job = await completed(f, [await png()]);
    assert.equal(
      redoPlan(
        job,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        readImageBackground(f.jobs, job),
      ).steps[0]!.imageBackground,
      'opaque',
    );
    assert.equal(redoPlan(job).steps[0]!.imageBackground, undefined);
    assert.throws(
      () =>
        redoPlan(
          { ...job, state: 'outcome_unknown' },
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          'opaque',
        ),
      { code: 'INPUT_NOT_READY' },
    );
  } finally {
    await close(f);
  }
});

test('changed later-step background is rejected before any paid prefix', async () => {
  const f = await fixture();
  try {
    const plan = generationPlan('text-to-image', ['cube'], {
      model: 'chat_image_2.5_sunburst',
      param: { background: 'opaque' },
    });
    plan.steps.unshift({ name: 'prefix', operation: 'image', parameters: normalize('image', input) });
    freezeImageBackgroundPolicy(f.jobs, 'test-account', 'pre-cost-1', undefined);
    await assert.rejects(
      executePlan({ service: f.service } as Application, plan, {
        requestId: 'pre-cost',
        download: false,
        yes: true,
      }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('truncated source cannot pass opacity checks using only its PNG header', async () => {
  const f = await fixture();
  try {
    const job = await completed(f, [(await png()).subarray(0, 40)]);
    assert.equal((await f.service.get(job.job_id)).state, 'needs_attention');
    assert.equal(f.jobs.get(job.job_id).artifacts[0]!.image_background, undefined);
    await assert.rejects(f.service.download(job.job_id, 'image-0', 'truncated.png'), {
      code: 'IMAGE_BACKGROUND_REQUIREMENT_FAILED',
    });
  } finally {
    await close(f);
  }
});

test('schema thirteen preserves schema twelve rows and does not backfill old background requests', async () => {
  const f = await fixture(),
    file = path.join(f.dir, 'jobs.sqlite');
  const old = f.jobs.prepare('test-account', 'legacy-twelve', 'image', normalize('image', input), quote);
  f.jobs.close();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=12');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
  const snapshot = (): unknown =>
    tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
  const before = snapshot(),
    restored = new JobStore(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 18);
    assert.deepEqual(snapshot(), before);
    assert.equal(readImageBackground(restored, restored.get(old.job_id)), undefined);
    assert.throws(() => freezeImageBackgroundPolicy(restored, 'test-account', old.request_id, 'opaque'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.deepEqual(snapshot(), before);
  } finally {
    restored.close();
    db.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
