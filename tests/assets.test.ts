/** Website asset inventory is distinct from local task history and generation-model discovery. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Command } from 'commander';
import { registerAssets } from '../cli/assets/commands.ts';
import { assetsListSchema, listAssets } from '../cli/assets/list.ts';
import { callTool, toolRegistry } from '../cli/commands.ts';
import type { Application } from '../cli/compat/runtime.ts';
import { imageAssetSummary, modelAssetSummary } from '../studio/api/asset-summary.ts';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';

const session = {
  cookie: 'controlled-cookie',
  deviceId: 'controlled-device',
  accountRef: 'controlled-account',
  importedAt: '2026-11-17T00:00:00Z',
};

function model() {
  return {
    id: 'website-model',
    project_name: 'Blue robot',
    create_time: '2026-11-17T00:00:00Z',
    visibility: 'private',
    type: 'textured',
    status: 'success',
    collected: true,
    is_owner: true,
    running_operator: { operator_id: 'running-op', account_id: 'private-account' },
    cover_image: ['https://cdn.tripo3d.ai/private-account/cover.png?signature=private-signature'],
    model_url: 'https://cdn.tripo3d.ai/private-account/model.glb?signature=private-signature',
    account_id: 'private-account',
    credentials: { token: 'private-token' },
  };
}

function image(index = 0) {
  return {
    asset_id: `website-image-${index}`,
    status: 'success',
    type: 'generate_image',
    create_time: index,
    input: { model_version: 'gpt_image_1.5', prompt: 'Blue robot reference', account_ref: 'private-account' },
    output: {
      data: [
        {
          url: 'https://cdn.tripo3d.ai/private-account/front.webp?signature=private-signature',
          key: 'private-account/front.webp',
          bucket: 'private-bucket',
          user_id: 'private-account',
        },
        {
          url: 'https://cdn.tripo3d.ai/private-account/back.webp?signature=private-signature',
          key: 'private-account/back.webp',
        },
      ],
    },
    user_id: 'private-account',
    token: 'private-token',
  };
}

function gateway(respond: (url: URL, body: Record<string, unknown>) => unknown) {
  const client = new StudioClient(new MemoryCredentials(session), async (url, init) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    return Response.json({ code: 0, data: respond(new URL(url), body) });
  });
  return new StudioGateway(client, [], new MemoryLinks());
}

test('model selection metadata comes from the website inventory and omits URLs and account fields', async () => {
  const studio = gateway((url) => {
    assert.equal(url.pathname, '/v2/studio/assets/v2');
    assert.equal(url.searchParams.get('asset_type'), 'mine');
    assert.equal(url.searchParams.get('offset'), '20');
    assert.equal(url.searchParams.get('size'), '10');
    return { projects: [model()], total: 42 };
  });
  const result = await listAssets(studio, { kind: 'model', offset: 20, limit: 10 });
  assert.deepEqual(result, {
    assets: [
      {
        project_id: 'website-model',
        name: 'Blue robot',
        create_time: '2026-11-17T00:00:00Z',
        visibility: 'private',
        type: 'textured',
        status: 'success',
        collected: true,
        is_owner: true,
        running: true,
        thumbnail_available: true,
      },
    ],
    total: 42,
    next_offset: 30,
  });
  assert.doesNotMatch(JSON.stringify(result), /private-account|private-token|private-signature|https?:\/\//);
});

test('image selections retain exact output indices without exposing media URLs or storage keys', async () => {
  const studio = gateway((url, body) => {
    assert.equal(url.pathname, '/v2/studio/image/image_assets');
    assert.deepEqual(body, { page_num: 1, page_size: 20 });
    return { assets: [image()] };
  });
  const result = await listAssets(studio, { kind: 'image' });
  assert.deepEqual(result, {
    assets: [
      {
        asset_id: 'website-image-0',
        status: 'success',
        type: 'generate_image',
        create_time: 0,
        input: { model_version: 'gpt_image_1.5', prompt: 'Blue robot reference' },
        output_count: 2,
        outputs: [
          { index: 0, url_available: true, deletion_key_available: true },
          { index: 1, url_available: true, deletion_key_available: true },
        ],
      },
    ],
    next_offset: null,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-account|private-token|private-signature|private-bucket|https?:\/\//,
  );
});

test('missing optional metadata remains unknown and text fields cannot carry nested secrets or signed links', () => {
  const summary = modelAssetSummary({
    id: 'minimal',
    project_name: { account_id: 'private-account' },
    visibility: ['private'],
  });
  assert.equal(summary.name, undefined);
  assert.equal(summary.visibility, undefined);
  assert.equal(summary.is_owner, null);
  assert.equal(summary.collected, null);
  assert.equal(summary.running, null);
  assert.equal(summary.thumbnail_available, false);
  const result = imageAssetSummary({
    asset_id: 'minimal',
    input: {
      prompt:
        'Visit https://cdn.tripo3d.ai/private-account/file?signature=private-signature token=private-token',
      account_id: 'private-account',
    },
  });
  assert.equal(result.output_count, 0);
  assert.deepEqual(result.outputs, []);
  assert.doesNotMatch(JSON.stringify(result), /private-account|private-token|private-signature|https?:\/\//);
  assert.throws(() => imageAssetSummary({ asset_id: 'bad', output: { data: Array(17).fill({}) } }), {
    code: 'CONTRACT_CHANGED',
  });
  assert.throws(() => modelAssetSummary({ id: { account_id: 'private-account' } }), {
    code: 'CONTRACT_CHANGED',
  });
});

test('assets list and the structured tool return identical account images across page boundaries', async () => {
  const all = Array.from({ length: 5 }, (_, index) => image(index));
  const pages: number[] = [];
  const studio = gateway((url, body) => {
    assert.equal(url.pathname, '/v2/studio/image/image_assets');
    const page = Number(body.page_num),
      size = Number(body.page_size);
    pages.push(page);
    return { assets: all.slice((page - 1) * size, page * size) };
  });
  let emitted: unknown,
    opened = 0;
  const program = new Command().exitOverride();
  registerAssets(program, {
    emit: (value) => {
      emitted = value;
    },
    usingApp: async (run) => {
      opened++;
      return await run({ studio } as Application);
    },
  });
  await program.parseAsync(['assets', 'list', '--kind', 'image', '--offset', '1', '--limit', '2'], {
    from: 'user',
  });
  const definitions = toolRegistry(() => {
    throw new Error('Asset reads must not access task history.');
  }, studio);
  const tool = await callTool(definitions, 'ai_modeling_assets_list', { kind: 'image', offset: 1, limit: 2 });
  assert.equal(tool.isError, undefined);
  assert.deepEqual(emitted, tool.structuredContent.result);
  assert.deepEqual(pages, [1, 2, 1, 2]);
  assert.equal(opened, 1);
});

test('CLI asset flags are validated before account services can open', async () => {
  for (const flags of [
    ['--kind', 'video'],
    ['--offset', '-1'],
    ['--offset', '1000001'],
    ['--limit', '0'],
    ['--limit', '101'],
    ['--limit', 'NaN'],
    ['--offset', '1.5'],
  ]) {
    const program = new Command().exitOverride();
    let opened = false;
    registerAssets(program, {
      emit: () => assert.fail('Invalid input must not produce a result.'),
      usingApp: async () => {
        opened = true;
        throw new Error('Must not open an account.');
      },
    });
    await assert.rejects(program.parseAsync(['assets', 'list', ...flags], { from: 'user' }), {
      name: 'ZodError',
    });
    assert.equal(opened, false);
  }
  assert.deepEqual(assetsListSchema.parse({}), { kind: 'model', offset: 0, limit: 20 });
});

test('asset help exposes selection and pagination without credentials or runtime state', async () => {
  let output = '';
  const program = new Command().exitOverride().configureOutput({
    writeOut: (text) => {
      output += text;
    },
  });
  registerAssets(program, {
    emit: () => assert.fail('Help must not emit assets.'),
    usingApp: async () => {
      throw new Error('Help must not open an account.');
    },
  });
  await assert.rejects(program.parseAsync(['assets', 'list', '--help'], { from: 'user' }), {
    code: 'commander.helpDisplayed',
  });
  assert.match(output, /--kind/);
  assert.match(output, /--offset/);
  assert.match(output, /--limit/);
  assert.match(output, /image-get/);
});
