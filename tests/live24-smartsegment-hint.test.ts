/** 实测支持的粗/细粒度提示必须进入真实 REST 第二步，并在恢复时保留完整付费意图。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { Operations, type Submission } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import type { Job } from '../studio/contracts/types.ts';
import { TripoError } from '../studio/contracts/errors.ts';

const hint = 'Split the model into exactly two parts: the head and everything below the neck.';
for (const [granularity, native] of [
  ['coarse', 'simple'],
  ['fine', 'detailed'],
] as const)
  test(`${granularity} image hints use the selected REST granularity and unchanged retries never resubmit either stage`, async () => {
    const f = await fixture();
    try {
      const file = path.join(f.dir, 'input.png');
      await writeFile(
        file,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=',
          'base64',
        ),
      );
      const submitted: Job[] = [],
        requests: Submission[] = [];
      const client = {
        request: async () => ({
          id: 'generated-project',
          is_owner: true,
          operator: {
            operator_id: 'generated-model',
            status: 'success',
            is_segmented: false,
            is_rigged: false,
          },
        }),
      } as unknown as StudioClient;
      f.gateway.submit = async (job) => {
        submitted.push(structuredClone(job));
        if (job.operation === 'segment') {
          requests.push(await new Operations(client, []).build(job));
          throw new TripoError('NETWORK_ERROR', 'Lost original segmentation reply', 'unknown');
        }
        return { remote_ids: { project_id: 'generated-project', operator_id: 'generated-model' } };
      };
      f.gateway.status = async () => ({
        state: 'succeeded',
        progress: 100,
        artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
      });
      const app = { service: f.service, studio: { client } } as Application;
      const create = () => processingPlan('smartsegment', file, { granularity, hint });
      assert.deepEqual(
        create(),
        fullToolPlan('ai_modeling_smart_segment', { input: file, granularity, hint }),
      );
      const flags = { requestId: `${granularity}-hint`, timeout: 1, download: false };
      const first = await executePlan(app, create(), flags);
      assert.equal(first.status, 'outcome_unknown');
      assert.deepEqual(
        submitted.map((j) => j.operation),
        ['model', 'segment'],
      );
      assert.equal(submitted[0]!.input.generate_parts, false);
      assert.equal(submitted[0]!.input.prompt, undefined);
      assert.equal(submitted[1]!.input.expected_operator_id, 'generated-model');
      assert.deepEqual(requests, [
        {
          route: '/v2/studio/operation/ai_segmentation',
          body: {
            project_id: 'generated-project',
            model_version: 'v2.0-20260430',
            segmentation_granularity: native,
            prompt: hint,
          },
        },
      ]);
      const again = await executePlan(app, create(), flags);
      assert.equal(again.task_id, first.task_id);
      assert.equal(again.status, 'outcome_unknown');
      assert.equal(submitted.length, 2);
      for (const changed of [
        processingPlan('smartsegment', file, { granularity: 'medium', hint }),
        processingPlan('smartsegment', file, { granularity, hint: 'different parts' }),
        processingPlan('smartsegment', file, { granularity }),
      ])
        await assert.rejects(executePlan(app, changed, flags), { code: 'IDEMPOTENCY_CONFLICT' });
      assert.equal(submitted.length, 2);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  });
