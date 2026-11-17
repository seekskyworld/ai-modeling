/** 格式意图不能悄悄改变旧收费任务；目标缓存必须验字节，恢复只能用同一来源。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { fixture, imageInput, quote } from './helpers.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { detectFormat } from '../studio/files.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import type { Fetcher } from '../studio/api/client.ts';
import {
  freezeImageOutputPolicy,
  readImageOutputFormat,
  takeImageOutputFormat,
} from '../cli/core/image-output-policy.ts';
import { encodeImageOutput } from '../cli/artifacts/image-encoding.ts';
import {
  ensureImageOutput,
  downloadImageOutput,
  hasImageOutputProof,
} from '../cli/artifacts/image-output.ts';
import { generationPlan } from '../cli/compat/planning.ts';
import { executePlan, taskResult, type Application } from '../cli/compat/runtime.ts';

async function image(): Promise<Buffer> {
  return await sharp(Buffer.from([255, 255, 255, 0, 255, 0, 0, 255]), {
    raw: { width: 2, height: 1, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function completedImage(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes: Buffer,
  request = 'jpeg-image',
  format: 'png' | 'jpeg' = 'jpeg',
): Promise<Job> {
  freezeImageOutputPolicy(f.jobs, 'test-account', request, format);
  const prepared = f.jobs.prepare('test-account', request, 'image', normalize('image', imageInput), quote);
  const local = path.join(f.dir, `${request}.png`);
  await writeFile(local, bytes);
  const artifact: Artifact = {
    artifact_id: 'image-0',
    kind: 'image',
    format: 'image',
    index: 0,
    local_path: local,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  f.jobs.claim(prepared.job_id);
  f.jobs.update(prepared.job_id, 'submitted', { remote_ids: { asset_id: `remote-${request}` } });
  return f.jobs.update(prepared.job_id, 'succeeded', { artifacts: [artifact] });
}

test('web Canvas corresponding encoding verifies real bytes, original dimensions and JPEG alpha flattening', async () => {
  const original = await image();
  const jpeg = await encodeImageOutput(original, 'jpeg');
  assert.equal(detectFormat(jpeg.bytes), 'jpeg');
  assert.equal(jpeg.source_format, 'png');
  assert.equal(jpeg.width, 2);
  assert.equal(jpeg.height, 1);
  const decoded = await sharp(jpeg.bytes).raw().toBuffer();
  assert.ok(decoded[0]! < 3 && decoded[1]! < 3 && decoded[2]! < 3, 'transparent source becomes black');
  assert.ok(decoded[3]! > 250 && decoded[4]! < 4 && decoded[5]! < 4, 'opaque red remains red');
  const unchanged = await encodeImageOutput(original, 'png');
  assert.deepEqual(unchanged.bytes, original);
  const png = await encodeImageOutput(jpeg.bytes, 'png');
  assert.equal(detectFormat(png.bytes), 'png');
  assert.deepEqual(await sharp(png.bytes).raw().toBuffer(), decoded);
  await assert.rejects(encodeImageOutput(original.subarray(0, 40), 'jpeg'), {
    code: 'IMAGE_OUTPUT_REQUIREMENT_FAILED',
  });
});

test('image output format is removed from web input and frozen before generation', async () => {
  const input: Record<string, unknown> = { output_format: 'jpeg', prompt: 'robot' };
  assert.equal(takeImageOutputFormat(input), 'jpeg');
  assert.equal(input.output_format, undefined);
  assert.throws(() => takeImageOutputFormat({ output_format: 'jpg' }), { code: 'INVALID_INPUT' });
  const f = await fixture();
  try {
    const job = await completedImage(f, await image());
    assert.equal(readImageOutputFormat(f.jobs, job), 'jpeg');
    assert.throws(() => freezeImageOutputPolicy(f.jobs, 'test-account', job.request_id, 'png'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.throws(() => freezeImageOutputPolicy(f.jobs, 'test-account', job.request_id, undefined), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    f.jobs.prepare('test-account', 'legacy-image', 'image', normalize('image', imageInput), quote);
    assert.throws(() => freezeImageOutputPolicy(f.jobs, 'test-account', 'legacy-image', 'jpeg'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('output cache preserves source identity, stays separate from delivered paths and survives restart', async () => {
  const f = await fixture();
  const original = await image();
  let closed = false;
  try {
    const source = await completedImage(f, original);
    const converted = await ensureImageOutput(source, f.jobs, f.dir, f.gateway);
    const artifact = converted.artifacts[0]!;
    assert.equal(artifact.format, 'jpeg');
    assert.equal(artifact.local_path, undefined);
    assert.equal(artifact.sha256, undefined);
    assert.equal(artifact.image_output?.source_format, 'png');
    assert.equal(artifact.image_output?.source_sha256, createHash('sha256').update(original).digest('hex'));
    assert.ok(hasImageOutputProof(converted, f.jobs));
    assert.deepEqual(await readFile(artifact.image_output!.source_cache_path), original);
    f.jobs.close();
    closed = true;
    const restarted = await fixture(f.dir);
    try {
      restarted.gateway.artifactUrl = async () => {
        throw new Error('offline');
      };
      const saved = await downloadImageOutput(
        restarted.jobs.get(source.job_id),
        artifact,
        { root: path.join(f.dir, 'output'), relative: 'delivered.jpg' },
        false,
        restarted.jobs,
        f.dir,
        restarted.gateway,
      );
      assert.equal(saved.format, 'jpeg');
      assert.equal(detectFormat(await readFile(String(saved.local_path))), 'jpeg');
      assert.equal(saved.source_sha256, artifact.image_output!.source_sha256);
      assert.equal(restarted.gateway.posts, 0);
    } finally {
      restarted.jobs.close();
    }
  } finally {
    if (!closed) f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('tampered target is re-encoded from verified original without network, or re-read by original remote identity', async () => {
  const f = await fixture();
  try {
    const original = await image();
    let job = await ensureImageOutput(await completedImage(f, original), f.jobs, f.dir, f.gateway);
    const first = job.artifacts[0]!.image_output!;
    await writeFile(first.cache_path, Buffer.alloc(first.bytes, 3));
    f.gateway.artifactUrl = async () => {
      throw new Error('network should not be needed');
    };
    job = await ensureImageOutput(job, f.jobs, f.dir, f.gateway);
    assert.notEqual(job.artifacts[0]!.image_output!.cache_path, first.cache_path);
    const second = job.artifacts[0]!.image_output!;
    await rm(second.cache_path);
    await rm(second.source_cache_path);
    let reads = 0;
    f.gateway.artifactUrl = async (received: Job, artifact?: Artifact) => {
      assert.equal(received.remote_ids.asset_id, job.remote_ids.asset_id);
      assert.equal(artifact?.format, 'png');
      return 'https://cdn.tripo3d.ai/original.png';
    };
    const fetcher: Fetcher = async () => {
      reads++;
      return new Response(Uint8Array.from(original), { status: 200 });
    };
    job = await ensureImageOutput(job, f.jobs, f.dir, f.gateway, fetcher);
    assert.equal(reads, 1);
    assert.ok(hasImageOutputProof(job, f.jobs));
    assert.equal(job.artifacts[0]!.image_output!.source_sha256, first.source_sha256);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('wrong target metadata cannot reuse PNG bytes as JPEG and explicit paths still enforce real extensions', async () => {
  const f = await fixture();
  try {
    const original = await image();
    let job = await ensureImageOutput(await completedImage(f, original), f.jobs, f.dir, f.gateway);
    const artifact = job.artifacts[0]!;
    const proof = artifact.image_output!;
    await writeFile(proof.cache_path, original);
    f.jobs.saveArtifact(job.job_id, {
      ...artifact,
      image_output: {
        ...proof,
        bytes: original.length,
        sha256: createHash('sha256').update(original).digest('hex'),
      },
    });
    job = await ensureImageOutput(f.jobs.get(job.job_id), f.jobs, f.dir, f.gateway);
    assert.equal(detectFormat(await readFile(job.artifacts[0]!.image_output!.cache_path)), 'jpeg');
    const destination = { root: path.join(f.dir, 'output'), relative: 'requested.png' };
    await assert.rejects(
      downloadImageOutput(job, job.artifacts[0]!, destination, false, f.jobs, f.dir, f.gateway),
      { code: 'OUTPUT_EXTENSION' },
    );
    const saved = await downloadImageOutput(
      job,
      job.artifacts[0]!,
      destination,
      true,
      f.jobs,
      f.dir,
      f.gateway,
    );
    assert.equal(path.basename(String(saved.local_path)), 'requested.jpeg');
    await assert.rejects(
      downloadImageOutput(job, job.artifacts[0]!, destination, true, f.jobs, f.dir, f.gateway),
      { code: 'OUTPUT_EXISTS' },
    );
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('remote recovery cannot replace the recorded original image with different bytes', async () => {
  const f = await fixture();
  try {
    const job = await ensureImageOutput(await completedImage(f, await image()), f.jobs, f.dir, f.gateway);
    const proof = job.artifacts[0]!.image_output!;
    await rm(proof.cache_path);
    await rm(proof.source_cache_path);
    const replacement = await sharp({ create: { width: 2, height: 1, channels: 3, background: '#00ff00' } })
      .png()
      .toBuffer();
    const fetcher: Fetcher = async () => new Response(Uint8Array.from(replacement), { status: 200 });
    await assert.rejects(ensureImageOutput(job, f.jobs, f.dir, f.gateway, fetcher), {
      code: 'IMAGE_OUTPUT_REQUIREMENT_FAILED',
    });
    assert.equal(f.jobs.get(job.job_id).artifacts[0]!.image_output!.source_sha256, proof.source_sha256);
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.get(job.job_id).state, 'succeeded');
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('generate-image plan exposes delivery policy without pretending it is a Studio generation field', () => {
  const plan = generationPlan('text-to-image', ['robot'], { param: { output_format: 'jpeg' } });
  assert.equal(plan.steps[0]!.imageOutputFormat, 'jpeg');
  assert.equal(plan.steps[0]!.parameters.output_format, undefined);
  assert.ok(
    plan.warnings.some((warning) => warning.includes('optional local CLI delivery encoding extension')),
  );
  assert.ok(plan.warnings.some((warning) => warning.includes('no native output-format selector')));
});

test('no-download reads validate actual image output; failed encoding never changes the original remote success', async () => {
  const f = await fixture();
  try {
    const good = await completedImage(f, await image());
    const bad = await completedImage(f, (await image()).subarray(0, 40), 'broken-original');
    const result = await f.service.get(good.job_id);
    assert.equal(result.state, 'succeeded');
    assert.equal((result.image_output_validation as Record<string, unknown>).format, 'jpeg');
    assert.equal((result.artifacts as Artifact[])[0]!.local_path, undefined);
    const saved = await f.service.download(good.job_id, 'image-0', 'service.jpeg');
    assert.equal(detectFormat(await readFile(String(saved.local_path))), 'jpeg');
    const failed = await f.service.get(bad.job_id);
    assert.equal(failed.state, 'needs_attention');
    assert.equal(failed.remote_state, 'succeeded');
    assert.equal(taskResult(failed).status, 'needs_attention');
    assert.equal(f.jobs.get(bad.job_id).state, 'succeeded');
    const retry = await f.service.submit('image', bad.request_id, bad.input, 10);
    assert.equal(retry.state, 'needs_attention');
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('no-wait image submission freezes delivery intent; restart and pending artifacts recover only the original task', async () => {
  const f = await fixture();
  try {
    const bytes = await image();
    const file = path.join(f.dir, 'source.png');
    await writeFile(file, bytes);
    const artifact: Artifact = {
      artifact_id: 'image-0',
      kind: 'image',
      format: 'image',
      index: 0,
      local_path: file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    };
    let polls = 0;
    f.gateway.status = async () => ({
      state: 'succeeded',
      progress: 100,
      artifacts: ++polls === 1 ? [] : [artifact],
    });
    const plan = generationPlan('text-to-image', ['robot'], {
      model: 'gemini_3.1_flash_image_preview',
      param: { output_format: 'jpeg' },
    });
    const app = { service: f.service } as Application;
    const result = await executePlan(app, plan, { requestId: 'image-no-wait', wait: false, download: false });
    assert.equal(result.status, 'queued');
    assert.equal(f.gateway.posts, 1);
    const read = await f.service.get(String(result.task_id));
    assert.equal(read.state, 'succeeded');
    assert.equal((read.artifacts as Artifact[])[0]!.format, 'jpeg');
    const recovered = await executePlan(app, plan, {
      requestId: 'image-no-wait',
      wait: false,
      download: false,
    });
    assert.equal(recovered.status, 'success');
    const changed = generationPlan('text-to-image', ['robot'], {
      model: 'gemini_3.1_flash_image_preview',
      param: { output_format: 'png' },
    });
    await assert.rejects(
      executePlan(app, changed, { requestId: 'image-no-wait', wait: false, download: false }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
