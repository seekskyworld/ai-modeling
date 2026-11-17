/** WxH既约束原图也约束重连/交付；原生比例请求和旧意图不被偷偷补写成像素承诺。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { fixture, quote, imageInput } from './helpers.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import type { Fetcher } from '../studio/api/client.ts';
import { generationPlan } from '../cli/compat/planning.ts';
import { executePlan, taskResult, type Application } from '../cli/compat/runtime.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { redoPlan } from '../cli/compat/redo.ts';
import {
  freezeImageSizePolicy,
  readImageSize,
  imageSizePolicyKey,
  imageSizeProofKey,
  type ImageSizeRequirement,
} from '../cli/core/image-size-policy.ts';
import { freezeImageOutputPolicy } from '../cli/core/image-output-policy.ts';
import { ensureImageSize } from '../cli/artifacts/image-size-output.ts';
import { JobStore } from '../cli/storage/jobs.ts';
import { DatabaseSync } from 'node:sqlite';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const png = async (width: number, height: number, red = 100): Promise<Buffer> =>
  await sharp({ create: { width, height, channels: 3, background: { r: red, g: 40, b: 200 } } })
    .png()
    .toBuffer();

async function localArtifact(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes: Buffer,
  name: string,
  index = 0,
): Promise<Artifact> {
  const local = path.join(f.dir, name + '.png');
  await writeFile(local, bytes);
  return {
    artifact_id: `image-${index}`,
    kind: 'image',
    format: 'image',
    index,
    local_path: local,
    bytes: bytes.length,
    sha256: sha(bytes),
  };
}
async function completed(
  f: Awaited<ReturnType<typeof fixture>>,
  size: ImageSizeRequirement | undefined,
  images: Buffer[],
  request = 'image-size',
  output?: 'png' | 'jpeg',
): Promise<Job> {
  freezeImageSizePolicy(f.jobs, 'test-account', request, size);
  if (output) freezeImageOutputPolicy(f.jobs, 'test-account', request, output);
  const prepared = f.jobs.prepare(
    'test-account',
    request,
    'image',
    normalize('image', { ...imageInput, amount: images.length }),
    quote,
  );
  const artifacts = await Promise.all(
    images.map((bytes, index) => localArtifact(f, bytes, request + '-' + index, index)),
  );
  f.jobs.claim(prepared.job_id);
  f.jobs.update(prepared.job_id, 'submitted', { remote_ids: { asset_id: `asset-${request}` } });
  return f.jobs.update(prepared.job_id, 'succeeded', { artifacts });
}
async function close(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  f.jobs.close();
  await rm(f.dir, { recursive: true, force: true });
}

test('nine live23 exact pixels reach CLI and full MCP with independent frozen intentions', () => {
  const rows = [
    ...['chat_image_2', 'chat_image_2.5_sunburst'].flatMap((model) => [
      [model, '1152x1536', '3:4'],
      [model, '1792x1024', '16:9'],
      [model, '1024x1792', '9:16'],
    ]),
    ['banana_pro', '896x1200', '3:4'],
    ['banana_pro', '1376x768', '16:9'],
    ['banana_pro', '768x1376', '9:16'],
  ];
  for (const [model, size, scale] of rows) {
    const [width, height] = size!.split('x').map(Number);
    const alias = generationPlan('text-to-image', ['cube'], { model, param: { size } }).steps[0]!;
    const native = generationPlan('text-to-image', ['cube'], { model, param: { resolution: '1K', scale } })
      .steps[0]!;
    assert.deepEqual(alias.parameters, native.parameters);
    assert.deepEqual(alias.imageSize, { width, height });
    assert.equal(native.imageSize, undefined);
    assert.deepEqual(
      fullToolPlan('ai_modeling_generate_image', { model, prompt: 'cube', size }).steps[0]!.imageSize,
      alias.imageSize,
    );
    assert.equal(alias.parameters.size, undefined);
  }
  assert.equal(
    generationPlan('text-to-image', ['cube'], { model: 'chat_image_2', param: { size: '1K' } }).steps[0]!
      .imageSize,
    undefined,
  );
});

test('explicit size, native-only and legacy intention cannot change under the same request', async () => {
  const f = await fixture();
  try {
    freezeImageSizePolicy(f.jobs, 'test-account', 'same', { width: 2, height: 3 });
    freezeImageSizePolicy(f.jobs, 'test-account', 'same', { width: 2, height: 3 });
    for (const changed of [undefined, { width: 3, height: 2 }])
      assert.throws(() => freezeImageSizePolicy(f.jobs, 'test-account', 'same', changed), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    freezeImageSizePolicy(f.jobs, 'test-account', 'native', undefined);
    assert.throws(() => freezeImageSizePolicy(f.jobs, 'test-account', 'native', { width: 2, height: 3 }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    f.jobs.prepare('test-account', 'old', 'image', normalize('image', imageInput), quote);
    freezeImageSizePolicy(f.jobs, 'test-account', 'old', undefined);
    assert.equal(f.jobs.requestPolicy('test-account', imageSizePolicyKey('old')), undefined);
    assert.throws(() => freezeImageSizePolicy(f.jobs, 'test-account', 'old', { width: 2, height: 3 }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const other = new JobStore(path.join(f.dir, 'jobs.sqlite'));
    try {
      assert.throws(() => freezeImageSizePolicy(other, 'test-account', 'same', undefined), {
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

test('all original images are fully decoded and list/download retain exact source bytes', async () => {
  const f = await fixture();
  try {
    const images = [await png(2, 3), await png(2, 3, 240)];
    const job = await completed(f, { width: 2, height: 3 }, images);
    const view = await f.service.get(job.job_id);
    assert.equal(view.state, 'succeeded');
    assert.equal((view.image_size_validation as { status: string }).status, 'verified');
    const saved = f.jobs.get(job.job_id);
    assert.equal(saved.artifacts.length, 2);
    for (const [index, artifact] of saved.artifacts.entries()) {
      assert.equal(artifact.image_size?.source_sha256, sha(images[index]!));
      const downloaded = await f.service.download(job.job_id, artifact.artifact_id, `exact-${index}.png`);
      assert.deepEqual(await readFile(String(downloaded.local_path)), images[index]);
    }
    assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'succeeded');
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('one wrong image preserves remote success, all diagnostics and refuses delivery without resizing', async () => {
  const f = await fixture();
  try {
    const images = [await png(2, 3), await png(3, 2)];
    const job = await completed(f, { width: 2, height: 3 }, images);
    const view = await f.service.get(job.job_id);
    assert.equal(view.state, 'needs_attention');
    assert.equal(view.remote_state, 'succeeded');
    assert.equal((view.error as { code: string }).code, 'IMAGE_SIZE_REQUIREMENT_FAILED');
    assert.equal(f.jobs.get(job.job_id).state, 'succeeded');
    const result = taskResult(view);
    assert.equal(result.status, 'needs_attention');
    assert.ok(result.image_size_validation);
    assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'needs_attention');
    const current = f.jobs.get(job.job_id);
    for (const [index, artifact] of current.artifacts.entries()) {
      assert.deepEqual(await readFile(artifact.image_size!.source_cache_path), images[index]);
      assert.equal(artifact.image_size!.source_sha256, sha(images[index]!));
    }
    await assert.rejects(f.service.download(job.job_id, 'image-0', 'must-not-publish.png'), {
      code: 'IMAGE_SIZE_REQUIREMENT_FAILED',
    });
    await assert.rejects(access(path.join(f.dir, 'output', 'must-not-publish.png')));
    assert.equal((await f.service.get(job.job_id)).state, 'needs_attention');
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('no-download still checks pixels; repeated compatible execution does not submit a replacement', async () => {
  const f = await fixture();
  try {
    const artifact = await localArtifact(f, await png(2, 3), 'wrong-native');
    f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [artifact] });
    const app = { service: f.service } as Application;
    const plan = generationPlan('text-to-image', ['cube'], {
      model: 'chat_image_2',
      param: { size: '1024x1024' },
    });
    const flags = { requestId: 'explicit-size', download: false, open: false, yes: true };
    const result = await executePlan(app, plan, flags);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.remote_state, 'succeeded');
    assert.equal(f.gateway.posts, 1);
    const again = await executePlan(app, plan, flags);
    assert.equal(again.status, 'needs_attention');
    assert.equal(f.gateway.posts, 1);
    await assert.rejects(
      executePlan(
        app,
        generationPlan('text-to-image', ['cube'], { model: 'chat_image_2', param: { size: '1K' } }),
        flags,
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  } finally {
    await close(f);
  }
});

test('missing or duplicate output slots cannot count as all exact images', async () => {
  const f = await fixture();
  try {
    let job = await completed(f, { width: 2, height: 3 }, [await png(2, 3), await png(2, 3)]);
    job = f.jobs.update(job.job_id, 'succeeded', { artifacts: job.artifacts.slice(0, 1) });
    await assert.rejects(ensureImageSize(job, f.jobs, f.dir, f.gateway), { code: 'ARTIFACT_NOT_READY' });
    assert.equal(f.service.summary(job).state, 'needs_attention');
    const duplicates = {
      ...job,
      artifacts: [job.artifacts[0]!, { ...job.artifacts[0]!, artifact_id: 'image-1' }],
    };
    await assert.rejects(ensureImageSize(duplicates, f.jobs, f.dir, f.gateway), {
      code: 'ARTIFACT_NOT_READY',
    });
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('damaged cache recovers only exact original bytes and list cannot claim stale verification', async () => {
  const f = await fixture();
  try {
    const bytes = await png(2, 3);
    let job = await ensureImageSize(
      await completed(f, { width: 2, height: 3 }, [bytes]),
      f.jobs,
      f.dir,
      f.gateway,
    );
    const first = job.artifacts[0]!.image_size!;
    await writeFile(first.source_cache_path, Buffer.alloc(first.source_bytes, 5));
    await rm(job.artifacts[0]!.local_path!);
    assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'needs_attention');
    let reads = 0;
    f.gateway.artifactUrl = async (received: Job) => {
      assert.equal(received.remote_ids.asset_id, job.remote_ids.asset_id);
      return 'https://cdn.tripo3d.ai/owned-original.png';
    };
    const fetcher: Fetcher = async () => {
      reads++;
      return new Response(Uint8Array.from(bytes));
    };
    job = await ensureImageSize(job, f.jobs, f.dir, f.gateway, fetcher);
    assert.equal(reads, 1);
    assert.equal(job.artifacts[0]!.image_size!.source_sha256, first.source_sha256);
    assert.notEqual(job.artifacts[0]!.image_size!.source_cache_path, first.source_cache_path);
    assert.equal(f.service.summary(job).state, 'succeeded');
    await rm(job.artifacts[0]!.image_size!.source_cache_path);
    const another = await png(2, 3, 230);
    await assert.rejects(
      ensureImageSize(job, f.jobs, f.dir, f.gateway, async () => new Response(Uint8Array.from(another))),
      { code: 'IMAGE_SIZE_CONTENT_CHANGED' },
    );
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('receipt race cannot bind original image proof to a changed task', async () => {
  const f = await fixture();
  try {
    const bytes = await png(2, 3);
    const job = await completed(f, { width: 2, height: 3 }, [bytes]);
    await rm(job.artifacts[0]!.local_path!);
    await assert.rejects(
      ensureImageSize(job, f.jobs, f.dir, f.gateway, async () => {
        f.jobs.update(job.job_id, 'succeeded', { remote_ids: { asset_id: 'different-original' } });
        return new Response(Uint8Array.from(bytes));
      }),
      { code: 'IMAGE_SIZE_IDENTITY_CHANGED' },
    );
    assert.equal(f.jobs.requestPolicy(job.account_ref, imageSizeProofKey(job, job.artifacts[0]!)), undefined);
    assert.equal(f.jobs.get(job.job_id).artifacts[0]!.image_size, undefined);
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('final metadata save cannot bypass size proof or bind another receipt', async () => {
  const f = await fixture();
  try {
    const job = await ensureImageSize(
      await completed(f, { width: 2, height: 3 }, [await png(2, 3)]),
      f.jobs,
      f.dir,
      f.gateway,
    );
    const artifact = job.artifacts[0]!;
    assert.throws(() => f.jobs.saveArtifact(job.job_id, { ...artifact, sha256: 'a'.repeat(64) }), {
      code: 'IMAGE_SIZE_CONTENT_CHANGED',
    });
    assert.throws(
      () =>
        f.jobs.saveArtifact(job.job_id, { ...artifact, image_size: { ...artifact.image_size!, width: 100 } }),
      { code: 'IMAGE_SIZE_REQUIREMENT_FAILED' },
    );
    f.jobs.update(job.job_id, 'succeeded', { remote_ids: { asset_id: 'changed' } });
    assert.throws(() => f.jobs.saveArtifact(job.job_id, artifact), { code: 'IMAGE_SIZE_REQUIREMENT_FAILED' });
    assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'needs_attention');
  } finally {
    await close(f);
  }
});

test('JPEG delivery preserves both original exact dimensions and same source proof across recovery', async () => {
  const f = await fixture();
  try {
    const source = await png(2, 3);
    const job = await completed(f, { width: 2, height: 3 }, [source], 'jpeg-size', 'jpeg');
    const view = await f.service.get(job.job_id);
    assert.equal(view.state, 'succeeded');
    const current = f.jobs.get(job.job_id),
      output = current.artifacts[0]!.image_output!;
    assert.equal(output.source_sha256, sha(source));
    const downloaded = await f.service.download(job.job_id, 'image-0', 'exact.jpg');
    const metadata = await sharp(await readFile(String(downloaded.local_path))).metadata();
    assert.equal(metadata.width, 2);
    assert.equal(metadata.height, 3);
    assert.equal(metadata.format, 'jpeg');
    await writeFile(output.cache_path, source);
    assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'needs_attention');
    f.gateway.artifactUrl = async () => {
      throw new Error('Original local cache must suffice.');
    };
    assert.equal((await f.service.get(job.job_id)).state, 'succeeded');
    assert.equal(f.jobs.get(job.job_id).artifacts[0]!.image_output!.source_sha256, sha(source));
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('redo preserves only frozen exact size and does not invent size for native-only history', async () => {
  const f = await fixture();
  try {
    const exact = await completed(f, { width: 2, height: 3 }, [await png(2, 3)], 'redo-exact');
    const redo = redoPlan(
      exact,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      readImageSize(f.jobs, exact),
    );
    assert.deepEqual(redo.steps[0]!.imageSize, { width: 2, height: 3 });
    const native = await completed(f, undefined, [await png(2, 3)], 'redo-native');
    assert.equal(redoPlan(native).steps[0]!.imageSize, undefined);
    const unknown = { ...exact, state: 'outcome_unknown' as const };
    assert.throws(() => redoPlan(unknown), { code: 'INPUT_NOT_READY' });
  } finally {
    await close(f);
  }
});

test('changed final size policy is rejected before any earlier paid chain step', async () => {
  const f = await fixture();
  try {
    const app = { service: f.service } as Application;
    const plan = generationPlan('text-to-image', ['cube'], {
      model: 'chat_image_2',
      param: { size: '1024x1024' },
    });
    plan.steps.unshift({ name: 'prefix', operation: 'image', parameters: normalize('image', imageInput) });
    freezeImageSizePolicy(f.jobs, 'test-account', 'before-cost-1', undefined);
    await assert.rejects(executePlan(app, plan, { requestId: 'before-cost', download: false, yes: true }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('original image proof survives a new process while original network is unavailable', async () => {
  const f = await fixture();
  const job = await ensureImageSize(
    await completed(f, { width: 2, height: 3 }, [await png(2, 3)]),
    f.jobs,
    f.dir,
    f.gateway,
  );
  f.jobs.close();
  const restarted = await fixture(f.dir);
  try {
    restarted.gateway.artifactUrl = async () => {
      throw new Error('offline');
    };
    assert.equal((await restarted.service.get(job.job_id)).state, 'succeeded');
    const delivered = await restarted.service.download(job.job_id, 'image-0', 'after-restart.png');
    assert.equal(delivered.sha256, job.artifacts[0]!.image_size!.source_sha256);
    assert.equal(restarted.gateway.posts, 0);
  } finally {
    await close(restarted);
  }
});

test('unknown original outcome is never resubmitted while its exact size policy stays frozen', async () => {
  const f = await fixture();
  try {
    const plan = generationPlan('text-to-image', ['cube'], {
      model: 'chat_image_2',
      param: { size: '1024x1024' },
    });
    const step = plan.steps[0]!;
    freezeImageSizePolicy(f.jobs, 'test-account', 'unknown-size-0', step.imageSize);
    const job = f.jobs.prepare('test-account', 'unknown-size-0', 'image', step.parameters, quote);
    f.jobs.claim(job.job_id);
    f.jobs.update(job.job_id, 'outcome_unknown', { error: { code: 'TEST_TIMEOUT' } });
    const result = await executePlan({ service: f.service } as Application, plan, {
      requestId: 'unknown-size',
      wait: false,
      download: false,
      yes: true,
    });
    assert.equal(result.status, 'outcome_unknown');
    assert.deepEqual(readImageSize(f.jobs, f.jobs.get(job.job_id)), step.imageSize);
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('no-wait freezes exact dimensions and verifies original images when polled later', async () => {
  const f = await fixture();
  try {
    const artifact = await localArtifact(f, await png(1024, 1024), 'later-original');
    f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [artifact] });
    const plan = generationPlan('text-to-image', ['cube'], {
      model: 'chat_image_2',
      param: { size: '1024x1024' },
    });
    const result = await executePlan({ service: f.service } as Application, plan, {
      requestId: 'later-size',
      wait: false,
      download: false,
      yes: true,
    });
    const job = f.jobs.get(String(result.task_id));
    assert.equal(job.state, 'submitted');
    assert.deepEqual(readImageSize(f.jobs, job), { width: 1024, height: 1024 });
    assert.equal(job.artifacts.length, 0);
    assert.equal((await f.service.get(job.job_id)).state, 'succeeded');
    assert.equal(
      (f.service.summary(f.jobs.get(job.job_id)).image_size_validation as { status: string }).status,
      'verified',
    );
    assert.equal(f.gateway.posts, 1);
  } finally {
    await close(f);
  }
});

test('a valid PNG header without complete pixels cannot satisfy the delivery requirement', async () => {
  const f = await fixture();
  try {
    const truncated = (await png(2, 3)).subarray(0, 40);
    const job = await completed(f, { width: 2, height: 3 }, [truncated]);
    const view = await f.service.get(job.job_id);
    assert.equal(view.state, 'needs_attention');
    assert.equal(view.remote_state, 'succeeded');
    assert.equal(f.jobs.get(job.job_id).artifacts[0]!.image_size, undefined);
    await assert.rejects(f.service.download(job.job_id, 'image-0', 'truncated.png'), {
      code: 'IMAGE_SIZE_REQUIREMENT_FAILED',
    });
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('current schema preserves all seven historical tables without inventing missing exact-size intentions', async () => {
  const f = await fixture(),
    file = path.join(f.dir, 'jobs.sqlite');
  const prepared = f.jobs.prepare(
    'test-account',
    'legacy-eleven',
    'image',
    normalize('image', imageInput),
    quote,
  );
  f.jobs.claim(prepared.job_id);
  f.jobs.update(prepared.job_id, 'submitted', { remote_ids: { asset_id: 'legacy-asset' } });
  f.jobs.update(prepared.job_id, 'succeeded', {
    artifacts: [await localArtifact(f, await png(2, 3), 'legacy-file')],
  });
  f.jobs.assignName('test-account', 'legacy-name', prepared.job_id);
  f.jobs.linkStep('test-account', 'legacy-pipeline', 0, prepared.job_id);
  f.jobs.bindRequestPolicy('test-account', 'unrelated-original-policy', { unchanged: true });
  f.jobs.close();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=11');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
  assert.equal(tables.length, 7);
  const snapshot = (): Record<string, unknown[]> =>
    Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
  const before = snapshot();
  const restored = new JobStore(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 18);
    assert.deepEqual(snapshot(), before);
    const job = restored.get(prepared.job_id);
    assert.equal(job.remote_ids.asset_id, 'legacy-asset');
    assert.equal(readImageSize(restored, job), undefined);
    assert.throws(
      () => freezeImageSizePolicy(restored, 'test-account', 'legacy-eleven', { width: 2, height: 3 }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.deepEqual(snapshot(), before);
  } finally {
    restored.close();
    db.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
