/** 未预报价的同意只属于显式选中的导入/应用步骤；预算冲突必须在全链开始前发现。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { processingPlan, makePlan, type Plan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { dryRunPlan, executeCandidates, executionPreview } from '../cli/compat/run-plan.ts';
import { validatePlanCostLimit } from '../cli/compat/execution-policy.ts';
import { fixture, quote } from './helpers.ts';

test('UV文件链仅首尾原生导入接收未预报价同意，已有任务仅尾部接收', () => {
  const options = { param: { compress: 'geometry', bake: false, accept_variable_cost: true } };
  const file = processingPlan('uv', './unquoted-fixture.glb', options);
  assert.deepEqual(
    file.steps.map((step) => [step.operation, step.parameters.accept_variable_cost]),
    [
      ['import_model', true],
      ['uv_generate', undefined],
      ['uv_commit', undefined],
      ['import_model', true],
    ],
  );
  assert.deepEqual(
    processingPlan('uv', '@source', options).steps.map((step) => [
      step.operation,
      step.parameters.accept_variable_cost,
    ]),
    [
      ['uv_generate', undefined],
      ['uv_commit', undefined],
      ['import_model', true],
    ],
  );
  assert.equal(options.param.accept_variable_cost, true);
  assert.equal(options.param.compress, 'geometry');
});

test('默认不隐式同意；直接导入和make分步同意绑定各自的实际步骤', () => {
  assert.ok(
    processingPlan('uv', './unquoted-fixture.glb', {
      param: { compress: 'geometry', bake: false },
    }).steps.every((step) => step.parameters.accept_variable_cost === undefined),
  );
  assert.equal(
    processingPlan('import', './unquoted-fixture.glb', { param: { accept_variable_cost: true } }).steps[0]!
      .parameters.accept_variable_cost,
    true,
  );
  const initialOnly = makePlan(['./unquoted-fixture.glb'], {
    param: { accept_variable_cost: true },
    then: 'uv:bake=false;compress=geometry',
  });
  assert.equal(initialOnly.steps[0]!.parameters.accept_variable_cost, true);
  assert.equal(initialOnly.steps.at(-1)!.parameters.accept_variable_cost, undefined);
  const both = makePlan(['./unquoted-fixture.glb'], {
    param: { accept_variable_cost: true },
    then: 'uv:bake=false;compress=geometry;accept_variable_cost=true',
  });
  assert.equal(both.steps.at(-1)!.parameters.accept_variable_cost, true);
  assert.ok(both.steps.slice(1, -1).every((step) => step.parameters.accept_variable_cost === undefined));
});

test('不接受false、字符串或无关步骤的同意，并保留Lab已有的专用合同', () => {
  for (const value of [false, 'true', 1, null])
    assert.throws(
      () => processingPlan('import', './unquoted-fixture.glb', { param: { accept_variable_cost: value } }),
      {
        code: 'INVALID_INPUT',
      },
    );
  for (const name of ['uv', 'texture'])
    assert.throws(() => processingPlan(name, '@source', { param: { accept_variable_cost: true } }), {
      code: 'STUDIO_CAPABILITY_UNAVAILABLE',
    });
  const lab = processingPlan('edit', './unquoted-fixture.glb', {
    param: {
      ref_image: './reference.png',
      bbox: [
        [0, 0, 0],
        [1, 1, 1],
      ],
      accept_variable_cost: true,
    },
  });
  assert.equal(lab.labReferenceEdit?.accept_variable_cost, true);
  assert.equal(lab.steps[0]!.operation, 'canvas_lab');
  assert.equal(lab.steps[0]!.parameters.accept_variable_cost, true);
});

test('全链numeric预算冲突在账号访问、读取源文件、报价和上传前拒绝，包含0', async () => {
  let applicationAccesses = 0;
  const app = new Proxy({} as Application, {
    get() {
      applicationAccesses++;
      throw new Error('Budget validation must precede any application/account access.');
    },
  });
  const plans: Plan[] = [
    processingPlan('uv', './missing-source.glb', {
      param: { compress: 'geometry', bake: false, accept_variable_cost: true },
    }),
    processingPlan('uv', '@missing-source', {
      param: { compress: 'geometry', bake: false, accept_variable_cost: true },
    }),
    {
      steps: [
        {
          name: 'save',
          operation: 'modification',
          parameters: { indices_path: './missing-indices.json', accept_variable_cost: true },
        },
      ],
      pending_uploads: [],
      warnings: [],
    },
    {
      steps: [{ name: 'apply', operation: 'retexture_apply', parameters: { accept_variable_cost: true } }],
      pending_uploads: [],
      warnings: [],
    },
  ];
  for (const plan of plans) {
    for (const maximum of [0, 10]) {
      const flags = { requestId: 'before-first-step', maxCredits: maximum };
      await assert.rejects(executePlan(app, plan, flags), { code: 'UNQUOTED_BUDGET_UNSUPPORTED' });
      await assert.rejects(executeCandidates(app, plan, flags), { code: 'UNQUOTED_BUDGET_UNSUPPORTED' });
      await assert.rejects(dryRunPlan(plan, flags), { code: 'UNQUOTED_BUDGET_UNSUPPORTED' });
      assert.throws(() => executionPreview(app, plan, flags), { code: 'UNQUOTED_BUDGET_UNSUPPORTED' });
    }
    assert.doesNotThrow(() => validatePlanCostLimit(plan, {}));
  }
  assert.equal(applicationAccesses, 0);
  assert.doesNotThrow(() =>
    validatePlanCostLimit(processingPlan('import', './missing-source.glb', {}), { maxCredits: 10 }),
  );
});

test('链尾导入缺同意、缺当前白名单或已过期，在源文件读取与首个UV收费前拒绝', async () => {
  const f = await fixture();
  let accountRequests = 0;
  f.gateway.account = async () => {
    accountRequests++;
    throw Error('Preflight must not request the account balance.');
  };
  const app = { service: f.service } as Application;
  try {
    const scenarios = [
      { consent: false, variable: true, expires_at: quote.expires_at },
      { consent: true, variable: undefined, expires_at: quote.expires_at },
      { consent: true, variable: true, expires_at: new Date(Date.now() - 1000).toISOString() },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const quoted: string[] = [];
      f.service.pricing.quote = async (operation) => {
        quoted.push(operation);
        return {
          ...quote,
          known: false,
          credits: undefined,
          variable: scenario.variable,
          expires_at: scenario.expires_at,
        };
      };
      const plan = processingPlan('uv', '@unreadable-source', {
        param: {
          bake: false,
          compress: 'geometry',
          ...(scenario.consent ? { accept_variable_cost: true } : {}),
        },
      });
      await assert.rejects(executePlan(app, plan, { requestId: `preflight-${index}`, download: false }), {
        code: 'PRICE_UNKNOWN',
      });
      assert.deepEqual(quoted, ['import_model']);
    }
    assert.equal(accountRequests, 0);
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.list('test-account', 10).length, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
