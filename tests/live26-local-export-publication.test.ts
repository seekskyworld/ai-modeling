/** 在隔离进程中替换下载/计算两条外部边界，实际本地发布必须服从产生结果后的两次拒绝。 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, lstat, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { tinyGlb } from './helpers.ts';

for (const rejectAt of [1, 2])
  test(`local export output guard ${rejectAt} rejects before linking the destination`, async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'tripo-local-export-publish-')));
    try {
      const bytes = tinyGlb(),
        hash = createHash('sha256').update(bytes).digest('hex'),
        sourceHash = 'a'.repeat(64),
        entry = new URL('../cli/artifacts/export-transform.ts', import.meta.url).href,
        downloadModule =
          'data:text/javascript,' +
          encodeURIComponent(
            `export async function download(){return {local_path:'/controlled/source.glb',sha256:'${sourceHash}'}}`,
          ),
        processModule =
          'data:text/javascript,' +
          encodeURIComponent(
            `export async function processModel(){return Buffer.from('${bytes.toString('base64')}','base64')}`,
          );
      const script = `
        import assert from 'node:assert/strict';
        import { registerHooks } from 'node:module';
        import { existsSync } from 'node:fs';
        const registration = registerHooks({ resolve(specifier,context,next) {
          if(context.parentURL === ${JSON.stringify(entry)} && specifier === './download.ts')
            return {url:${JSON.stringify(downloadModule)},shortCircuit:true};
          if(context.parentURL === ${JSON.stringify(entry)} && specifier === '../local/blender.ts')
            return {url:${JSON.stringify(processModule)},shortCircuit:true};
          return next(specifier,context);
        }});
        try {
          const {downloadTransformedExport} = await import(${JSON.stringify(entry)});
          let calls=0;
          await assert.rejects(downloadTransformedExport('https://cdn.tripo3d.ai/controlled.glb',
            ${JSON.stringify(directory)},'no-output.glb',{format:'glb',pivot_to_center_bottom:true}, metadata => {
              calls++;
              assert.equal(metadata.source_sha256,${JSON.stringify(sourceHash)});
              assert.equal(metadata.sha256,${JSON.stringify(hash)});
              assert.equal(metadata.bytes,${bytes.length});
              assert.equal(existsSync(${JSON.stringify(path.join(directory, 'no-output.glb'))}),false);
              if(calls===${rejectAt})throw Object.assign(Error('Controlled changed source/output identity'),{code:'IDENTITY_TEST_REJECTED'});
            }),{code:'IDENTITY_TEST_REJECTED'});
          assert.equal(calls,${rejectAt});
        } finally { registration.deregister(); }
      `;
      const child = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], {
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(child.stdout, '');
      await assert.rejects(lstat(path.join(directory, 'no-output.glb')), { code: 'ENOENT' });
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
