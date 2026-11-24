/** Diagnostic reports must not expose the raw npm command, environment, paths or package metadata. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  npmDiagnosticFiles,
  readNpmDiagnostics,
  summarizeNpmDiagnostics,
} from '../scripts/npm-consumer-diagnostics.ts';

test('npm diagnostics retain only known phases, durations and event/error categories', () => {
  const privateValue = 'synthetic-token-NEVER-REPORT';
  const report = summarizeNpmDiagnostics(
    [
      `1 verbose argv --package C:\\private\\${privateValue}.tgz`,
      '2 timing reify:loadShrinkwraps Completed in 42ms\n3 timing build:link Completed in 15ms',
      `4 timing reifyNode:C:\\private\\${privateValue} Completed in 500ms`,
      `5 silly unfinished npm timer reify:unpack 1000\n6 silly reify moves C:\\private\\${privateValue}`,
      `7 error code ETIMEDOUT\n8 verbose code ${privateValue}`,
    ],
    {
      metadata: { argv: [privateValue], token: privateValue },
      timers: { 'build:link': 20, [privateValue]: 99, reify: -1 },
      unfinishedTimers: { 'reify:unpack': [30, 80], [privateValue]: [0, 80] },
    },
    1100,
  );
  assert.deepEqual(report.completed, [
    { stage: 'reify:loadShrinkwraps', duration_ms: 42 },
    { stage: 'build:link', duration_ms: 20 },
  ]);
  assert.deepEqual(report.unfinished, [{ stage: 'reify:unpack', duration_ms: 50 }]);
  assert.equal(report.last_event, 'verbose:code');
  assert.deepEqual(report.error_codes, ['ETIMEDOUT']);
  assert.equal(JSON.stringify(report).includes(privateValue), false);
  assert.equal(JSON.stringify(report).includes('C:\\private'), false);
});

test('missing timer completion is not invented as an unfinished npm phase', () => {
  const report = summarizeNpmDiagnostics(['0 timing idealTree Completed in 17ms'], undefined);
  assert.equal(report.timing_file_available, false);
  assert.deepEqual(report.unfinished, []);
  assert.deepEqual(report.completed, [{ stage: 'idealTree', duration_ms: 17 }]);
});

test('npm diagnostics only inspect newly created logs for the current isolated attempt', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-npm-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logs = path.join(directory, 'cache', '_logs');
  await mkdir(logs, { recursive: true });
  await writeFile(path.join(logs, '2026-11-24T17_00_00_001Z-debug-0.log'), '0 error code EPERM\n');
  const previous = await npmDiagnosticFiles(directory);
  await writeFile(
    path.join(logs, '2026-11-24T17_01_00_001Z-debug-0.log'),
    '0 timing reify:unpack Completed in 95ms\n1 error code ENOTCACHED\n',
  );
  await writeFile(
    path.join(logs, '2026-11-24T17_01_00_001Z-timing.json'),
    JSON.stringify({ timers: { 'build:link': 4 }, unfinishedTimers: { reify: [10, 110] } }),
  );
  await writeFile(path.join(logs, 'not-an-npm-log.txt'), '2 error code EACCES\n');
  const report = await readNpmDiagnostics(directory, previous);
  assert.equal(report.debug_logs_inspected, 1);
  assert.equal(report.timing_file_available, true);
  assert.deepEqual(report.error_codes, ['ENOTCACHED']);
  assert.deepEqual(report.unfinished, [{ stage: 'reify', duration_ms: 100 }]);
  assert.deepEqual(report.completed, [
    { stage: 'reify:unpack', duration_ms: 95 },
    { stage: 'build:link', duration_ms: 4 },
  ]);
});
