/** 前端转换产物属于原授权且只从已验缓存恢复；禁止误读网页源和未知回执发布。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, rm, mkdir, realpath, symlink, writeFile, lstat, rename } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, quote, tinyGlb } from './helpers.ts';
import { saveVerifiedOutputCache } from '../cli/artifacts/verified-output-cache.ts';
import { bindFrontendOutput, frontendOutputKey, frontendProcessing } from '../cli/core/frontend-output.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import { object } from '../studio/contracts/errors.ts';
import { downloadTask, type Application } from '../cli/compat/runtime.ts';
import { fullTools } from '../cli/compat/full-tools.ts';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function prepared(
  options: {
    legacy?: boolean;
    state?: 'succeeded' | 'outcome_unknown';
    compatibility?: boolean;
    fbx?: boolean;
  } = {},
) {
  const f = await fixture(),
    raw = 'original-request',
    request = options.compatibility ? raw : `frontend-export:${raw}`;
  const input = {
    project_id: 'original-project',
    operator_id: 'original-operator',
    format: 'glb',
    public_model: false,
  };
  const job = f.jobs.prepare('test-account', request, 'export_lite', input, quote);
  const data = tinyGlb(),
    sha256 = digest(data);
  const proof = {
    version: 1,
    account_ref: 'test-account',
    intent: '1'.repeat(64),
    name: 'original-name',
    ...(!options.legacy ? { authorization_request_id: request } : {}),
    project_id: input.project_id,
    operator_id: input.operator_id,
    source_metadata: {},
    ...(options.fbx ? { source_format: 'fbx' } : {}),
    source_location: '2'.repeat(64),
    source_sha256: '3'.repeat(64),
    source_bytes: 123,
    output_sha256: sha256,
    output_bytes: data.length,
    conversion: {
      ...(options.fbx
        ? {
            source_format: 'fbx',
            transform_representation: 'verified_static_fbx_world_surface_bake',
            normalization: { source_format: 'fbx' },
            rest_state_restoration: { source_format: 'fbx' },
          }
        : {}),
      source_sha256: '3'.repeat(64),
      output_sha256: sha256,
      metadata: { forward_axis: '-y', pivot_to_center_bottom: true },
    },
  };
  const sourceKey = `frontend-export-proof:${raw}`;
  f.jobs.bindRequestPolicy('test-account', sourceKey, proof);
  const cached = await saveVerifiedOutputCache(
    job,
    { artifact_id: 'frontend-model', kind: 'model', format: 'glb', index: 0 },
    { sha256, bytes: data.length },
    data,
    f.dir,
  );
  f.jobs.update(job.job_id, options.state ?? 'succeeded', {
    remote_ids:
      options.state === 'outcome_unknown'
        ? {}
        : { project_id: input.project_id, operator_id: input.operator_id },
    progress: 100,
  });
  const intent = {
    version: 1,
    source: 'source-job',
    parameters: { format: 'GLTF' },
    project_id: input.project_id,
    operator_id: input.operator_id,
  };
  if (options.compatibility) {
    f.jobs.bindRequestPolicy('test-account', `frontend-convert-intent:${request}`, intent);
    f.jobs.bindRequestPolicy('test-account', `frontend-convert-proof:${request}`, {
      version: 1,
      intent: fingerprint(intent),
      source_sha256: proof.source_sha256,
      output_sha256: sha256,
      output_bytes: data.length,
      validation: { checked: true },
    });
  }
  const network = { calls: 0 };
  const blocked = async () => {
    network.calls++;
    throw new Error('Frontend recovery must stay local.');
  };
  f.gateway.artifactUrl = blocked;
  f.gateway.status = blocked;
  f.service.gateway.cost = blocked;
  return { ...f, job: f.jobs.get(job.job_id), proof, sourceKey, cached, data, sha256, network };
}
async function dispose(f: Awaited<ReturnType<typeof prepared>>) {
  f.jobs.close();
  await rm(f.dir, { recursive: true, force: true });
}
function alterPolicy(f: Awaited<ReturnType<typeof prepared>>, key: string, value: unknown) {
  const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
  try {
    db.prepare('UPDATE request_policies SET policy=? WHERE account_ref=? AND request_id=?').run(
      JSON.stringify(value),
      'test-account',
      key,
    );
  } finally {
    db.close();
  }
}

test('legacy frontend authorization binds one exact model and survives local get/list/download restart', async () => {
  const f = await prepared({ legacy: true });
  let originalClosed = false;
  try {
    const bound = await bindFrontendOutput(f.jobs, f.dir, f.job.job_id);
    assert.equal(bound.artifacts.length, 1);
    assert.equal(bound.artifacts[0]!.processing, frontendProcessing);
    assert.equal((await f.service.get(f.job.job_id, 30)).state, 'succeeded');
    const listed = object((f.service.list(20, 0).jobs as unknown[])[0]);
    assert.equal(listed.task_type, 'frontend_export');
    assert.equal(object(listed.frontend_output_validation).status, 'verified');
    f.jobs.close();
    originalClosed = true;
    const restarted = await fixture(f.dir);
    restarted.gateway.artifactUrl = f.gateway.artifactUrl;
    restarted.gateway.status = f.gateway.status;
    restarted.service.gateway.cost = f.service.gateway.cost;
    try {
      const downloaded = await restarted.service.download(f.job.job_id, 'model', 'restart.glb');
      assert.equal(downloaded.sha256, f.sha256);
      assert.deepEqual(await readFile(String(downloaded.local_path)), f.data);
      const repeated = await restarted.service.download(f.job.job_id, 'model', 'second.glb');
      assert.equal(repeated.sha256, f.sha256);
      assert.equal(restarted.jobs.list('test-account').length, 1);
      assert.equal(f.network.calls, 0);
    } finally {
      restarted.jobs.close();
    }
  } finally {
    if (!originalClosed) f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('frontend get completes a crash between authorization and binding without reading upstream', async () => {
  const f = await prepared();
  try {
    assert.equal(f.jobs.get(f.job.job_id).artifacts.length, 0);
    assert.equal(f.service.summary(f.job).state, 'needs_attention');
    const view = await f.service.get(f.job.job_id);
    assert.equal(view.state, 'succeeded');
    assert.equal((view.artifacts as unknown[]).length, 1);
    assert.equal(f.jobs.get(f.job.job_id).artifacts.length, 1);
    assert.equal(f.network.calls, 0);
  } finally {
    await dispose(f);
  }
});

test('FBX frontend recovery requires the original format in both frozen source and conversion proof', async () => {
  const f = await prepared({ fbx: true });
  try {
    await bindFrontendOutput(f.jobs, f.dir, f.job.job_id);
    const recovered = await f.service.download(f.job.job_id, 'model', 'verified-fbx-output.glb');
    assert.equal(recovered.sha256, f.sha256);
    assert.deepEqual(await readFile(String(recovered.local_path)), f.data);
    for (const part of ['source', 'conversion', 'both', 'null']) {
      const changed: Record<string, unknown> = { ...f.proof, conversion: { ...f.proof.conversion } },
        conversion = object(changed.conversion);
      if (part === 'source' || part === 'both') delete changed.source_format;
      if (part === 'conversion' || part === 'both') delete conversion.source_format;
      if (part === 'null') changed.source_format = conversion.source_format = null;
      alterPolicy(f, f.sourceKey, changed);
      assert.equal((await f.service.get(f.job.job_id)).state, 'needs_attention');
      await assert.rejects(f.service.download(f.job.job_id, 'model', `missing-format-${part}.glb`), {
        code: 'FRONTEND_OUTPUT_IDENTITY_CHANGED',
      });
    }
    assert.equal(f.network.calls, 0);
  } finally {
    await dispose(f);
  }
});

test('missing or damaged frontend cache never falls back to the original project model', async () => {
  const f = await prepared();
  try {
    await bindFrontendOutput(f.jobs, f.dir, f.job.job_id);
    await rm(f.cached.local_path!);
    assert.equal((await f.service.get(f.job.job_id)).state, 'needs_attention');
    assert.equal(f.service.summary(f.jobs.get(f.job.job_id)).state, 'needs_attention');
    await assert.rejects(f.service.download(f.job.job_id, 'model', 'missing.glb'), {
      code: 'FRONTEND_CACHE_MISSING',
    });
    assert.equal(f.network.calls, 0);
    assert.equal(f.jobs.get(f.job.job_id).state, 'succeeded');
  } finally {
    await dispose(f);
  }
});

test('unknown frontend authorization never acquires an artifact or publishes cached bytes', async () => {
  const f = await prepared({ state: 'outcome_unknown' });
  try {
    const view = await f.service.get(f.job.job_id);
    assert.equal(view.state, 'outcome_unknown');
    assert.deepEqual(view.artifacts, []);
    await assert.rejects(f.service.download(f.job.job_id, 'model', 'unknown.glb'), {
      code: 'FRONTEND_AUTHORIZATION_INCOMPLETE',
    });
    assert.equal(f.jobs.get(f.job.job_id).artifacts.length, 0);
    assert.equal(f.network.calls, 0);
  } finally {
    await dispose(f);
  }
});

test('frozen frontend proof or receipt drift is rejected by reads and final artifact CAS', async () => {
  const f = await prepared();
  try {
    const bound = await bindFrontendOutput(f.jobs, f.dir, f.job.job_id);
    alterPolicy(f, f.sourceKey, { ...f.proof, name: 'different-name' });
    assert.equal((await f.service.get(f.job.job_id)).state, 'needs_attention');
    assert.throws(() => f.jobs.saveArtifact(bound.job_id, bound.artifacts[0]!), {
      code: 'FRONTEND_OUTPUT_IDENTITY_CHANGED',
    });
    alterPolicy(f, f.sourceKey, f.proof);
    f.jobs.update(bound.job_id, 'succeeded', {
      remote_ids: { ...bound.remote_ids, operator_id: 'different-operator' },
    });
    await assert.rejects(f.service.download(bound.job_id, 'model', 'drift.glb'), {
      code: 'FRONTEND_OUTPUT_IDENTITY_CHANGED',
    });
    assert.equal(f.network.calls, 0);
  } finally {
    await dispose(f);
  }
});

test('compatible frontend task type requires both matching semantic policies and cannot be upgraded later', async () => {
  const f = await prepared({ compatibility: true });
  try {
    const bound = await bindFrontendOutput(f.jobs, f.dir, f.job.job_id);
    assert.equal(f.service.summary(bound).task_type, 'convert_model');
    const policy = f.jobs.requestPolicy('test-account', `frontend-convert-proof:${bound.request_id}`)!;
    alterPolicy(f, `frontend-convert-proof:${bound.request_id}`, {
      ...policy,
      validation: { changed: true },
    });
    assert.equal((await f.service.get(bound.job_id)).state, 'needs_attention');
    assert.throws(() => f.jobs.saveArtifact(bound.job_id, bound.artifacts[0]!), {
      code: 'FRONTEND_OUTPUT_IDENTITY_CHANGED',
    });
  } finally {
    await dispose(f);
  }
});

test('frontend artifact content and authorization namespace cannot be rebound to another proof', async () => {
  const f = await prepared();
  try {
    const bound = await bindFrontendOutput(f.jobs, f.dir, f.job.job_id);
    assert.throws(
      () => f.jobs.saveArtifact(bound.job_id, { ...bound.artifacts[0]!, sha256: '9'.repeat(64) }),
      { code: 'FRONTEND_OUTPUT_CONTENT_CHANGED' },
    );
    assert.throws(
      () =>
        f.jobs.bindFrontendArtifact(bound, bound.artifacts[0]!, f.sourceKey, f.proof, {
          ...f.jobs.requestPolicy('test-account', frontendOutputKey(bound)),
          identity: '9'.repeat(64),
        }),
      { code: 'FRONTEND_OUTPUT_IDENTITY_CHANGED' },
    );
    alterPolicy(f, f.sourceKey, { ...f.proof, authorization_request_id: 'another-request' });
    await assert.rejects(bindFrontendOutput(f.jobs, f.dir, bound.job_id), {
      code: 'FRONTEND_OUTPUT_IDENTITY_CHANGED',
    });
  } finally {
    await dispose(f);
  }
});

test('standalone and compatible frontend downloads reuse the verified file through explicit directory aliases', async () => {
  for (const compatibility of [false, true]) {
    const f = await prepared({ compatibility });
    try {
      f.service.config.outputDir = '';
      const canonical = await realpath(path.join(f.dir, 'output'));
      const alias =
        process.platform === 'darwin' && canonical.startsWith('/private/var/')
          ? canonical.slice('/private'.length)
          : path.join(f.dir, 'output-alias');
      if (!alias.startsWith('/var/')) await symlink(canonical, alias);
      const first = await f.service.download(f.job.job_id, 'model', path.join(alias, 'model.glb'));
      assert.equal(first.local_path, path.join(canonical, 'model.glb'));
      const original = f.jobs.get(f.job.job_id);
      for (const directory of [alias, canonical]) {
        const direct = await f.service.download(f.job.job_id, 'model', path.join(directory, 'model.glb'));
        assert.equal(direct.local_path, first.local_path);
        assert.equal(direct.sha256, f.sha256);
        const result = await downloadTask(
          { service: f.service } as Application,
          await f.service.get(f.job.job_id),
          { out: directory },
        );
        assert.equal(result.model_file, first.local_path);
        assert.deepEqual(await readFile(String(result.model_file)), f.data);
      }
      assert.deepEqual(f.jobs.get(f.job.job_id), original);
      assert.equal(f.network.calls, 0);
    } finally {
      await dispose(f);
    }
  }
});

test('frontend reuse rejects other existing files, damaged originals and final symlinks without overwriting', async () => {
  for (const compatibility of [false, true]) {
    const f = await prepared({ compatibility });
    try {
      f.service.config.outputDir = '';
      const canonical = await realpath(path.join(f.dir, 'output'));
      const target = path.join(canonical, 'model.glb');
      await f.service.download(f.job.job_id, 'model', target);
      const original = f.jobs.get(f.job.job_id);
      const otherDirectory = path.join(canonical, 'another-task');
      await mkdir(otherDirectory);
      const copy = path.join(otherDirectory, 'model.glb');
      await writeFile(copy, f.data);
      await assert.rejects(
        downloadTask({ service: f.service } as Application, await f.service.get(f.job.job_id), {
          out: otherDirectory,
        }),
        { code: 'OUTPUT_EXISTS' },
      );
      assert.deepEqual(await readFile(copy), f.data);
      const corrupt = Buffer.from(f.data);
      corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
      await writeFile(target, corrupt);
      await assert.rejects(f.service.download(f.job.job_id, 'model', target), { code: 'OUTPUT_EXISTS' });
      assert.deepEqual(await readFile(target), corrupt);
      await rm(target);
      await symlink(copy, target);
      await assert.rejects(f.service.download(f.job.job_id, 'model', target), { code: 'OUTPUT_EXISTS' });
      assert.equal((await lstat(target)).isSymbolicLink(), true);
      assert.deepEqual(await readFile(copy), f.data);
      await rm(target);
      await mkdir(target);
      await assert.rejects(f.service.download(f.job.job_id, 'model', target), { code: 'OUTPUT_EXISTS' });
      assert.equal((await lstat(target)).isDirectory(), true);
      assert.deepEqual(f.jobs.get(f.job.job_id), original);
      assert.equal(f.network.calls, 0);
    } finally {
      await dispose(f);
    }
  }
});

for (const compatibility of [false, true])
  test(`CLI and full MCP ${compatibility ? 'compatible' : 'standalone'} frontend download reject a same-byte replacement at the saved local_path`, async () => {
    const f = await prepared({ compatibility });
    try {
      const root = await realpath(path.join(f.dir, 'output'));
      f.service.config.outputDir = root;
      const app = { service: f.service } as Application,
        id = f.job.job_id,
        delivered = await downloadTask(app, await f.service.get(id), { out: root }),
        file = String(delivered.model_file),
        previous = await lstat(file),
        proof = f.jobs.requestPolicy('test-account', f.sourceKey);
      await rename(file, file + '.original');
      await writeFile(file, f.data);
      const replacement = await lstat(file);
      assert.notEqual(replacement.ino, previous.ino);
      await assert.rejects(downloadTask(app, await f.service.get(id), { out: path.dirname(file) }), {
        code: 'OUTPUT_EXISTS',
      });
      const tool = fullTools(app.service, app.studio).find((entry) => entry.name === 'ai_modeling_download')!;
      await assert.rejects(tool.run({ task_id: id, output_dir: path.dirname(file) }), {
        code: 'OUTPUT_EXISTS',
      });
      const after = await lstat(file);
      assert.equal(after.ino, replacement.ino);
      assert.equal(after.mtimeMs, replacement.mtimeMs);
      assert.deepEqual(await readFile(file), f.data);
      assert.deepEqual(f.jobs.requestPolicy('test-account', f.sourceKey), proof);
      assert.equal(f.gateway.posts, 0);
      assert.equal(f.network.calls, 0);
    } finally {
      await dispose(f);
    }
  });
