/** Legacy seven-step chains preserve their immutable business layout while authorizing only untouched billable steps. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { processingPlan } from '../cli/compat/planning.ts';
import { executePlan } from '../cli/compat/runtime.ts';
import { selectAffinePlan } from '../cli/compat/smartsegment-affine-transfer-plan.ts';
import { preflightUnquotedPlan } from '../cli/compat/unquoted-plan.ts';
import { affineBillingConsentKey } from '../cli/compat/smartsegment-affine-billing.ts';
import {
  affineChildRequest,
  affineGroupRequest,
  affineInputKey,
  affineIntentKey,
} from '../cli/core/smartsegment-affine-policy.ts';
import { scaleIntentKey } from '../cli/core/smartsegment-scale-policy.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { affineFixture, affineMatrix, affineRequest } from './helpers-smartsegment-affine.ts';
import { quote } from './helpers.ts';

const unknown = () => ({ ...quote, known: false, variable: true, credits: undefined });
const consentPlan = (f: Awaited<ReturnType<typeof affineFixture>>) =>
  processingPlan('smartsegment', f.source, {
    param: { transform: affineMatrix, granularity: 'coarse', hint: 'head', accept_variable_cost: true },
  });

for (const file of [false, true])
  test(`legacy ${file ? 'file' : 'reference'} chain authorizes an untouched merge and recovers its original three-step prefix`, async () => {
    const f = await affineFixture({ file });
    try {
      const originalIntent = fingerprint(
        f.jobs.requestPolicy('test-account', affineIntentKey(affineRequest)),
      );
      f.before.submit = (_job, index) => {
        if (index === 2)
          f.service.pricing.quote = async (operation) => (operation === 'modification' ? unknown() : quote);
      };
      const first = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(first.status, 'needs_attention', JSON.stringify(first));
      assert.equal(object(first.error).code, 'PRICE_UNKNOWN');
      assert.equal(f.gateway.posts, 3);
      const prefix = f
        .chain()
        .map((job) => ({ id: job.job_id, input: job.input_hash, request: job.request_id }));
      const originalSource = fingerprint(f.sourcePolicy());
      assert.equal(
        f.jobs.requestPolicy('test-account', affineInputKey(affineChildRequest(affineRequest, 3))),
        undefined,
      );
      f.before.submit = undefined;
      const plan = consentPlan(f),
        flags = { ...f.flags, maxCredits: undefined };
      const result = await executePlan(f.app, plan, flags);
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(f.gateway.posts, 7);
      assert.deepEqual(
        f
          .chain()
          .slice(0, 3)
          .map((job) => ({ id: job.job_id, input: job.input_hash, request: job.request_id })),
        prefix,
      );
      assert.equal(
        fingerprint(f.jobs.requestPolicy('test-account', affineIntentKey(affineRequest))),
        originalIntent,
      );
      assert.equal(fingerprint(f.sourcePolicy()), originalSource);
      assert.deepEqual(
        f.submissions.map((job) => job.input.accept_variable_cost),
        [undefined, undefined, undefined, true, undefined, undefined, undefined],
      );
      f.service.pricing.quote = async () => {
        throw Error('Original completed receipts need no new quotes.');
      };
      assert.equal((await executePlan(f.app, plan, flags)).task_id, result.task_id);
      assert.equal(f.gateway.posts, 7);
    } finally {
      await f.close();
    }
  });

test('legacy unknown prefix returns its original receipt despite an unquoted pending merge', async () => {
  const f = await affineFixture({ unknownIndex: 2 });
  try {
    const first = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(first.status, 'outcome_unknown', JSON.stringify(first));
    f.service.pricing.quote = async () => {
      throw Error('The unresolved prefix must precede future billing checks.');
    };
    const result = await executePlan(f.app, consentPlan(f), { ...f.flags, maxCredits: undefined });
    assert.equal(result.status, 'outcome_unknown', JSON.stringify(result));
    assert.equal(result.task_id, first.task_id);
    assert.equal(f.gateway.posts, 3);
    assert.equal(f.jobs.find('test-account', affineChildRequest(affineRequest, 3)), undefined);
    assert.equal(
      f.jobs.requestPolicy('test-account', affineBillingConsentKey(affineChildRequest(affineRequest, 3))),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test('new legacy import consent survives a crash after scale/input freezing without altering the parent source', async () => {
  const f = await affineFixture({ file: true });
  try {
    const originalIntent = fingerprint(f.jobs.requestPolicy('test-account', affineIntentKey(affineRequest)));
    f.service.pricing.quote = async (operation) =>
      ['import_model', 'modification'].includes(operation) ? unknown() : quote;
    const originalQuote = f.service.quote.bind(f.service);
    f.service.quote = async () => {
      throw new TripoError('SIMULATED_CRASH', 'Stop before preparing the job.', 'not_submitted');
    };
    const plan = consentPlan(f),
      flags = { ...f.flags, maxCredits: undefined };
    await assert.rejects(executePlan(f.app, plan, flags), { code: 'SIMULATED_CRASH' });
    const child = affineChildRequest(affineRequest, 0);
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.find('test-account', child), undefined);
    assert(f.jobs.requestPolicy('test-account', affineInputKey(child)));
    assert(f.jobs.requestPolicy('test-account', affineBillingConsentKey(child)));
    assert(f.jobs.requestPolicy('test-account', scaleIntentKey(affineGroupRequest(affineRequest, 'first'))));
    assert.equal(object(f.sourcePolicy().first_parameters).accept_variable_cost, undefined);
    f.service.quote = originalQuote;
    const result = await executePlan(f.app, plan, flags);
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(f.gateway.posts, 7);
    assert.deepEqual(
      f.submissions.map((job) => job.input.accept_variable_cost),
      [true, undefined, undefined, true, undefined, undefined, undefined],
    );
    assert.equal(
      fingerprint(f.jobs.requestPolicy('test-account', affineIntentKey(affineRequest))),
      originalIntent,
    );
    assert.equal(object(f.sourcePolicy().first_parameters).accept_variable_cost, undefined);
  } finally {
    await f.close();
  }
});

test('a previously prepared legacy merge cannot acquire consent but keeps its original quoted recovery route', async () => {
  const f = await affineFixture();
  try {
    const submit = f.service.submit.bind(f.service);
    f.service.submit = async (operation, request, input, maximum) => {
      if (operation === 'modification') {
        f.jobs.prepare('test-account', request, operation, normalize(operation, input), quote);
        throw new TripoError(
          'PREPARED_CRASH',
          'Simulated process loss before claiming the job.',
          'not_submitted',
        );
      }
      return await submit(operation, request, input, maximum);
    };
    const first = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(first.status, 'needs_attention', JSON.stringify(first));
    const child = affineChildRequest(affineRequest, 3),
      original = f.jobs.find('test-account', child)!;
    assert.equal(original.state, 'prepared');
    assert.equal(original.input.accept_variable_cost, undefined);
    const binding = fingerprint(f.jobs.requestPolicy('test-account', affineInputKey(child)));
    f.service.pricing.quote = async () => {
      throw Error('The immutable consent conflict must precede a quote.');
    };
    await assert.rejects(executePlan(f.app, consentPlan(f), { ...f.flags, maxCredits: undefined }), {
      code: 'UNQUOTED_CONSENT_FROZEN',
    });
    assert.equal(f.jobs.find('test-account', child)!.input_hash, original.input_hash);
    assert.equal(fingerprint(f.jobs.requestPolicy('test-account', affineInputKey(child))), binding);
    assert.equal(f.gateway.posts, 3);
    f.service.submit = submit;
    f.service.pricing.quote = async () => quote;
    assert.equal((await executePlan(f.app, f.plan(), f.flags)).status, 'success');
    assert.equal(f.gateway.posts, 7);
    assert.equal(f.jobs.find('test-account', child)!.job_id, original.job_id);
  } finally {
    await f.close();
  }
});

test('old input-only or scale-only preparation cannot gain billing consent and numeric budgets remain rejected', async () => {
  for (const file of [false, true]) {
    const f = await affineFixture({ file });
    try {
      const frozenKey = file
        ? scaleIntentKey(affineGroupRequest(affineRequest, 'first'))
        : affineInputKey(affineChildRequest(affineRequest, 3));
      f.jobs.bindRequestPolicy('test-account', frozenKey, { original: true });
      const plan = selectAffinePlan(f.app, consentPlan(f), affineRequest);
      f.service.pricing.quote = async () => {
        throw Error('No quote may authorize changes to already frozen input.');
      };
      await assert.rejects(preflightUnquotedPlan(f.app, plan, {}, affineRequest), {
        code: 'UNQUOTED_CONSENT_FROZEN',
      });
      for (const maxCredits of [0, 100])
        await assert.rejects(executePlan(f.app, plan, { ...f.flags, maxCredits }), {
          code: 'UNQUOTED_BUDGET_UNSUPPORTED',
        });
      assert.deepEqual(f.jobs.requestPolicy('test-account', frozenKey), { original: true });
      assert.equal(f.gateway.posts, 0);
    } finally {
      await f.close();
    }
  }
});
