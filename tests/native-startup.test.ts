/** First-use commands and MCP discovery must work without loading image or credential binaries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { object } from '../studio/contracts/errors.ts';
import { VERSION } from '../version.ts';

const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const hook = new URL('./native-unavailable-hook.ts', import.meta.url).href;
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-native-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  Object.assign(env, {
    AI_MODELING_DATA_DIR: path.join(directory, 'unused-data'),
    AI_MODELING_OUTPUT_DIR: directory,
    AI_MODELING_INPUT_ROOTS: directory,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${hook}`.trim(),
  });
  const run = (args: string[], expectedExit: number | number[] = 0) => {
    const result = spawnSync(process.execPath, [main, ...args], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ok(
      (Array.isArray(expectedExit) ? expectedExit : [expectedExit]).includes(result.status!),
      result.stdout + result.stderr,
    );
    assert.equal(result.error, undefined);
    assert.equal(result.stderr.includes('Synthetic native'), false);
    return result.stdout;
  };
  return { directory, env, run };
}

test('version, help, guides, tool discovery and offline setup do not load unavailable native dependencies', async (t) => {
  const f = await fixture(t);
  assert.equal(f.run(['--version']).trim(), VERSION);
  assert.match(f.run(['--help']), /ai-modeling/);
  assert.match(f.run(['mcp', '--help']), /toolset/);
  assert.match(f.run(['guides', 'list']), /ai-modeling:\/\/guides\/usage/);
  assert.equal(JSON.parse(f.run(['tools', '--toolset', 'default'])).length, 6);
  assert.equal(JSON.parse(f.run(['tools', '--toolset', 'studio'])).length, 176);
  const setup = JSON.parse(f.run(['setup', '--offline', '--check', '--json'], [0, 1]));
  assert.equal(setup.login_started, false);
  assert.equal(
    setup.checks.find((check: { name: string }) => check.name === 'credential_backend').status,
    'not_checked',
  );
  await assert.rejects(stat(f.env.AI_MODELING_DATA_DIR!), { code: 'ENOENT' });
});

test('first Skill installation and removal succeed while image and credential binaries are unavailable', async (t) => {
  const f = await fixture(t);
  const parent = path.join(f.directory, 'skills');
  assert.equal(JSON.parse(f.run(['skill', 'install', '--dir', parent, '--json'])).status, 'installed');
  assert.match(await readFile(path.join(parent, 'ai-modeling', 'SKILL.md'), 'utf8'), /ai-modeling/);
  assert.equal(JSON.parse(f.run(['skill', 'status', '--dir', parent, '--json'])).status, 'installed');
  assert.equal(JSON.parse(f.run(['skill', 'uninstall', '--dir', parent, '--json'])).status, 'uninstalled');
  await assert.rejects(stat(f.env.AI_MODELING_DATA_DIR!), { code: 'ENOENT' });
});

test('MCP starts and exposes default tools and guides through CLI with unavailable native dependencies', async (t) => {
  const f = await fixture(t);
  const client = new Client({ name: 'native-startup-test', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [main, 'mcp'],
        env: f.env,
        stderr: 'pipe',
      }),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 6);
    assert.ok(tools.tools.some((tool) => tool.name === 'ai_modeling_image_generate'));
    const guides = await client.listResources();
    assert.ok(guides.resources.some((resource) => resource.uri === 'ai-modeling://guides/usage'));
    const usage = await client.readResource({ uri: 'ai-modeling://guides/usage' });
    assert.match(String(object(usage.contents[0]).text), /ai-modeling/);
    await assert.rejects(stat(f.env.AI_MODELING_DATA_DIR!), { code: 'ENOENT' });
  } finally {
    await client.close();
  }
});

test('an actual image operation returns a structured runtime repair error without producing an output', async (t) => {
  const f = await fixture(t);
  const image = path.join(f.directory, 'pixel.png');
  const output = path.join(f.directory, 'cropped.png');
  await writeFile(image, pixel);
  const result = JSON.parse(
    f.run(
      [
        'studio',
        'image-crop',
        '--image-path',
        image,
        '--destination-path',
        output,
        '--left',
        '0',
        '--top',
        '0',
        '--width',
        '1',
        '--height',
        '1',
        '--json',
      ],
      2,
    ),
  );
  assert.equal(result.code, 'IMAGE_RUNTIME_UNAVAILABLE');
  assert.match(result.error, /Reinstall @seekskyworld\/ai-modeling with optional dependencies/);
  assert.equal(JSON.stringify(result).includes('private diagnostic'), false);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('image validation keeps runtime failures distinct from corrupt remote artifacts', async (t) => {
  const f = await fixture(t);
  const modules = {
    encoding: new URL('../cli/artifacts/image-encoding.ts', import.meta.url).href,
    background: new URL('../cli/artifacts/image-background-output.ts', import.meta.url).href,
    size: new URL('../cli/artifacts/image-size-output.ts', import.meta.url).href,
    fbx: new URL('../cli/artifacts/studio-fbx-texture.ts', import.meta.url).href,
  };
  const code = `import assert from 'node:assert/strict';
    const {encodeImageOutput}=await import(${JSON.stringify(modules.encoding)});
    const {assertOpaqueImageBytes}=await import(${JSON.stringify(modules.background)});
    const {assertImageSizeBytes}=await import(${JSON.stringify(modules.size)});
    const {verifyFbxTextureDecoding}=await import(${JSON.stringify(modules.fbx)});
    const bytes=Buffer.from(${JSON.stringify(pixel.toString('base64'))},'base64');
    const checks=[()=>encodeImageOutput(bytes,'png'),()=>assertOpaqueImageBytes(bytes),
      ()=>assertImageSizeBytes(bytes,{width:1,height:1}),
      ()=>verifyFbxTextureDecoding([{texture:{bytes,sha256:'synthetic',mime_type:'image/png'}}])];
    for(const check of checks) await assert.rejects(check,{code:'IMAGE_RUNTIME_UNAVAILABLE'});
    console.log(JSON.stringify({validated:checks.length}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: f.env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { validated: 4 });
});
