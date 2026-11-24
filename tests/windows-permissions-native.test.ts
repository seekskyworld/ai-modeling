/** Native transport probes expose no paths, environment values or raw PowerShell output. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkWindowsPermissions, windowsPermissionTimeoutMs } from '../studio/auth/windows-permissions.ts';

const stdinScript = (method: 'ReadToEnd' | 'ReadLine') => `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $requests = @(([Console]::In.${method}() | ConvertFrom-Json))
  if ($requests.Count -ne 1 -or $requests[0].kind -ne 'directory') { exit 2 }
  [Console]::Out.Write('AI_MODELING_PROBE_STDIN')
} catch { exit 1 }
`;
const markers = new Map([
  ['AI_MODELING_PROBE_READY', 'ready'],
  ['AI_MODELING_PROBE_STDIN', 'stdin'],
  ['{"ok":true}', 'private_acl'],
]);

test(
  'native Windows PowerShell transport and protected DACL',
  {
    skip: process.platform !== 'win32',
    timeout: 90000,
  },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-native-acl-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const minimalEnv = { SystemRoot: systemRoot, WINDIR: systemRoot };
    const payload = JSON.stringify([{ path: directory, kind: 'directory' }]);
    const records = new Map<string, { status: number | null; marker: string | null }>();
    const capture = (
      name: string,
      command: string,
      args: string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) => {
      const started = performance.now();
      const result = spawnSync(command, args, options);
      const diagnostic = {
        probe: name,
        status: result.status,
        signal: result.signal,
        error_code: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
        elapsed_ms: Math.round(performance.now() - started),
        marker: markers.get(result.stdout) ?? null,
      };
      records.set(name, diagnostic);
      t.diagnostic(JSON.stringify(diagnostic));
      return result;
    };
    const run = (
      name: string,
      script: string,
      input: string,
      extra: string[] = [],
      env: NodeJS.ProcessEnv = minimalEnv,
    ) =>
      capture(
        name,
        executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          ...extra,
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        {
          input,
          encoding: 'utf8',
          timeout: windowsPermissionTimeoutMs,
          killSignal: 'SIGKILL',
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
          maxBuffer: 4096,
          env,
        },
      );
    const markerScript = "[Console]::Out.Write('AI_MODELING_PROBE_READY')";
    run('minimal_env_marker', markerScript, '');
    run('inherited_env_marker', markerScript, '', [], { ...process.env });
    run('minimal_env_read_to_end', stdinScript('ReadToEnd'), payload);
    run('minimal_env_read_to_end_text', stdinScript('ReadToEnd'), payload, ['-InputFormat', 'Text']);
    run('minimal_env_read_line_newline', stdinScript('ReadLine'), payload + '\n');
    let protectedAcl = false;
    try {
      checkWindowsPermissions(
        [{ path: directory, kind: 'directory', protect: true }],
        (command, args, options) => capture('actual_synthetic_acl', command, args, options),
      );
      protectedAcl = true;
    } catch {
      /* Report every diagnostic before asserting the production permission boundary. */
    }
    for (const name of ['minimal_env_marker', 'inherited_env_marker']) {
      assert.equal(records.get(name)?.status, 0, `${name} must start; inspect diagnostic metadata.`);
      assert.equal(records.get(name)?.marker, 'ready');
    }
    assert.equal(protectedAcl, true, 'Production ACL protection must pass; inspect diagnostic metadata.');
  },
);
