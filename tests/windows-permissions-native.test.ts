/** Native transport probes expose no paths, environment values or raw PowerShell output. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkWindowsPermissions, windowsPermissionTimeoutMs } from '../studio/auth/windows-permissions.ts';

const stageMarkers = {
  started: 'AI_MODELING_STAGE_STARTED',
  'input-encoding': 'AI_MODELING_STAGE_INPUT_ENCODING',
  'output-encoding': 'AI_MODELING_STAGE_OUTPUT_ENCODING',
  read: 'AI_MODELING_STAGE_READ',
  json: 'AI_MODELING_STAGE_JSON',
} as const;
const stageLabels = new Map(Object.entries(stageMarkers).map(([label, marker]) => [marker, label]));
const stage = (name: keyof typeof stageMarkers) => `
[Console]::Out.WriteLine('${stageMarkers[name]}')
[Console]::Out.Flush()
`;
const inputEncoding = `
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
${stage('input-encoding')}
`;
const outputEncoding = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
${stage('output-encoding')}
`;
const parsedMarker = `
  $requests = @(($raw | ConvertFrom-Json))
  ${stage('json')}
  if ($requests.Count -ne 1 -or $requests[0].kind -ne 'directory') { exit 2 }
  [Console]::Out.Write('AI_MODELING_PROBE_STDIN')
`;
const stdinScript = (method: 'ReadToEnd' | 'ReadLine' | 'StreamReaderReadLine', configureInput = true) => `
${stage('started')}
$ErrorActionPreference = 'Stop'
${configureInput ? inputEncoding : ''}
${outputEncoding}
try {
  ${
    method === 'StreamReaderReadLine'
      ? `$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false), $false)
  $raw = $reader.ReadLine()`
      : `$raw = [Console]::In.${method}()`
  }
  ${stage('read')}
  ${parsedMarker}
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
    timeout: 130000,
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
      // Ignore all other output, including partial lines emitted before a timeout.
      const lines = (result.stdout ?? '').split(/\r?\n/);
      const diagnostic = {
        probe: name,
        status: result.status,
        signal: result.signal,
        error_code: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
        elapsed_ms: Math.round(performance.now() - started),
        marker: lines.map((line) => markers.get(line)).find((marker) => marker !== undefined) ?? null,
        stages: lines.flatMap((line) => {
          const label = stageLabels.get(line as (typeof stageMarkers)[keyof typeof stageMarkers]);
          return label ? [label] : [];
        }),
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
    run(
      'minimal_env_encoding_only',
      `${stage('started')}
$ErrorActionPreference = 'Stop'
${inputEncoding}
${outputEncoding}
[Console]::Out.Write('AI_MODELING_PROBE_READY')`,
      '',
    );
    run(
      'minimal_env_inline_json',
      `${stage('started')}
$ErrorActionPreference = 'Stop'
$raw = '[{"kind":"directory"}]'
try {
  ${parsedMarker}
} catch { exit 1 }`,
      '',
    );
    run('inherited_env_read_to_end', stdinScript('ReadToEnd'), payload, [], { ...process.env });
    run('minimal_env_read_line_no_input_encoding', stdinScript('ReadLine', false), payload + '\n');
    run('minimal_env_stream_reader', stdinScript('StreamReaderReadLine', false), payload + '\n');
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
