/** 独立核对扩展引用的模型隔离、完整槽位、异步顺序与原持久请求恢复。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { resolveImageReferences, planImageReferences } from '../cli/compat/image-references.ts';
import { imageSchema, normalize } from '../studio/contracts/schemas.ts';
import { object } from '../studio/contracts/errors.ts';
import type { Job } from '../studio/contracts/types.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { Operations } from '../studio/api/operations.ts';
import type { ImageReference } from '../studio/api/upload.ts';
import { fixture } from './helpers.ts';

const asset = (index: number) => ({ asset_id: `asset-${index}`, output_index: 0 });
const assets = (count: number) => Array.from({ length: count }, (_, index) => asset(index + 1));
const input = { prompt: 'Compare every ordered input.', model_version: 'gpt_image_2' };
const imageJob = (reference: string): Job =>
  ({
    job_id: reference,
    account_ref: 'test-account',
    operation: 'image',
    state: 'succeeded',
    remote_ids: { asset_id: reference.replace('@', 'asset-') },
  }) as Job;
const complete = (assetId: string) => ({
  asset_id: assetId,
  status: 'success',
  output: { data: [{ bucket: 'fixture', key: assetId, image_audit_result: 'pass' }] },
});
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('extended reference admission stays conditional across every image model and source form', () => {
  const models = [
    'flux.1_dev',
    'flux.1_kontext_pro',
    'gemini_2.5_flash_image_preview',
    'gemini_3.1_flash_image_preview',
    'gemini_3_pro_image_preview',
    'gpt_4o',
    'gpt_image_1.5',
    'gpt_image_2',
    'gpt_image_2.5_sunburst',
    'midjourney',
  ];
  for (const model_version of models)
    for (const primary of [{}, { image_path: '' }, { image_path: 'base.png' }, { image_asset: asset(0) }])
      for (const count of [0, 1, 10, 11, 15, 16, 17])
        for (const [key, references] of Object.entries({
          image_paths: Array.from({ length: count }, (_, i) => `file-${i}.png`),
          image_assets: assets(count),
          image_sources: assets(count).map((source, i) => (i % 2 ? { image_path: `file-${i}.png` } : source)),
        })) {
          const hasPrimary = Boolean(primary.image_path || primary.image_asset);
          const expected =
            model_version !== 'midjourney' &&
            count > 0 &&
            count <=
              (['gpt_image_2', 'gpt_image_2.5_sunburst'].includes(model_version)
                ? hasPrimary
                  ? 15
                  : 16
                : 10);
          assert.equal(
            imageSchema.safeParse({ ...input, model_version, ...primary, [key]: references }).success,
            expected,
            JSON.stringify({ model_version, primary, key, count }),
          );
        }
});

test('null, overlapping roles and multiple reference arrays cannot borrow extended admission', () => {
  for (const invalid of [
    { image_asset: null, image_assets: assets(15) },
    { image_asset: {}, image_assets: assets(15) },
    { image_path: null, image_assets: assets(15) },
    { image_path: false, image_assets: assets(15) },
    { image_path: 'base.png', image_asset: asset(0), image_assets: assets(15) },
    { image_asset: asset(0), image_assets: assets(15), image_sources: assets(1) },
    { image_asset: asset(0), image_assets: assets(15), image_paths: ['extra.png'] },
    { image_asset: asset(0), image_sources: assets(15), image_paths: ['extra.png'] },
    { image_asset: asset(0), image_sources: [...assets(14), null] },
    { image_asset: asset(0), image_sources: [...assets(14), { ...asset(15), image_path: 'extra.png' }] },
  ])
    assert.equal(imageSchema.safeParse({ ...input, ...invalid }).success, false);
});

test('sixteen task bindings retain order after reversed asynchronous completion and repeated identity', async () => {
  const refs = Array.from({ length: 16 }, (_, i) => `@${i}`);
  const plan = planImageReferences(refs, true)!;
  const started = deferred<undefined>();
  const pending = new Map<string, ReturnType<typeof deferred<unknown>>>();
  const result = resolveImageReferences(plan.parameters, plan.bindings, {
    accountRef: 'test-account',
    findJob: imageJob,
    refreshJob: async () => {
      throw new Error('Successful source must not be refreshed.');
    },
    readAsset: (id) => {
      const wait = deferred<unknown>();
      pending.set(id, wait);
      if (pending.size === 16) started.resolve(undefined);
      return wait.promise;
    },
  });
  await started.promise;
  for (let i = 15; i >= 0; i--) pending.get(`asset-${i}`)!.resolve(complete(`asset-${i}`));
  const resolved = await result;
  assert.deepEqual(resolved.image_asset, asset(0));
  assert.deepEqual(resolved.image_sources, assets(15));
  refs[15] = refs[0]!;
  const repeated = planImageReferences(refs, true)!;
  let reads = 0;
  const resolver = {
    accountRef: 'test-account',
    findJob: imageJob,
    refreshJob: async (id: string) => imageJob(id),
    readAsset: async (id: string) => {
      reads++;
      return complete(id);
    },
  };
  const duplicated = await resolveImageReferences(repeated.parameters, repeated.bindings, resolver);
  assert.equal(reads, 15);
  assert.deepEqual(duplicated.image_sources, [...assets(14), asset(0)]);
  await assert.rejects(resolveImageReferences(plan.parameters, plan.bindings, resolver, duplicated), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

test('native mapping keeps distinct primary-plus-fifteen and ordinary-sixteen roles and order', async () => {
  const client = new StudioClient(
    new MemoryCredentials({
      accountRef: 'test-account',
      cookie: 'fixture',
      deviceId: 'device',
      importedAt: '',
    }),
    async (url, init) => {
      assert.equal(new URL(url).pathname, '/v2/studio/image/get_image_asset');
      const body = object(JSON.parse(String(init.body)));
      return Response.json({
        code: 0,
        data: {
          asset_id: body.asset_id,
          status: 'success',
          output: {
            data: Array.from({ length: 16 }, (_, i) => ({
              bucket: 'fixture',
              key: `${body.asset_id}:${i}`,
              image_audit_result: 'pass',
            })),
          },
        },
      });
    },
  );
  class LocalReference extends Operations {
    override async imageReference(
      parameters: Record<string, unknown>,
      file?: string,
    ): Promise<ImageReference> {
      if (!file) return await super.imageReference(parameters);
      assert.equal(object(parameters._input_files)[file], 'frozen');
      return { bucket: 'fixture', key: file, image_source: 'upload', image_audit_result: 'pass' };
    }
  }
  const sources = assets(15).map((source, i) =>
    i % 3 === 1 ? { image_path: `/caller/${i + 1}.png` } : { ...source, output_index: i + 1 },
  );
  const normalized = normalize('image', { ...input, image_asset: asset(0), image_sources: sources });
  normalized._input_files = Object.fromEntries(
    sources.flatMap((source) => ('image_path' in source ? [[source.image_path, 'frozen']] : [])),
  );
  const operations = new LocalReference(client, []);
  const request = await operations.build({
    operation: 'image',
    input: normalized,
  } as Job);
  assert.equal(request.route, '/v2/studio/image/gen_image_v2');
  assert.equal(object(request.body.image).key, 'asset-0:0');
  assert.deepEqual(
    (request.body.images as ImageReference[]).map((source) => source.key),
    sources.map((source) =>
      'image_path' in source ? source.image_path : `${source.asset_id}:${source.output_index}`,
    ),
  );
  assert.equal(object((request.body.images as unknown[])[14]).key, 'asset-15:15');
  const ordinary = normalize('image', { ...input, image_sources: [asset(0), ...sources] });
  ordinary._input_files = normalized._input_files;
  const ordinaryRequest = await operations.build({ operation: 'image', input: ordinary } as Job);
  assert.equal(Object.hasOwn(ordinaryRequest.body, 'image'), false);
  assert.deepEqual(ordinaryRequest.body.images, [request.body.image, ...(request.body.images as unknown[])]);
  for (const [parameters, expected] of [
    [normalized, request.body],
    [ordinary, ordinaryRequest.body],
  ] as const) {
    const alternate = await operations.build({
      ...imageJob('@mapping'),
      input: { ...parameters, model_version: 'gpt_image_2.5_sunburst' },
    });
    assert.deepEqual(alternate.body, { ...expected, model_version: 'gpt_image_2.5_sunburst' });
  }
});

test('sixteen-image request resumes original receipt and rejects changed final role without resubmission', async () => {
  for (const model_version of ['gpt_image_2', 'gpt_image_2.5_sunburst']) {
    const first = await fixture();
    let firstOpen = true;
    const parameters = { ...input, model_version, image_asset: asset(0), image_assets: assets(15) };
    const ordinary = { ...input, model_version, image_assets: assets(16) };
    try {
      const submitted = await first.service.submit('image', 'gpt16-review', parameters, 20);
      const submittedList = await first.service.submit('image', 'gpt16-list-review', ordinary, 20);
      assert.equal(first.gateway.posts, 2);
      const jobId = String(submitted.job_id);
      const listId = String(submittedList.job_id);
      assert.deepEqual(first.jobs.get(jobId).input.image_assets, assets(15));
      assert.deepEqual(first.jobs.get(listId).input.image_assets, assets(16));
      assert.equal(Object.hasOwn(first.jobs.get(listId).input, 'image_asset'), false);
      first.jobs.close();
      firstOpen = false;
      const restarted = await fixture(first.dir);
      try {
        const resumed = await restarted.service.submit('image', 'gpt16-review', parameters, 20);
        const resumedList = await restarted.service.submit('image', 'gpt16-list-review', ordinary, 20);
        assert.equal(resumed.job_id, jobId);
        assert.equal(resumedList.job_id, listId);
        assert.equal(restarted.gateway.posts, 0);
        await assert.rejects(
          restarted.service.submit(
            'image',
            'gpt16-review',
            { ...parameters, image_assets: [...assets(14), asset(0)] },
            20,
          ),
          { code: 'IDEMPOTENCY_CONFLICT' },
        );
        await assert.rejects(
          restarted.service.submit(
            'image',
            'gpt16-list-review',
            { ...ordinary, image_assets: [...assets(15), asset(0)] },
            20,
          ),
          { code: 'IDEMPOTENCY_CONFLICT' },
        );
        for (const invalid of [
          { ...input, image_assets: assets(17) },
          { ...parameters, model_version: 'gpt_image_1.5' },
          { ...parameters, image_assets: assets(16) },
        ])
          await assert.rejects(restarted.service.submit('image', 'invalid-gpt16-review', invalid, 20));
        assert.equal(restarted.gateway.posts, 0);
        assert.equal(restarted.jobs.list('test-account').length, 2);
      } finally {
        restarted.jobs.close();
      }
    } finally {
      if (firstOpen) first.jobs.close();
      await rm(first.dir, { recursive: true, force: true });
    }
  }
});
