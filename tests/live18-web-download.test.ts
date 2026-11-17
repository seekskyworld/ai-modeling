/** 网页已有素材下载：独立远端身份、原 URL 与缩略图区分、传输校验和最终发布边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { existingArtifact, existingArtifactSchema } from '../studio/api/existing-artifact.ts';
import { canvasArtifactContent } from '../studio/api/canvas-artifact.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';
import { downloadedContent } from '../cli/artifacts/content-validation.ts';
import { downloadExistingArtifact } from '../cli/artifacts/library-download.ts';
import { download } from '../cli/artifacts/download.ts';
import { tinyGlb } from './helpers.ts';

function clientWith(handler: (method: string, body: Record<string, unknown>) => unknown) {
  const bearer =
    'eyJhbGciOiJIUzI1NiJ9.' +
    Buffer.from(
      JSON.stringify({
        sub: 'test-account',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url') +
    '.fixture';
  return new StudioClient(
    new MemoryCredentials({
      accountRef: 'test-account',
      bearer,
      deviceId: 'device',
      importedAt: new Date().toISOString(),
    }),
    async (url, init) => {
      assert.equal(url, 'https://msapi.tripo3d.ai/ms/web/api');
      const headers = object(init.headers);
      assert.equal(headers['x-uid'], 'test-account');
      return Response.json({
        error: { code: 0 },
        ...object(handler(String(headers['x-micro-method']), object(JSON.parse(String(init.body))))),
      });
    },
  );
}
const destination = '/tmp/caller-selected.glb';
const parse = (input: Record<string, unknown>) =>
  existingArtifactSchema.parse({ destination_path: destination, ...input });

test('new download sources require their exact context and reject unrelated identifiers', () => {
  for (const value of [
    { kind: 'canvas_node', id: 'a' },
    { kind: 'canvas_input', id: 'a', node_id: 'n' },
    { kind: 'lab_input', id: 'a' },
    { kind: 'lab_artifact', id: 'a', node_id: 'n' },
    { kind: 'canvas_node', id: 'a', node_id: 'n', job_id: 'job' },
    { kind: 'lab_artifact', id: 'a', job_id: 'job', operator_id: 'operator' },
  ])
    assert.throws(() => parse(value));
  assert.equal(parse({ kind: 'lab_artifact', id: 'a', job_id: 'job' }).output_index, 0);
});

test('Canvas node download selects the exact historical asset, never a selected replacement or thumbnail', async () => {
  const requests: string[] = [];
  const client = clientWith((method, body) => {
    requests.push(method);
    assert.deepEqual(body, { nodeIds: ['node'] });
    return {
      nodes: [
        {
          nodeId: 'node',
          assets: [
            { nodeId: 'node', assetId: 'new', selected: true, url: 'https://cdn.tripo3d.ai/new.png' },
            {
              nodeId: 'node',
              assetId: 'old',
              role: 'ASSET_ROLE_SUPERSEDED',
              kind: 'ASSET_KIND_IMAGE',
              url: 'https://cdn.tripo3d.ai/old.png',
              thumbnailUrl: 'https://cdn.tripo3d.ai/thumb.png',
            },
          ],
        },
      ],
    };
  });
  const result = await existingArtifact(client, parse({ kind: 'canvas_node', id: 'old', node_id: 'node' }));
  assert.equal(result.url, 'https://cdn.tripo3d.ai/old.png');
  assert.deepEqual(requests, ['/tripo.canvas.api.agent.NodeService/ListNodesAssets']);
  await assert.rejects(
    existingArtifact(client, parse({ kind: 'canvas_node', id: 'missing', node_id: 'node' })),
    { code: 'ARTIFACT_NOT_FOUND' },
  );
});

test('Canvas input reads the saved mount then validates readiness without treating metadata thumbnail as original', async () => {
  let url: string | undefined = 'https://cdn.tripo3d.ai/model.glb';
  let status = 'INPUT_ASSET_STATUS_READY';
  const calls: string[] = [];
  const client = clientWith((method, body) => {
    calls.push(method);
    if (method.endsWith('/GetCanvas')) {
      assert.deepEqual(body, { canvasId: 'canvas' });
      return {
        canvas: { canvasId: 'canvas', projectId: 'project' },
        nodes: [
          { id: 'node', inputMount: [{ assetId: 'asset', filename: 'model.glb', ...(url ? { url } : {}) }] },
        ],
      };
    }
    assert.deepEqual(body, { projectId: 'project', assetIds: ['asset'] });
    return {
      assets: [
        {
          assetId: 'asset',
          kind: 'ASSET_KIND_MODEL',
          status,
          filename: 'model.glb',
          sizeBytes: '1600',
          thumbnailUrl: 'https://cdn.tripo3d.ai/thumb.png',
        },
      ],
    };
  });
  const input = parse({ kind: 'canvas_input', id: 'asset', canvas_id: 'canvas', node_id: 'node' });
  const source = await existingArtifact(client, input);
  assert.equal(source.url, url);
  assert.equal(source.project_id, 'project');
  assert.equal(source.input_metadata_scope, 'current_project');
  assert.deepEqual(source.content_hint, { byte_size: 1600 });
  assert.deepEqual(
    calls.map((value) => value.split('/').at(-1)),
    ['GetCanvas', 'BatchGetInputAssets'],
  );
  status = 'INPUT_ASSET_STATUS_PROCESSING';
  await assert.rejects(existingArtifact(client, input), { code: 'ARTIFACT_NOT_READY' });
  status = 'INPUT_ASSET_STATUS_READY';
  url = undefined;
  await assert.rejects(existingArtifact(client, input), { code: 'ARTIFACT_NOT_READY' });
});

test('cross-Canvas pasted input downloads its authenticated mount URL even when current-project metadata has no asset', async () => {
  const calls: string[] = [];
  const client = clientWith((method, body) => {
    calls.push(method.split('/').at(-1)!);
    if (method.endsWith('/GetCanvas'))
      return {
        canvas: { canvasId: 'target-canvas', projectId: 'target-project' },
        nodes: [
          {
            id: 'copy',
            type: 'NODE_TYPE_UPLOAD_CARD',
            inputMount: [
              {
                assetId: 'original-asset',
                filename: 'original.png',
                url: 'https://cdn.tripo3d.ai/original.png',
              },
            ],
          },
        ],
      };
    assert.deepEqual(body, { projectId: 'target-project', assetIds: ['original-asset'] });
    return { assets: [] };
  });
  const source = await existingArtifact(
    client,
    parse({ kind: 'canvas_input', id: 'original-asset', canvas_id: 'target-canvas', node_id: 'copy' }),
  );
  assert.equal(source.url, 'https://cdn.tripo3d.ai/original.png');
  assert.equal(source.source_id, 'original-asset');
  assert.equal(source.input_metadata_scope, 'not_in_current_project');
  assert.equal(source.content_hint, undefined);
  assert.deepEqual(calls, ['GetCanvas', 'BatchGetInputAssets']);
});

test('Canvas asset duplicate, node and graph identity mismatches fail closed', async () => {
  for (const response of [
    {
      nodes: [
        { nodeId: 'node', assets: [{ assetId: 'a', nodeId: 'other', url: 'https://cdn.tripo3d.ai/a.png' }] },
      ],
    },
    { nodes: [{ nodeId: 'node', assets: [{ assetId: 'a' }, { assetId: 'a' }] }] },
  ]) {
    const client = clientWith(() => response);
    await assert.rejects(existingArtifact(client, parse({ kind: 'canvas_node', id: 'a', node_id: 'node' })), {
      code: 'CONTRACT_CHANGED',
    });
  }
  const client = clientWith(() => ({ canvas: { canvasId: 'other', projectId: 'project' }, nodes: [] }));
  await assert.rejects(
    existingArtifact(client, parse({ kind: 'canvas_input', id: 'a', canvas_id: 'canvas', node_id: 'node' })),
    { code: 'CONTRACT_CHANGED' },
  );
});

test('Lab file download uses exact job/artifact identity including an available file from a failed job', async () => {
  let jobId = 'job';
  const client = clientWith((method, body) => {
    assert.ok(method.endsWith('/GetLabJob'));
    assert.deepEqual(body, { jobId: 'job' });
    return {
      jobId,
      status: 'failed',
      artifacts: [
        {
          artifactId: 'file',
          kind: 'file',
          title: 'report.json',
          downloadUrl: 'https://cdn.tripo3d.ai/report.json',
          byteSize: '17',
        },
      ],
    };
  });
  const input = parse({ kind: 'lab_artifact', id: 'file', job_id: 'job' });
  const source = await existingArtifact(client, input);
  assert.equal(source.format, 'json');
  assert.deepEqual(source.content_hint, { kind: 'file', byte_size: 17 });
  jobId = 'other';
  await assert.rejects(existingArtifact(client, input), { code: 'CONTRACT_CHANGED' });
});

test('Lab input representation uses previewUrl and byteSize and never substitutes thumbnailUrl', async () => {
  let previewUrl: string | undefined = 'https://cdn.tripo3d.ai/input.mp4';
  const client = clientWith(() => ({
    jobId: 'job',
    inputs: [
      {
        assetId: 'input',
        kind: 'video',
        filename: 'input.mp4',
        byteSize: '2325',
        previewUrl,
        thumbnailUrl: 'https://cdn.tripo3d.ai/thumbnail.png',
      },
    ],
  }));
  const input = parse({ kind: 'lab_input', id: 'input', job_id: 'job' });
  const source = await existingArtifact(client, input);
  assert.equal(source.url, previewUrl);
  assert.equal(source.representation, 'input_preview');
  assert.deepEqual(source.content_hint, { kind: 'video', byte_size: 2325 });
  previewUrl = undefined;
  await assert.rejects(existingArtifact(client, input), { code: 'ARTIFACT_NOT_READY' });
});

test('format resolution handles explicit video and code .ts separately and preserves original URL suffix', () => {
  assert.deepEqual(canvasArtifactContent('https://cdn.tripo3d.ai/x.ts', 'x.ts', 'file'), {
    format: 'ts',
    content_hint: { kind: 'file' },
  });
  assert.deepEqual(canvasArtifactContent('https://cdn.tripo3d.ai/x.ts', 'x.ts', 'video'), {
    format: 'ts',
    content_hint: { kind: 'video' },
  });
  assert.equal(
    canvasArtifactContent('https://cdn.tripo3d.ai/x.fbx?name=x.glb', 'x.glb', 'model').format,
    'fbx',
  );
  assert.equal(
    canvasArtifactContent('https://cdn.tripo3d.ai/download', 'report.json', 'file').format,
    'json',
  );
  assert.equal(canvasArtifactContent('https://cdn.tripo3d.ai/download', 'report', 'file').format, 'bin');
});

test('video download validation rejects truncation and reports container-only validation', () => {
  const atom = (name: string) => {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32BE(8);
    bytes.write(name, 4);
    return bytes;
  };
  const bytes = Buffer.concat([atom('moov'), atom('mdat')]);
  assert.deepEqual(downloadedContent(bytes, 'mp4', { kind: 'video', byte_size: 16 }), {
    format: 'mp4',
    content_validation: 'video_container',
  });
  assert.throws(() => downloadedContent(bytes.subarray(0, 15), 'mp4', { kind: 'video' }), {
    code: 'INVALID_ARTIFACT',
  });
  assert.throws(() => downloadedContent(bytes, 'mp4', { kind: 'video', byte_size: 17 }), {
    code: 'INVALID_ARTIFACT',
  });
  assert.throws(() => downloadedContent(Buffer.from('<html>error</html>'), 'png'), {
    code: 'INVALID_ARTIFACT',
  });
});

test('opaque Lab download checks bytes/hash/path and does not expose signed URL', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tripo-live18-file-'));
  const bytes = Buffer.from('{"observed":true}\n');
  const url = 'https://cdn.tripo3d.ai/report.json?secret=not-output';
  const client = clientWith(() => ({
    jobId: 'job',
    artifacts: [
      {
        artifactId: 'report',
        kind: 'file',
        title: 'report.json',
        downloadUrl: url,
        byteSize: String(bytes.length),
      },
    ],
  }));
  const input = {
    kind: 'lab_artifact',
    id: 'report',
    job_id: 'job',
    destination_path: path.join(root, 'report.json'),
  };
  try {
    const result = await downloadExistingArtifact(client, root, input, async (requested, init) => {
      assert.equal(requested, url);
      assert.equal(init.headers, undefined);
      return new Response(bytes);
    });
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(result.content_validation, 'opaque_file');
    assert.deepEqual(await readFile(input.destination_path), bytes);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    await assert.rejects(downloadExistingArtifact(client, root, input), { code: 'OUTPUT_EXISTS' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native content validator runs before final publication and failures leave no partial result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tripo-live18-validation-'));
  let called = false;
  try {
    await assert.rejects(
      download(
        'https://cdn.tripo3d.ai/a.glb',
        root,
        'a.glb',
        'glb',
        async () => new Response(new Uint8Array(tinyGlb())),
        false,
        {
          validateBytes: async (bytes, format) => {
            called = true;
            assert.equal(format, 'glb');
            assert.deepEqual(bytes, tinyGlb());
            assert.equal(
              (await readdir(root)).some((name) => name === 'a.glb'),
              false,
            );
            throw new TripoError('NATIVE_VALIDATION', 'Unverified native effect.');
          },
        },
      ),
      { code: 'NATIVE_VALIDATION' },
    );
    assert.equal(called, true);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
