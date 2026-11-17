/** Brand configuration tests use temporary state and a synthetic credential backend only. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { environmentValue } from '../cli/core/environment.ts';
import { configFromEnv } from '../cli/core/config.ts';
import { contextFile, contextFlags, defaultOutputRoot, writeSettings } from '../cli/compat/settings.ts';
import { outputDirectory } from '../cli/compat/output-directory.ts';
import { loginDaemonEnvironment } from '../cli/auth/daemon.ts';

const exec = promisify(execFile);
const entrypoint = fileURLToPath(new URL('../cli/main.ts', import.meta.url));

async function temporary(t: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-modeling-branding-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function inDirectory<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

test('application variables have one namespace and do not fall back to previous product variables', async (t) => {
  const directory = await temporary(t);
  for (const name of [
    'PROFILE',
    'DATA_DIR',
    'OUTPUT_DIR',
    'INPUT_ROOTS',
    'BROWSER_EXECUTABLE',
    'BROWSER_CDP_ENDPOINT',
    'BLENDER',
    'FFMPEG',
    'EXPERIMENTAL_MESH_EDIT',
  ]) {
    assert.equal(environmentValue(name, { [`TRIPO_${name}`]: 'old-value' }), undefined);
    assert.equal(
      environmentValue(name, { [`TRIPO_${name}`]: 'old-value', [`AI_MODELING_${name}`]: 'new-value' }),
      'new-value',
    );
    assert.equal(environmentValue(name, { [`TRIPO_${name}`]: 'old-value', [`AI_MODELING_${name}`]: '' }), '');
  }
  const inputs = [path.join(directory, 'images'), path.join(directory, 'models')];
  const config = configFromEnv({
    AI_MODELING_DATA_DIR: path.join(directory, 'new-data'),
    AI_MODELING_PROFILE: 'new-profile',
    AI_MODELING_OUTPUT_DIR: path.join(directory, 'output'),
    AI_MODELING_INPUT_ROOTS: inputs.join(path.delimiter),
    TRIPO_DATA_DIR: path.join(directory, 'old-data'),
    TRIPO_PROFILE: 'old-profile',
    TRIPO_OUTPUT_DIR: path.join(directory, 'old-output'),
  });
  assert.deepEqual(config, {
    dataDir: path.join(directory, 'new-data'),
    outputDir: path.join(directory, 'output'),
    inputRoots: inputs,
    keyringAccount: 'new-profile',
  });
  assert.deepEqual(await readdir(directory), []);
});

test('default state uses ai-modeling for each platform without probing or migrating old state', async (t) => {
  const directory = await temporary(t);
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const base = path.join(directory, platform);
    const home = path.join(base, 'user');
    const dataBase =
      platform === 'darwin'
        ? path.join(home, 'Library/Application Support')
        : path.join(home, '.local/share');
    const old = path.join(dataBase, 'tripo3d-mcp');
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, 'settings.json'), 'invalid-old-settings');
    await writeFile(path.join(old, 'jobs.sqlite'), 'synthetic-old-db-marker');
    const location = { home, platform };
    const config = configFromEnv({ TRIPO_DATA_DIR: old, TRIPO_PROFILE: 'old' }, location);
    assert.equal(config.dataDir, path.join(dataBase, 'ai-modeling'));
    assert.equal(config.keyringAccount, 'default');
    assert.deepEqual(await readdir(dataBase), ['tripo3d-mcp']);
    assert.equal(await readFile(path.join(old, 'jobs.sqlite'), 'utf8'), 'synthetic-old-db-marker');
    await mkdir(config.dataDir);
    await writeFile(
      path.join(config.dataDir, 'settings.json'),
      JSON.stringify({ active_profile: 'new-settings' }),
    );
    assert.equal(configFromEnv({}, location).keyringAccount, 'new-settings');
    assert.equal(configFromEnv({ AI_MODELING_PROFILE: 'explicit' }, location).keyringAccount, 'explicit');
    if (platform !== 'darwin')
      assert.equal(
        configFromEnv({ XDG_DATA_HOME: path.join(base, 'xdg') }, location).dataDir,
        path.join(base, 'xdg/ai-modeling'),
      );
  }
});

test('contexts use the nearest ai-modeling directory and ignore old context files entirely', async (t) => {
  const directory = await temporary(t);
  const nested = path.join(directory, 'project/nested');
  await mkdir(nested, { recursive: true });
  const old = path.join(nested, '.tripo/context.json');
  await writeSettings({ model: 'old-model', output_dir: './old-output' }, old);
  assert.equal(contextFile(nested), undefined);
  const outer = path.join(directory, 'project/.ai-modeling/context.json');
  await writeSettings({ model: 'outer-model', output_dir: './outer-output' }, outer);
  assert.equal(contextFile(nested), outer);
  await inDirectory(nested, async () => {
    assert.equal(contextFlags().model, 'outer-model');
    assert.equal(defaultOutputRoot(), path.join(directory, 'project/outer-output'));
  });
  const inner = path.join(nested, '.ai-modeling/context.json');
  await writeSettings({ model: 'inner-model', output_dir: './assets' }, inner);
  assert.equal(contextFile(nested), inner);
  await inDirectory(nested, async () => {
    assert.equal(contextFlags().model, 'inner-model');
    const fresh = outputDirectory({ job_id: '12345678-rest', name: 'robot' }, {});
    assert.equal(fresh, path.join(nested, 'assets/ai-modeling-out/robot-12345678'));
    const saved = path.join(directory, 'previous-delivery/model.glb');
    assert.equal(outputDirectory({ artifacts: [{ local_path: saved }] }, {}), path.dirname(saved));
    assert.equal(outputDirectory({}, { out: './chosen' }), path.join(nested, 'chosen'));
  });
  assert.equal(JSON.parse(await readFile(old, 'utf8')).model, 'old-model');
});

test('config context writes only the new namespace and explicit profile wins over environment', async (t) => {
  const directory = await temporary(t);
  const old = path.join(directory, '.tripo/context.json');
  await writeSettings({ model: 'old-model' }, old);
  const env = {
    ...process.env,
    AI_MODELING_DATA_DIR: path.join(directory, 'data'),
    AI_MODELING_PROFILE: 'environment-profile',
    TRIPO_PROFILE: 'old-profile',
  };
  const first = await exec(process.execPath, [entrypoint, 'config', 'context', 'model=tripo-p2', '--json'], {
    cwd: directory,
    env,
    timeout: 30000,
  });
  const file = path.join(directory, '.ai-modeling/context.json');
  assert.equal(JSON.parse(first.stdout).file, file);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).model, 'tripo-p2');
  assert.equal(JSON.parse(await readFile(old, 'utf8')).model, 'old-model');
  const second = await exec(
    process.execPath,
    [entrypoint, '--profile', 'command-profile', 'config', 'list', '--json'],
    { cwd: directory, env, timeout: 30000 },
  );
  assert.equal(JSON.parse(second.stdout).active_profile, 'command-profile');
});

test('login child environment preserves new configuration and strips only debug logging controls', async (t) => {
  const directory = await temporary(t);
  const original = {
    ...process.env,
    AI_MODELING_DATA_DIR: path.join(directory, 'state'),
    AI_MODELING_PROFILE: 'child-profile',
    AI_MODELING_BROWSER_EXECUTABLE: path.join(directory, 'browser'),
    AI_MODELING_BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222',
    AI_MODELING_BLENDER: path.join(directory, 'blender'),
    AI_MODELING_FFMPEG: path.join(directory, 'ffmpeg'),
    DEBUG: 'pw:protocol',
    DEBUG_FILE: path.join(directory, 'forbidden.log'),
    PWDEBUG: '1',
    PLAYWRIGHT_DEBUG_LOG: '1',
    PW_PROTOCOL_LOG: '1',
  };
  const forwarded = loginDaemonEnvironment(original);
  for (const name of [
    'DATA_DIR',
    'PROFILE',
    'BROWSER_EXECUTABLE',
    'BROWSER_CDP_ENDPOINT',
    'BLENDER',
    'FFMPEG',
  ])
    assert.equal(forwarded[`AI_MODELING_${name}`], original[`AI_MODELING_${name}` as keyof typeof original]);
  for (const name of ['DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'PLAYWRIGHT_DEBUG_LOG', 'PW_PROTOCOL_LOG'])
    assert.equal(forwarded[name], undefined);
  assert.equal(original.DEBUG, 'pw:protocol');
  const configUrl = new URL('../cli/core/config.ts', import.meta.url).href;
  const result = await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {configFromEnv} from ${JSON.stringify(configUrl)}; console.log(JSON.stringify(configFromEnv()));`,
    ],
    { env: forwarded, cwd: directory },
  );
  assert.equal(JSON.parse(result.stdout).keyringAccount, 'child-profile');
  assert.equal(JSON.parse(result.stdout).dataDir, path.join(directory, 'state'));
  assert.deepEqual(await readdir(directory), []);
});

test('credential services and auth locks use the new namespace without reading or migrating old entries', async (t) => {
  const directory = await temporary(t);
  const isolatedHome = path.join(directory, 'synthetic-user');
  await mkdir(path.join(isolatedHome, '.tripo3d-mcp-auth'), { recursive: true });
  await writeFile(path.join(isolatedHome, '.tripo3d-mcp-auth/keep'), 'old-control-marker');
  const urls = Object.fromEntries(
    [
      ['credentials', '../studio/auth/credentials.ts'],
      ['links', '../studio/auth/artifact-links.ts'],
      ['uploads', '../studio/auth/uploads.ts'],
      ['ai', '../cli/compat/ai.ts'],
      ['control', '../studio/auth/control-directory.ts'],
      ['state', '../cli/auth/state.ts'],
    ].map(([name, file]) => [name!, new URL(file!, import.meta.url).href]),
  );
  const keyring = `export class Entry {
    constructor(service, account) { this.key=JSON.stringify([service,account]); globalThis.entryServices.push(service); }
    getPassword() { return globalThis.entryValues.get(this.key) ?? null; }
    setPassword(value) { globalThis.entryValues.set(this.key,value); }
    deleteCredential() { globalThis.entryValues.delete(this.key); }
  }`;
  const fakeOs = `export function userInfo(){ return {homedir:${JSON.stringify(isolatedHome)}}; }`;
  const script = `import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
globalThis.entryValues = new Map(); globalThis.entryServices = [];
registerHooks({resolve(specifier,context,next){
 if(specifier==='@napi-rs/keyring') return {url:'data:text/javascript,'+encodeURIComponent(${JSON.stringify(keyring)}),shortCircuit:true};
 if(specifier==='node:os' && context.parentURL===${JSON.stringify(urls.control)}) return {url:'data:text/javascript,'+encodeURIComponent(${JSON.stringify(fakeOs)}),shortCircuit:true};
 return next(specifier,context);
}});
const {KeyringStore}=await import(${JSON.stringify(urls.credentials)});
const {KeyringLinks}=await import(${JSON.stringify(urls.links)});
const {saveUpload,loadUpload}=await import(${JSON.stringify(urls.uploads)});
const {llmSecret}=await import(${JSON.stringify(urls.ai)});
const {privateAuthDirectory}=await import(${JSON.stringify(urls.control)});
const {loginStateFile}=await import(${JSON.stringify(urls.state)});
const oldEntries=[['tripo3d-mcp','profile'],['tripo3d-mcp.artifacts','profile:job'],['tripo3d-mcp-llm','default']];
for(const key of oldEntries) entryValues.set(JSON.stringify(key),'synthetic-old-value');
const store=new KeyringStore('profile'); assert.equal(store.load(),undefined);
const next={deviceId:'synthetic-device',importedAt:'2026-01-01T00:00:00Z'};
assert.equal(store.saveIfUnchanged(undefined,next),true); assert.deepEqual(store.load(),next);
store.clear(); assert.equal(store.load(),undefined);
const links=new KeyringLinks('profile'); assert.equal(links.get('job'),undefined);
links.set('job','https://example.invalid/synthetic'); assert.equal(links.get('job'),'https://example.invalid/synthetic');
const oldToken='studio_file_image_11111111-1111-4111-8111-111111111111';
entryValues.set(JSON.stringify(['tripo3d-mcp-upload',oldToken]),'synthetic-old-upload');
assert.throws(()=>loadUpload(oldToken),{code:'INPUT_NOT_FOUND'});
const value={account:'synthetic',path:'synthetic',sha256:'synthetic',format:'png',reference:{bucket:'synthetic',key:'synthetic'}};
const token=saveUpload(value,'image'); assert.deepEqual(loadUpload(token,'synthetic'),value);
assert.equal(llmSecret().getPassword(),null); llmSecret().setPassword('synthetic-llm');
for(const key of oldEntries) assert.equal(entryValues.get(JSON.stringify(key)),'synthetic-old-value');
const first=await loginStateFile({dataDir:'data-a',keyringAccount:'profile',inputRoots:[],outputDir:''});
const second=await loginStateFile({dataDir:'data-b',keyringAccount:'profile',inputRoots:[],outputDir:''});
assert.equal(first,second);
assert.notEqual(first,await loginStateFile({dataDir:'data-a',keyringAccount:'other',inputRoots:[],outputDir:''}));
console.log(JSON.stringify({services:[...new Set(entryServices)].sort(),root:privateAuthDirectory(),state:first}));`;
  const result = await exec(process.execPath, ['--input-type=module', '-e', script], {
    cwd: directory,
    timeout: 30000,
  });
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(
    actual.services,
    ['ai-modeling', 'ai-modeling-llm', 'ai-modeling-upload', 'ai-modeling.artifacts'].sort(),
  );
  assert.equal(actual.root, path.join(isolatedHome, '.ai-modeling-auth'));
  assert.equal(path.dirname(actual.state), path.join(actual.root, 'login-sessions'));
  assert.equal(
    await readFile(path.join(isolatedHome, '.tripo3d-mcp-auth/keep'), 'utf8'),
    'old-control-marker',
  );
  assert.deepEqual((await readdir(isolatedHome)).sort(), ['.ai-modeling-auth', '.tripo3d-mcp-auth']);
});
