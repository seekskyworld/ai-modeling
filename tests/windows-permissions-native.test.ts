/** Native regressions expose no paths, environment values or raw PowerShell output. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkWindowsPermissions, windowsPermissionTimeoutMs } from '../studio/auth/windows-permissions.ts';

const systemJsonScript = (importModule: boolean) => `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  ${
    importModule
      ? `$utilityModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')
  Import-Module -Name $utilityModule -ErrorAction Stop`
      : ''
  }
  $requests = @(([Console]::In.ReadToEnd() | ConvertFrom-Json))
  if ($requests.Count -ne 1 -or $requests[0].kind -ne 'directory') { exit 2 }
  [Console]::Out.Write('AI_MODELING_PROBE_JSON')
} catch { exit 1 }
`;
const markers = new Map([
  ['AI_MODELING_PROBE_JSON', 'json'],
  ['{"ok":true}', 'private_acl'],
]);

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
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    const powerShellDirectory = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
    const executable = path.win32.join(powerShellDirectory, 'powershell.exe');
    const minimalEnv = { SystemRoot: systemRoot, WINDIR: systemRoot };
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
          marker: markers.get(result.stdout) ?? null,
        }),
      );
      return result;
    };
    const probe = (name: string, importModule: boolean, env: NodeJS.ProcessEnv) =>
      capture(
        name,
        executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(systemJsonScript(importModule), 'utf16le').toString('base64'),
        ],
        {
          input: JSON.stringify([{ path: directory, kind: 'directory' }]),
          encoding: 'utf8',
          timeout: windowsPermissionTimeoutMs,
          killSignal: 'SIGKILL',
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
          maxBuffer: 4096,
          env,
        },
      );
    // These bounded controls identify module discovery failures without inheriting the user's environment.
    probe('system_module_path_json', false, {
      ...minimalEnv,
      PSModulePath: path.win32.join(powerShellDirectory, 'Modules'),
    });
    probe('explicit_system_module_json', true, minimalEnv);
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
