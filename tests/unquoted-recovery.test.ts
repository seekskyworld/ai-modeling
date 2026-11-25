/** Future unquoted work must not hide an earlier receipt or authorize repeating a submission. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { preflightUnquotedPlan } from '../cli/compat/unquoted-plan.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { JobState } from '../studio/contracts/types.ts';
import { fixture, quote } from './helpers.ts';
import { uvImportFixture } from './uv-import-fixture.ts';

const uvOptions = { param: { bake: false, compress: 'geometry', accept_variable_cost: true } };
const unquoted = () => ({ ...quote, known: false, credits: undefined, variable: true });

test('ordered preflight restores earlier uncompleted receipts before checking unreachable tail prices', async () => {
  const plan = processingPlan('uv', './unread-source.glb', uvOptions);
  const states: JobState[] = [
    'submitting',
    'submitted',
    'running',
    'waiting_input',
    'failed',
    'requires_login',
    'outcome_unknown',
  ];
  for (const blocking of [0, 1, 2]) {
    for (const state of states) {
      let quoted = 0;
      const app = {
        service: {
          accountRef: () => 'test-account',
          jobs: {
            find: (_account: string, request: string) => {
              const index = Number(request.split('-').at(-1));
              return index <= blocking
                ? { operation: plan.steps[index]!.operation, state: index === blocking ? state : 'succeeded' }
                : undefined;
            },
          },
          pricing: {
            quote: async () => {
              quoted++;
              throw Error('A later quote must not hide an existing receipt.');
            },
          },
        },
      } as unknown as Application;
      await preflightUnquotedPlan(app, plan, {}, 'ordered-uv');
      assert.equal(quoted, 0, `step ${blocking}: ${state}`);
    }
  }
});

test('a new UV chain preflights both imports and a completed prefix still checks its next unquoted step', async () => {
  const f = await fixture();
  try {
    const app = { service: f.service } as Application;
    const plan = processingPlan('uv', './unread-source.glb', uvOptions);
    let quotes = 0;
    f.service.pricing.quote = async () => {
      quotes++;
      return unquoted();
    };
    await preflightUnquotedPlan(app, plan, {}, 'new-uv');
    assert.equal(quotes, 2);
    for (const index of [0, 1, 2]) {
      const step = plan.steps[index]!;
      const job = f.jobs.prepare('test-account', `new-uv-${index}`, step.operation, step.parameters, quote);
      f.jobs.update(job.job_id, 'succeeded');
    }
    f.service.pricing.quote = async () => {
      quotes++;
      return { ...unquoted(), expires_at: new Date(Date.now() - 1).toISOString() };
    };
    await assert.rejects(preflightUnquotedPlan(app, plan, {}, 'new-uv'), { code: 'PRICE_UNKNOWN' });
    assert.equal(quotes, 3);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('the full four-step UV runner recovers the first unknown import without quote, tail submission or repost', async () => {
  const f = await fixture();
  try {
    const model = path.join(f.dir, 'source.glb');
    await writeFile(model, await uvImportFixture(false));
    f.gateway.failSubmit = new TripoError('LOST_IMPORT_RECEIPT', 'Simulated lost import receipt.', 'unknown');
    f.service.pricing.quote = async (operation) => (operation === 'import_model' ? unquoted() : quote);
    const app = {
      service: f.service,
      studio: {
        client: {
          request: async () => {
            throw Error('No network read required.');
          },
        },
      },
    } as unknown as Application;
    const plan = processingPlan('uv', model, uvOptions);
    const flags = { requestId: 'unknown-uv', download: false };
    const first = await executePlan(app, plan, flags);
    assert.equal(first.status, 'outcome_unknown', JSON.stringify(first));
    assert.equal(f.gateway.posts, 1);
    f.service.pricing.quote = async () => {
      throw Error('Original unknown submission must be returned without a quote.');
    };
    const recovered = await executePlan(app, plan, flags);
    assert.equal(recovered.status, 'outcome_unknown', JSON.stringify(recovered));
    assert.equal(recovered.task_id, first.task_id);
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.jobs.find('test-account', 'unknown-uv-1'), undefined);
    assert.equal(f.jobs.find('test-account', 'unknown-uv-3'), undefined);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
