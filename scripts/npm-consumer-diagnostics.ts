/** Read only bounded logs from this disposable npm attempt; expose no log text or paths. */
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';

const timerNames = new Set([
  'npm',
  'command:exec',
  'idealTree',
  'idealTree:init',
  'idealTree:userRequests',
  'idealTree:buildDeps',
  'idealTree:inflate',
  'idealTree:fixDepFlags',
  'reify',
  'reify:loadTrees',
  'reify:diffTrees',
  'reify:retireShallow',
  'reify:createSparse',
  'reify:loadShrinkwraps',
  'reify:loadBundles',
  'reify:unpack',
  'reify:build',
  'reify:unretire',
  'reify:trash',
  'reify:save',
  'build',
  'build:queue',
  'build:deps',
  'build:links',
  'build:link',
]);
const eventNames = new Set([
  'silly:idealTree',
  'silly:reify',
  'silly:fetch',
  'silly:tarball',
  'silly:placeDep',
  'silly:ADD',
  'silly:CHANGE',
  'http:fetch',
  'http:cache',
  'info:run',
  'warn:cleanup',
  'verbose:exit',
  'verbose:code',
  'error:code',
]);
const errorCodes = new Set([
  'ETIMEDOUT',
  'ENOTCACHED',
  'EACCES',
  'EPERM',
  'EBUSY',
  'ENOENT',
  'ENOTEMPTY',
  'EINTEGRITY',
  'EINVALIDPACKAGENAME',
  'EBADENGINE',
  'ENOSPC',
  'EEXIST',
  'ERESOLVE',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ERR_INVALID_URL',
  'EUNSUPPORTEDPROTOCOL',
  'ELSPROBLEMS',
  'EUSAGE',
  'E401',
  'E403',
  'E404',
]);
const logName = /^(\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}_\d{3}Z-)(?:debug-\d+\.log|timing\.json)$/;
const maximumLogBytes = 256 * 1024;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const duration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 3600000;

function unfinishedDuration(value: unknown): number | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(duration)) return null;
  const elapsed = value[1]! - value[0]!;
  return duration(elapsed) ? elapsed : null;
}

/** Missing timer completion is not evidence of an unfinished phase. */
export function summarizeNpmDiagnostics(logs: readonly string[], timing: unknown, observedAt = Date.now()) {
  const completed = new Map<string, number>();
  const unfinished = new Map<string, number | null>();
  const errors = new Set<string>();
  let lastEvent: string | null = null;
  for (const text of logs) {
    for (const line of text.split(/\r?\n/)) {
      const done = /^\d+ timing (\S+) Completed in (\d+)ms$/.exec(line);
      if (done && timerNames.has(done[1]!) && duration(Number(done[2])))
        completed.set(done[1]!, Number(done[2]));
      const pending = /^\d+ silly unfinished npm timer (\S+) (\d+)$/.exec(line);
      if (pending && timerNames.has(pending[1]!)) {
        const elapsed = observedAt - Number(pending[2]);
        unfinished.set(pending[1]!, duration(elapsed) ? elapsed : null);
      }
      const event = /^\d+ (silly|http|info|warn|verbose|error) (\S+)(?: |$)/.exec(line);
      if (event && eventNames.has(`${event[1]}:${event[2]}`)) lastEvent = `${event[1]}:${event[2]}`;
      const code = /^\d+ (?:error|verbose) code (\S+)$/.exec(line);
      if (code && errorCodes.has(code[1]!)) errors.add(code[1]!);
    }
  }
  for (const [name, value] of Object.entries(record(record(timing).timers)))
    if (timerNames.has(name) && duration(value)) completed.set(name, value);
  for (const [name, value] of Object.entries(record(record(timing).unfinishedTimers))) {
    if (!timerNames.has(name)) continue;
    unfinished.set(name, unfinishedDuration(value));
  }
  return {
    debug_logs_inspected: logs.length,
    timing_file_available: timing !== undefined,
    completed: [...completed].map(([stage, duration_ms]) => ({ stage, duration_ms })),
    unfinished: [...unfinished].map(([stage, duration_ms]) => ({ stage, duration_ms })),
    last_event: lastEvent,
    error_codes: [...errors],
  };
}

export async function npmDiagnosticFiles(directory: string): Promise<string[]> {
  return readdir(path.join(directory, 'cache', '_logs')).then(
    (names) => names.filter((name) => logName.test(name)),
    () => [],
  );
}

async function boundedLog(filename: string, tail: boolean): Promise<string> {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || (!tail && before.size > maximumLogBytes))
    throw new Error('Unavailable npm diagnostic.');
  const handle = await open(filename, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error('Changed npm diagnostic.');
    const bytes = Buffer.alloc(Math.min(before.size, maximumLogBytes));
    const offset = tail ? Math.max(0, before.size - bytes.length) : 0;
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function readNpmDiagnostics(directory: string, previous: readonly string[]) {
  const names = (await npmDiagnosticFiles(directory)).filter((name) => !previous.includes(name)).sort();
  const prefix = logName.exec(names.at(-1) ?? '')?.[1];
  const selected = names.filter((name) => prefix && name.startsWith(prefix));
  const directoryLogs = path.join(directory, 'cache', '_logs');
  const logs = await Promise.all(
    selected
      .filter((name) => name.endsWith('.log'))
      .slice(-4)
      .map((name) => boundedLog(path.join(directoryLogs, name), true).catch(() => undefined)),
  );
  const timingFile = selected.find((name) => name.endsWith('timing.json'));
  const timing: unknown = timingFile
    ? await boundedLog(path.join(directoryLogs, timingFile), false)
        .then(
          (text) => JSON.parse(text),
          () => undefined,
        )
        .catch(() => undefined)
    : undefined;
  return summarizeNpmDiagnostics(
    logs.filter((text): text is string => text !== undefined),
    timing,
  );
}
