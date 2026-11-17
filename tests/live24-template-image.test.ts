/** 模板预览与模型详情的资源角色不同；核精确身份和原图字节，防止回退缩略图。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { existingArtifact, existingArtifactSchema } from '../studio/api/existing-artifact.ts';
import { downloadExistingArtifact } from '../cli/artifacts/library-download.ts';
import { object } from '../studio/contracts/errors.ts';

const original = 'https://tripo-data.rg1.data.tripo3d.com/template/original.png';
function fixture() {
  const graph: Record<string, unknown> = {
    summary: { id: 'template' },
    nodes: [
      { id: 'upload', inputMount: [{ assetId: 'input', url: original, filename: 'original.png' }] },
      {
        id: 'generated',
        nodeAssets: [
          { assetId: 'old', url: original, thumbnailUrl: original.replace('original', 'thumb') },
          { assetId: 'new', selected: true, url: original.replace('original', 'new') },
        ],
      },
    ],
  };
  const methods: string[] = [];
  const bearer =
    'eyJhbGciOiJIUzI1NiJ9.' +
    Buffer.from(JSON.stringify({ sub: 'test-account', exp: Date.now() / 1000 + 3600 })).toString(
      'base64url',
    ) +
    '.fixture';
  const client = new StudioClient(
    new MemoryCredentials({
      accountRef: 'test-account',
      bearer,
      deviceId: 'device',
      importedAt: new Date().toISOString(),
    }),
    async (url, init) => {
      assert.equal(url, 'https://msapi.tripo3d.ai/ms/web/api');
      const method = String(object(init.headers)['x-micro-method']);
      assert.equal(method, '/tripo.canvas.api.agent.TemplateService/GetTemplate');
      methods.push(method);
      assert.deepEqual(JSON.parse(String(init.body)), { id: 'template' });
      return Response.json({ error: { code: 0 }, template: graph });
    },
  );
  return { graph, methods, client };
}
const input = (node = 'generated', asset = 'old', destination = '/tmp/template-image.png') =>
  existingArtifactSchema.parse({
    kind: 'template_image',
    template_id: 'template',
    node_id: node,
    id: asset,
    destination_path: destination,
  });

test('template image needs its template, node and exact asset without unrelated contexts', () => {
  const good = input();
  for (const bad of [
    { ...good, template_id: undefined },
    { ...good, node_id: undefined },
    { ...good, canvas_id: 'canvas' },
    { ...good, operator_id: 'operator' },
    { ...good, output_index: 1 },
    { ...good, kind: 'template_model' },
  ])
    assert.equal(existingArtifactSchema.safeParse(bad).success, false);
});

test('input and generated template images read exact graph URLs without model detail or selected fallback', async () => {
  const f = fixture();
  for (const [node, asset] of [
    ['upload', 'input'],
    ['generated', 'old'],
  ]) {
    const result = await existingArtifact(f.client, input(node, asset));
    assert.deepEqual(result, {
      url: original,
      format: 'image',
      source_id: asset,
      template_id: 'template',
      node_id: node,
    });
  }
  assert.equal(f.methods.length, 2);
  await assert.rejects(existingArtifact(f.client, input('upload', 'old')), { code: 'ARTIFACT_NOT_FOUND' });
});

test('template image rejects wrong graph, missing or ambiguous identities, model assets and thumbnail-only records', async () => {
  for (const [mutate, code] of [
    [
      (g: Record<string, unknown>) => {
        g.summary = { id: 'another' };
      },
      'CONTRACT_CHANGED',
    ],
    [
      (g: Record<string, unknown>) => {
        g.nodes = [];
      },
      'ARTIFACT_NOT_FOUND',
    ],
    [
      (g: Record<string, unknown>) => {
        g.nodes = [{ id: 'generated' }, { id: 'generated' }];
      },
      'CONTRACT_CHANGED',
    ],
    [
      (g: Record<string, unknown>) => {
        g.nodes = [
          {
            id: 'generated',
            inputMount: [{ assetId: 'old', url: original }],
            nodeAssets: [{ assetId: 'old', url: original }],
          },
        ];
      },
      'CONTRACT_CHANGED',
    ],
    [
      (g: Record<string, unknown>) => {
        g.nodes = [{ id: 'generated', nodeAssets: [{ assetId: 'old', thumbnailUrl: original }] }];
      },
      'ARTIFACT_NOT_READY',
    ],
    [
      (g: Record<string, unknown>) => {
        g.nodes = [
          { id: 'generated', nodeAssets: [{ assetId: 'old', url: original.replace('.png', '.glb') }] },
        ];
      },
      'ARTIFACT_FORMAT_UNCONFIRMED',
    ],
    [
      (g: Record<string, unknown>) => {
        g.nodes = [
          { id: 'generated', nodeAssets: [{ assetId: 'old', url: original, kind: 'ASSET_KIND_MODEL' }] },
        ];
      },
      'ARTIFACT_FORMAT_UNCONFIRMED',
    ],
  ] as const) {
    const f = fixture();
    mutate(f.graph);
    await assert.rejects(existingArtifact(f.client, input()), { code });
  }
});

test('template image downloads original bytes to caller path and returns source context without remote URL', async () => {
  const f = fixture(),
    directory = await mkdtemp(path.join(os.tmpdir(), 'tripo-template-image-'));
  const bytes = await sharp({
    create: { width: 3, height: 2, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
  try {
    const destination = path.join(directory, 'image.png');
    const result = await downloadExistingArtifact(
      f.client,
      directory,
      input('generated', 'old', destination),
      async (url, init) => {
        assert.equal(String(url), original);
        assert.equal(new Headers(init.headers).has('authorization'), false);
        return new Response(bytes, { headers: { 'content-type': 'image/png' } });
      },
    );
    assert.deepEqual(await readFile(destination), bytes);
    assert.equal(result.template_id, 'template');
    assert.equal(result.node_id, 'generated');
    assert.equal(result.source_id, 'old');
    assert.equal(JSON.stringify(result).includes('https://'), false);
    await assert.rejects(
      downloadExistingArtifact(f.client, directory, input('generated', 'old', destination)),
      { code: 'OUTPUT_EXISTS' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
