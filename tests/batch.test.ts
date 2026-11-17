/** 验证清单在竞争、重启和未知回执后仍保持原任务身份，不以重试名义重复付费。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './helpers.ts';
import { loadBatch, runBatch } from '../cli/compat/batch.ts';
import type { Application } from '../cli/compat/runtime.ts';
import { TripoError } from '../studio/contracts/errors.ts';

test('concurrent batch jobs wait for the account slot and resume without new submissions', async () => {
  const f = await fixture();
  const app = { service: f.service, studio: f.gateway, close: () => {} } as unknown as Application;
  const file = path.join(f.dir, 'batch.yaml');
  const submit = f.gateway.submit.bind(f.gateway);
  f.gateway.submit = async (job) => {
    await delay(100);
    return await submit(job);
  };
  try {
    await writeFile(
      file,
      'concurrency: 2\ndefaults:\n  params:\n    texture: false\njobs:\n  - input: a blue cube\n    name: cube\n  - input: a red ball\n    name: ball\n',
    );
    const batch = await loadBatch(file);
    const first = await runBatch(app, batch, { download: false, timeout: 5 });
    assert.equal(first.success, 2);
    assert.equal(f.gateway.posts, 2);
    const saved = JSON.parse(await readFile(file + '.state.json', 'utf8'));
    assert.equal((await runBatch(app, batch, { download: false })).success, 2);
    assert.equal(f.gateway.posts, 2);
    assert.equal(JSON.parse(await readFile(file + '.state.json', 'utf8')).run_id, saved.run_id);
    await writeFile(file, 'jobs:\n  - input: changed cube\n');
    await assert.rejects(runBatch(app, await loadBatch(file), { download: false }), {
      code: 'BATCH_CHANGED',
    });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('same manifest is locked across runners, and an unknown result never creates a replacement', async () => {
  const f = await fixture();
  const app = { service: f.service, studio: f.gateway, close: () => {} } as unknown as Application;
  const file = path.join(f.dir, 'batch.yaml');
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.gateway.submit = async () => {
    f.gateway.posts++;
    entered();
    await pending;
    throw new TripoError('NETWORK_ERROR', 'Lost receipt', 'unknown');
  };
  try {
    await writeFile(file, 'jobs:\n  - input: a blue cube\n');
    const batch = await loadBatch(file);
    const first = runBatch(app, batch, { download: false });
    await started;
    await assert.rejects(runBatch(app, batch, { download: false, fresh: true }), { code: 'BATCH_IN_USE' });
    finish();
    const result = await first;
    assert.equal(result.success, 0);
    assert.equal((await runBatch(app, batch, { download: false, retries: 3 })).success, 0);
    assert.equal(f.gateway.posts, 1);
  } finally {
    finish();
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
