/** Real process races against disposable SQLite state; no credentials or remote requests. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { JobStore } from '../cli/storage/jobs.ts';
import { imageInput, quote } from './helpers.ts';

interface Outcome {
  ok: boolean;
  error?: { code?: string; errcode?: number; message: string };
}
const workerSource = `
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobStore } from ${JSON.stringify(new URL('../cli/storage/jobs.ts', import.meta.url).href)};
import { JsonStore } from ${JSON.stringify(new URL('../studio/auth/credentials.ts', import.meta.url).href)};
JsonStore.prototype.load = function () { throw new Error('Startup test must not read credentials'); };
process.send({ ready: true });
process.once('message', async ({ file, mode, marker }) => {
  if (marker) {
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === 'BEGIN IMMEDIATE') {
        writeFileSync(marker, 'waiting');
        DatabaseSync.prototype.exec = exec;
      }
      return exec.call(this, sql);
    };
  }
  try {
    if (mode === 'cli') {
      process.env.AI_MODELING_DATA_DIR = path.dirname(file);
      process.env.AI_MODELING_OUTPUT_DIR = path.join(path.dirname(file), 'output');
      const main = ${JSON.stringify(new URL('../cli/main.ts', import.meta.url).href)};
      process.argv = [process.execPath, fileURLToPath(main), 'call', 'ai_modeling_motion_presets', '--input', '{}'];
      await import(main);
    } else {
      const store = new JobStore(file);
      store.close();
    }
    process.send({ done: true, ok: !process.exitCode });
  } catch (error) {
    process.send({ done: true, ok: false, error: { code: error.code, errcode: error.errcode, message: error.message } });
  }
  process.disconnect();
});
`;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-jobs-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const worker = path.join(directory, 'startup-worker.mjs');
  await writeFile(worker, workerSource);
  return { directory, worker };
}

function startWorker(worker: string) {
  const child = fork(worker, [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '',
    stderr = '',
    wasReady = false,
    wasDone = false;
  child.stdout!.on('data', (data) => (stdout += String(data)));
  child.stderr!.on('data', (data) => (stderr += String(data)));
  let readyResolve!: () => void,
    readyReject!: (error: Error) => void,
    doneResolve!: (value: Outcome) => void,
    doneReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const outcome = new Promise<Outcome>((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });
  // Either readiness or completion may fail first; both are still awaited below.
  void ready.catch(() => undefined);
  void outcome.catch(() => undefined);
  const fail = (error: Error) => {
    readyReject(error);
    doneReject(error);
  };
  const timeout = setTimeout(() => {
    child.kill();
    fail(new Error('Startup worker timed out.'));
  }, 20000);
  child.on('error', fail);
  child.on('message', (message: Outcome & { ready?: boolean; done?: boolean }) => {
    if (message.ready) {
      wasReady = true;
      readyResolve();
    }
    if (message.done) {
      wasDone = true;
      doneResolve(message);
    }
  });
  const closed = new Promise<void>((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (!wasReady || !wasDone) fail(new Error(`Startup worker exited ${code}: ${stderr}${stdout}`));
      resolve();
    });
  });
  return { child, ready, outcome, closed };
}

function assertCompleteSchema(file: string) {
  const db = new DatabaseSync(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 18);
    assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
    assert.deepEqual(
      tables.map((row) => row.name),
      [
        'account_leases',
        'job_aliases',
        'job_events',
        'job_names',
        'jobs',
        'pipeline_steps',
        'request_policies',
      ],
    );
    assert.equal(
      db
        .prepare('PRAGMA table_info(jobs)')
        .all()
        .filter((column) => column.name === 'observed_cost').length,
      1,
    );
  } finally {
    db.close();
  }
}

async function parallelStartup(t: TestContext, mode: 'store' | 'cli', rounds: number, count: number) {
  const f = await fixture(t);
  for (let round = 0; round < rounds; round++) {
    const directory = path.join(f.directory, String(round));
    await mkdir(directory);
    const file = path.join(directory, 'jobs.sqlite');
    const workers = Array.from({ length: count }, () => startWorker(f.worker));
    try {
      await Promise.all(workers.map((worker) => worker.ready));
      for (const worker of workers) worker.child.send({ file, mode });
      const outcomes = await Promise.all(workers.map((worker) => worker.outcome));
      await Promise.all(workers.map((worker) => worker.closed));
      for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assertCompleteSchema(file);
    } finally {
      for (const worker of workers) worker.child.kill();
      await Promise.all(workers.map((worker) => worker.closed));
    }
  }
}

test('parallel first-use JobStore processes all initialize one complete database', async (t) => {
  await parallelStartup(t, 'store', 4, 4);
});

test('parallel first-use local CLI calls succeed without reading credentials', async (t) => {
  await parallelStartup(t, 'cli', 2, 3);
});

test('a waiting initializer checks the committed version under the writer lock and never downgrades it', async (t) => {
  const f = await fixture(t),
    file = path.join(f.directory, 'jobs.sqlite'),
    marker = path.join(f.directory, 'waiting');
  new JobStore(file).close();
  const db = new DatabaseSync(file),
    worker = startWorker(f.worker);
  try {
    db.exec('PRAGMA user_version=1; BEGIN IMMEDIATE; PRAGMA user_version=19');
    await worker.ready;
    worker.child.send({ file, mode: 'store', marker });
    const deadline = Date.now() + 10000;
    while (!(await stat(marker).catch(() => null))) {
      assert.ok(Date.now() < deadline, 'The competing initializer did not reach its writer lock.');
      await delay(10);
    }
    db.exec('COMMIT');
    const result = await worker.outcome;
    await worker.closed;
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'DATABASE_VERSION');
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 19);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally {
    worker.child.kill();
    await worker.closed;
    db.close();
  }
});

test('a failed legacy migration preserves the original schema and jobs before a repaired retry', async (t) => {
  const f = await fixture(t),
    file = path.join(f.directory, 'jobs.sqlite');
  const store = new JobStore(file),
    original = store.prepare('fixture', 'preserved-request', 'image', imageInput, quote);
  store.close();
  const db = new DatabaseSync(file);
  try {
    db.exec(`DROP TABLE request_policies; DROP TABLE job_names; DROP TABLE pipeline_steps;
      DROP TABLE job_aliases; ALTER TABLE jobs DROP COLUMN observed_cost;
      CREATE TABLE job_names (unrelated TEXT); PRAGMA user_version=1;`);
    const schema = () => db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
    const before = schema(),
      row = db.prepare('SELECT * FROM jobs').get();
    assert.throws(() => new JobStore(file), { code: 'ERR_SQLITE_ERROR' });
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1);
    assert.deepEqual(schema(), before);
    assert.deepEqual(db.prepare('SELECT * FROM jobs').get(), row);
    db.exec('DROP TABLE job_names');
    const restored = new JobStore(file);
    try {
      assert.deepEqual(restored.get(original.job_id), original);
    } finally {
      restored.close();
    }
    assertCompleteSchema(file);
  } finally {
    db.close();
  }
});
