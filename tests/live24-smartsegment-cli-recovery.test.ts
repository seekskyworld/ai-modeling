/** 真CLI子进程与临时库验证外层预检；只在测试loader注入应用，生产没有认证旁路。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { executePlan } from '../cli/compat/runtime.ts';
import { scaleFixture, scaleMatrix } from './helpers-smartsegment-scale.ts';
import { scaleIntentKey, scaleSourceKey } from '../cli/core/smartsegment-scale-policy.ts';
import { object } from '../studio/contracts/errors.ts';

test('CLI restores the exact completed intent after original input removal without touching upstream', async () => {
  const f = await scaleFixture();
  try {
    const original = await executePlan(f.app, f.plan(), f.flags);
    await rm(f.input);
    const hook = path.join(f.dir, 'offline-application.mjs');
    const application = pathToFileURL(path.resolve('cli/core/application.ts')).href;
    const helpers = pathToFileURL(path.resolve('tests/helpers.ts')).href;
    const source = `import {fixture} from ${JSON.stringify(helpers)};
      export async function createApplication(){
        const f=await fixture(${JSON.stringify(f.dir)});
        const denied=()=>{throw Error('Unexpected upstream or credentials in CLI recovery test');};
        f.gateway.submit=f.gateway.status=f.gateway.account=f.gateway.artifactUrl=denied;
        f.service.pricing.quote=denied;
        const client={request:denied,forAccount(){return this;}};
        return {service:f.service,studio:{client},close:()=>f.jobs.close()};
      }`;
    await writeFile(
      hook,
      `import {registerHooks} from 'node:module';
      registerHooks({load(url,context,next){
        if(url===${JSON.stringify(application)})return {format:'module',shortCircuit:true,source:${JSON.stringify(source)}};
        return next(url,context);
      }});`,
    );
    async function run(request: string, matrix = scaleMatrix) {
      const child = spawn(
        process.execPath,
        [
          '--import',
          hook,
          'cli/main.ts',
          'mesh',
          'smartsegment',
          f.input,
          '--granularity',
          'coarse',
          '--hint',
          'head',
          '--param',
          `transform=${JSON.stringify(matrix)}`,
          '--request-id',
          request,
          '--max-credits',
          '100',
          '--no-download',
          '--no-open',
          '--yes',
          '--json',
        ],
        {
          env: {
            ...process.env,
            AI_MODELING_DATA_DIR: f.dir,
            AI_MODELING_PROFILE: 'test-no-credentials',
            NODE_OPTIONS: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout += String(data);
      });
      child.stderr.on('data', (data) => {
        stderr += String(data);
      });
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.on('close', resolve);
        child.on('error', reject);
      });
      assert.equal(stderr, '');
      return { exit, result: JSON.parse(stdout) as Record<string, unknown> };
    }
    const restored = await run('metadata-scale');
    assert.equal(restored.exit, 0);
    assert.equal(restored.result.task_id, original.task_id);
    assert.equal(restored.result.status, 'success');
    const changed = await run(
      'metadata-scale',
      scaleMatrix.map((v, i) => (i === 0 ? 3 : v)),
    );
    assert.equal(changed.exit, 2);
    assert.equal(changed.result.code, 'IDEMPOTENCY_CONFLICT');
    const fresh = await run('new-missing-source');
    assert.equal(fresh.exit, 2);
    assert.equal(fresh.result.code, 'INVALID_INPUT');
    assert.equal(f.jobs.requestPolicy('test-account', scaleIntentKey('new-missing-source')), undefined);
    assert.equal(f.jobs.find('test-account', 'new-missing-source-0'), undefined);
    const saved = f.jobs.requestPolicy('test-account', scaleSourceKey('metadata-scale'))!;
    await writeFile(String(object(saved.parameters).model_path), 'damaged');
    const damaged = await run('metadata-scale');
    assert.equal(damaged.exit, 2);
    assert.equal(damaged.result.code, 'SMARTSEGMENT_SCALE_SOURCE_MISSING');
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});
