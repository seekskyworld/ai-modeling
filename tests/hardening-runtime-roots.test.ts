/** frontend-export与runtime install必须服从同一输入根；合成引擎仍需通过原固定摘要检查。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { fixture, tinyGlb } from './helpers.ts';
import { StudioClient } from '../studio/api/client.ts';
import { submitFrontendExport } from '../cli/core/frontend-export.ts';
import { loadStudioAssimpAssets, studioAssimpFiles } from '../cli/artifacts/studio-assimp-assets.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';

const input = {
  project_id: 'synthetic-project',
  operator_id: 'synthetic-operator',
  request_id: 'synthetic-export',
  forward_axis: '-y',
  pivot_to_center_bottom: true,
};

test('frontend runtime_dir rejects an out-of-root path before source, download, conversion or authorization', async () => {
  const f = await fixture();
  try {
    const allowed = path.join(f.dir, 'allowed'),
      outside = path.join(f.dir, 'outside');
    await mkdir(allowed);
    await mkdir(outside);
    await symlink(outside, path.join(allowed, 'linked-outside'));
    f.service.config.inputRoots = [allowed];
    const forbidden = async (): Promise<never> =>
      assert.fail('Rejected runtime must not reach business work');
    const client = new StudioClient(f.service.credentials, forbidden);
    for (const runtime_dir of [outside, path.join(allowed, 'linked-outside')]) {
      await assert.rejects(
        submitFrontendExport(
          f.service,
          client,
          { ...input, runtime_dir },
          {
            source: forbidden,
            read: forbidden,
            convert: forbidden,
          },
        ),
        { code: 'INPUT_PATH_DENIED' },
      );
      await assert.rejects(
        loadStudioAssimpAssets({ dataDir: f.dir, runtimeDir: runtime_dir, inputRoots: [allowed] }, forbidden),
        { code: 'INPUT_PATH_DENIED' },
      );
    }
    assert.equal(f.gateway.posts, 0);
    assert.deepEqual(f.jobs.list('test-account'), []);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('an allowed runtime directory still rejects corrupt pinned bytes without network fallback', async () => {
  const f = await fixture();
  try {
    const runtimeDir = path.join(f.dir, 'engine');
    await mkdir(runtimeDir);
    await writeFile(
      path.join(runtimeDir, studioAssimpFiles.glue.name),
      Buffer.alloc(studioAssimpFiles.glue.bytes),
    );
    await assert.rejects(
      loadStudioAssimpAssets({ dataDir: f.dir, runtimeDir, inputRoots: [f.dir] }, async () =>
        assert.fail('Explicit invalid runtime cannot fall back to network'),
      ),
      { code: 'FRONTEND_RUNTIME_INTEGRITY' },
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('frontend-export passes the configured roots to the actual conversion boundary', async () => {
  const f = await fixture();
  try {
    const runtimeDir = path.join(f.dir, 'engine');
    await mkdir(runtimeDir);
    let conversions = 0;
    const client = new StudioClient(f.service.credentials, async () => assert.fail('No real network'));
    await assert.rejects(
      submitFrontendExport(
        f.service,
        client,
        { ...input, runtime_dir: runtimeDir },
        {
          source: async () => ({
            url: 'https://cdn.tripo3d.ai/synthetic.glb',
            name: 'synthetic',
            metadata: {},
          }),
          read: async () => tinyGlb(),
          convert: async (_bytes, options) => {
            conversions++;
            assert.equal(options.runtimeDir, runtimeDir);
            assert.deepEqual(options.inputRoots, f.service.config.inputRoots);
            throw new TripoError('SYNTHETIC_STOP', 'Reached the checked conversion boundary.');
          },
        },
      ),
      { code: 'SYNTHETIC_STOP' },
    );
    assert.equal(conversions, 1);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('recovering verified frontend output does not reopen an obsolete runtime directory or repeat authorization', async () => {
  const f = await fixture();
  try {
    const runtimeDir = path.join(f.dir, 'original-engine');
    await mkdir(runtimeDir);
    const bytes = tinyGlb(),
      hash = createHash('sha256').update(bytes).digest('hex');
    const metadata = { forward_axis: '-y', pivot_to_center_bottom: true };
    const forbidden = async (): Promise<never> =>
      assert.fail('Recovery must use the original proof and cache');
    const client = new StudioClient(f.service.credentials, forbidden);
    f.gateway.submit = async () => {
      f.gateway.posts++;
      return {
        remote_ids: { project_id: input.project_id, operator_id: input.operator_id },
        status: { state: 'succeeded', progress: 100, artifacts: [] },
      };
    };
    const request = { ...input, max_credits: 10, runtime_dir: runtimeDir };
    const result = await submitFrontendExport(f.service, client, request, {
      source: async () => ({ url: 'https://cdn.tripo3d.ai/synthetic.glb', name: 'synthetic', metadata: {} }),
      read: async () => bytes,
      convert: async () => ({ bytes, proof: { source_sha256: hash, output_sha256: hash, metadata } }),
    });
    await rm(runtimeDir, { recursive: true });
    f.service.config.inputRoots = [f.service.config.outputDir];
    const recovered = await submitFrontendExport(f.service, client, request, {
      source: forbidden,
      read: forbidden,
      convert: forbidden,
    });
    assert.equal(recovered.export_lite_job_id, result.export_lite_job_id);
    assert.equal(object(recovered.export_lite_job).state, 'succeeded');
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
