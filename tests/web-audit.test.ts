/** 针对本轮网页对照发现的真实差异验请求语义，尤其是字段丢失和新微服务的账号边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, quote, tinyGlb } from './helpers.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient, type Fetcher } from '../studio/api/client.ts';
import { WebMicroClient } from '../studio/api/micro-client.ts';
import { Operations } from '../studio/api/operations.ts';
import { resources, callResource } from '../studio/api/resources.ts';
import { libraryResources } from '../studio/api/library.ts';
import { extraResources } from '../studio/api/extra-resources.ts';
import { normalize, animateSchema } from '../studio/contracts/schemas.ts';
import { object, array } from '../studio/contracts/errors.ts';
import { listMotionPresets } from '../studio/contracts/motion-presets.ts';
import { buildProgram } from '../cli/compat/program.ts';
import { resourceInput } from '../cli/compat/resource-options.ts';
import { toolRegistry } from '../cli/commands.ts';
import { downloadExistingArtifact } from '../cli/artifacts/library-download.ts';
import path from 'node:path';

function makeClient(fetcher: Fetcher): StudioClient {
  const bearer =
    'eyJhbGciOiJIUzI1NiJ9.' +
    Buffer.from(JSON.stringify({ sub: 'subject', exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      'base64url',
    ) +
    '.fixture';
  return new StudioClient(
    new MemoryCredentials({
      accountRef: 'test-account',
      bearer,
      cookie: 'fake-session',
      deviceId: 'device',
      importedAt: new Date().toISOString(),
    }),
    fetcher,
  );
}
const resource = (name: string) => resources.find((r) => r.name === name)!;

test('model generation maps part detail and T-pose to the actual webpage fields', async () => {
  const f = await fixture();
  const operations = new Operations(
    makeClient(async () => {
      throw Error('Unexpected request');
    }),
    [],
  );
  try {
    for (const [level, granularity] of [
      ['coarse', 'simple'],
      ['medium', 'balanced'],
      ['fine', 'detailed'],
    ]) {
      const input = normalize('model', {
        mode: 'text',
        prompt: 'character',
        generate_parts: true,
        generate_parts_level: level,
        t_pose: true,
      });
      const job = f.jobs.prepare('test-account', 'detail-' + level, 'model', input, quote);
      const request = await operations.build(job);
      assert.equal(request.route, '/v2/studio/operation/text_to_model');
      assert.equal(request.body.segmentation_granularity, granularity);
      assert.equal(request.body.generate_parts_level, undefined);
      assert.equal(request.body.t_pose, true);
    }
    const input = normalize('model', {
      mode: 'text',
      prompt: 'prop',
      model_version: 'Nexus-v2.0-20260801',
      symmetry: false,
    });
    const job = f.jobs.prepare('test-account', 'symmetry', 'model', input, quote);
    assert.equal((await operations.build(job)).body.symmetry, false);
    assert.throws(() => normalize('model', { mode: 'image', image_path: 'image.png', t_pose: true }));
    assert.throws(() => normalize('model', { mode: 'text', prompt: 'prop', symmetry: true }));
    assert.throws(() =>
      normalize('model', { mode: 'multiview', image_paths: [null, 'left.png', 'back.png', null] }),
    );
    assert.throws(() =>
      normalize('model', { mode: 'multiview', image_paths: ['front.png', null, null, null] }),
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('gallery search preserves categories, labels and pagination in the scoped web RPC', async () => {
  let body: Record<string, unknown> = {};
  let calls = 0;
  const client = makeClient(async (url, init) => {
    calls++;
    assert.equal(url, 'https://msapi.tripo3d.ai/ms/web/api');
    const headers = object(init.headers);
    assert.equal(headers['x-micro-service'], 'tripo.community.api.search');
    assert.equal(headers['x-micro-method'], '/tripo.community.api.search.SearchService/SearchItems');
    assert.equal(headers['x-uid'], 'subject');
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    body = JSON.parse(String(init.body));
    return Response.json({
      error: { code: 0 },
      items: [],
      nextPageToken: 'next',
      accessToken: 'do-not-return',
      cookie: 'do-not-return',
    });
  });
  const result = object(
    await callResource(client, resource('gallery_browse'), {
      category: 'vehicle',
      model_type: 'smart_mesh',
      use_case: '3d_printing',
      sort: 'most_likes',
      page_token: 'cursor',
    }),
  );
  assert.equal(body.appId, 'tripo');
  assert.equal(body.scope, 1);
  assert.equal(object(body.search).sort, 5);
  assert.equal(object(body.search).pageToken, 'cursor');
  assert.deepEqual(object(object(body.search).filter).categories, ['vehicle']);
  assert.deepEqual(object(object(body.search).filter).labels, ['mtp:smart_mesh', 'uc:3d printing']);
  assert.equal(result.nextPageToken, 'next');
  assert.equal(result.error, undefined);
  assert.equal(result.accessToken, undefined);
  assert.equal(result.cookie, undefined);
  await callResource(client, resource('gallery_browse'), { query: 'blue robot' });
  assert.equal(object(body.search).sort, 1);
  assert.equal(object(object(body.search).filter).categories, undefined);
  assert.equal(object(object(body.search).filter).featured, undefined);
  const rpc = new WebMicroClient(client, 'community');
  await assert.rejects(rpc.call('/tripo.canvas.api.agent.ProjectService/DeleteProject', {}), {
    code: 'INVALID_ROUTE',
  });
  await assert.rejects(rpc.call('/tripo.community.api.search.SearchService/DeleteItems', {}), {
    code: 'INVALID_ROUTE',
  });
  assert.equal(calls, 2);
});

test('collection and own-library queries use distinct services and do not silently drop filters', async () => {
  const seen: { method: unknown; body: Record<string, unknown> }[] = [];
  const client = makeClient(async (_url, init) => {
    seen.push({ method: object(init.headers)['x-micro-method'], body: JSON.parse(String(init.body)) });
    return Response.json({ items: [] });
  });
  await callResource(client, resource('collection_list'), { query: 'robot', page_token: 'collected-next' });
  await callResource(client, resource('library_list'), { scope: 'team', type: 'rigged' });
  await callResource(client, resource('gallery_item'), { item_id: 'example' });
  assert.equal(seen[0]?.method, '/tripo.community.api.search.SearchService/SearchMyCollectedItems');
  assert.equal(seen[0]?.body.query, 'robot');
  assert.equal(seen[1]?.body.scope, 3);
  assert.deepEqual(object(object(seen[1]?.body.search).filter).opTags, ['rigged']);
  assert.equal(seen[2]?.method, '/tripo.community.api.content.ContentService/GetItem');
  assert.deepEqual(seen[2]?.body, { appId: 'tripo', itemId: 'example', source: 1, view: 2 });
  assert.throws(() => resource('library_list').schema.parse({ scope: 'arbitrary' }));
});

test('image symmetry validates the existing image and only sends its audited storage reference', async () => {
  let pass = true;
  const bodies: Record<string, unknown>[] = [];
  const client = makeClient(async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/get_image_asset'))
      return Response.json({
        code: 0,
        data: {
          asset_id: 'asset',
          status: 'success',
          output: {
            data: [{ bucket: 'test', key: 'picture.png', image_audit_result: pass ? 'pass' : 'reject' }],
          },
        },
      });
    assert.ok(url.endsWith('/symmetry_check'));
    bodies.push(body);
    return Response.json({ code: 0, data: { symmetry: true } });
  });
  assert.deepEqual(await callResource(client, resource('symmetry_check'), { asset_id: 'asset' }), {
    symmetry: true,
  });
  assert.deepEqual(bodies, [{ image: { bucket: 'test', key: 'picture.png' } }]);
  pass = false;
  await assert.rejects(callResource(client, resource('symmetry_check'), { asset_id: 'asset' }), {
    code: 'CONTENT_AUDIT_REJECTED',
  });
  assert.equal(bodies.length, 1);
});

test('microservice reads never retry lost responses and require a valid local session', async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls++;
    throw Error('Disconnected');
  });
  await assert.rejects(callResource(client, resource('gallery_feed'), {}), {
    code: 'NETWORK_ERROR',
    certainty: 'read',
  });
  assert.equal(calls, 1);
  const invalid = new StudioClient({ load: () => undefined, save: () => {}, clear: () => {} }, async () => {
    throw Error('Must not send');
  });
  await assert.rejects(callResource(invalid, resource('gallery_feed'), {}), { code: 'AUTH_REQUIRED' });
});

test('existing browser models download without generation, without credentials on CDN requests and without overwriting', async () => {
  const f = await fixture();
  let wrongVersion = false;
  let readCalls = 0;
  let downloads = 0;
  const client = makeClient(async (url, init) => {
    readCalls++;
    assert.equal(init.method, 'GET');
    assert.ok(url.endsWith('/project?operator_id=original'));
    return Response.json({
      code: 0,
      data: {
        id: 'project',
        operator: { operator_id: wrongVersion ? 'different' : 'original', status: 'success' },
        model_url: 'https://cdn.tripo3d.ai/model.glb?signature=private',
      },
    });
  });
  const input = {
    kind: 'model',
    id: 'project',
    operator_id: 'original',
    destination_path: path.join(f.dir, 'output', 'original.glb'),
  };
  const fetcher: Fetcher = async (_url, init) => {
    downloads++;
    assert.equal(init.headers, undefined);
    return new Response(new Uint8Array(tinyGlb()));
  };
  try {
    const saved = await downloadExistingArtifact(client, f.service.config.outputDir, input, fetcher);
    assert.equal(saved.source_id, 'project');
    assert.equal(saved.operator_id, 'original');
    assert.equal(saved.format, 'glb');
    assert.equal(saved.url, undefined);
    assert.equal(JSON.stringify(saved).includes('signature'), false);
    await assert.rejects(downloadExistingArtifact(client, f.service.config.outputDir, input, fetcher), {
      code: 'OUTPUT_EXISTS',
    });
    wrongVersion = true;
    await assert.rejects(
      downloadExistingArtifact(
        client,
        f.service.config.outputDir,
        { ...input, destination_path: path.join(f.dir, 'output', 'other.glb') },
        fetcher,
      ),
      { code: 'CONTRACT_CHANGED' },
    );
    assert.equal(downloads, 1);
    assert.equal(readCalls, 2);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('every added resource is accessible from CLI and MCP, with usable offline animation identifiers', async () => {
  const f = await fixture();
  try {
    const client = makeClient(async () => {
      throw Error('No network required');
    });
    const tools = toolRegistry(f.service, { client, assets: async () => ({}) });
    const studio = buildProgram().commands.find((c) => c.name() === 'studio')!;
    for (const spec of [...libraryResources, ...extraResources]) {
      assert.ok(studio.commands.find((c) => c.name() === spec.name.replaceAll('_', '-')));
      assert.ok(tools.find((t) => t.name === 'ai_modeling_' + spec.name));
    }
    const command = studio.commands.find((c) => c.name() === 'gallery-browse')!;
    command.parseOptions(['--model-type', 'pbr', '--page-token', 'cursor', '--featured-only', 'false']);
    assert.deepEqual(resourceInput(command.opts(), resource('gallery_browse').schema), {
      model_type: 'pbr',
      page_token: 'cursor',
      featured_only: false,
    });
    const catalog = listMotionPresets({});
    assert.equal(catalog.total, 102);
    for (const item of array(catalog.items).map(object))
      animateSchema.parse({ project_id: 'project', animation: item.animation });
    const biped = array(listMotionPresets({ rig_type: 'biped', category: 'basic' }).items).map(object);
    assert.ok(biped.some((item) => item.animation === 'preset:biped:walk'));
    assert.ok(tools.find((t) => t.name === 'ai_modeling_motion_presets'));
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
