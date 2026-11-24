/** Native regressions expose no paths, environment values or raw PowerShell output. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkWindowsPermissions } from '../studio/auth/windows-permissions.ts';

test(
  'native Windows system JSON module and protected DACL preserve Unicode paths',
  { skip: process.platform !== 'win32', timeout: 60000 },
  async (t) => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'ai-modeling-native-acl-'));
    t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
    const directory = path.join(temporaryRoot, '私有 auth Ω');
    const file = path.join(directory, '凭据 file.json');
    const content = '{"synthetic":"凭据 unchanged"}';
    await mkdir(directory);
    await writeFile(file, content);
    const capture = (
      name: string,
      command: string,
      args: string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) => {
      const started = performance.now();
      const result = spawnSync(command, args, options);
      t.diagnostic(
        JSON.stringify({
          probe: name,
          status: result.status,
          signal: result.signal,
          error_code: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
          elapsed_ms: Math.round(performance.now() - started),
          private_acl: result.stdout === '{"ok":true}',
        }),
      );
      return result;
    };
    const entries = [
      { path: directory, kind: 'directory' as const },
      { path: file, kind: 'file' as const },
    ];
    let protectedAcl = false;
    let verifiedAcl = false;
    try {
      checkWindowsPermissions(
        entries.map((entry) => ({ ...entry, protect: true })),
        (command, args, options) => capture('production_protect_unicode', command, args, options),
      );
      protectedAcl = true;
      checkWindowsPermissions(entries, (command, args, options) =>
        capture('production_verify_unicode', command, args, options),
      );
      verifiedAcl = true;
    } catch {
      /* Report bounded diagnostics before asserting the production permission boundary. */
    }
    assert.equal(protectedAcl, true, 'Production ACL protection must pass; inspect diagnostic metadata.');
    assert.equal(verifiedAcl, true, 'Production ACL verification must pass; inspect diagnostic metadata.');
    assert.equal(await readFile(file, 'utf8'), content);
  },
);
