/** 绑骨后套动作的导出：链上新生成的动作必须在冻结 JPEG 缺省意图之前并入参数，否则提交前核对必然冲突。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, quote } from './helpers.ts';
import { makePlan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { StudioClient } from '../studio/api/client.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { Gateway } from '../studio/api/gateway.ts';

test('retarget export freezes its JPEG intent with the animations created earlier in the chain', async () => {
  const f = await fixture();
  try {
    const source = f.jobs.prepare(
      'test-account',
      'source',
      'model',
      { mode: 'text', prompt: 'knight' },
      quote,
    );
    f.jobs.update(source.job_id, 'submitting');
    f.jobs.update(source.job_id, 'submitted', {
      remote_ids: { project_id: 'project', operator_id: 'source-op' },
    });
    f.jobs.update(source.job_id, 'succeeded');
    const submitted: Record<string, unknown>[] = [];
    f.gateway.submit = async (job) => {
      submitted.push({ operation: job.operation, ...job.input });
      return {
        remote_ids: {
          project_id: 'project',
          operator_id: `00000000-0000-4000-8000-${String(submitted.length).padStart(12, '0')}`,
        },
      };
    };
    f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
    // 记下冻结意图时看到的导出参数，然后在读取来源之前停下（测试环境不访问 CDN）。
    let frozen: Record<string, unknown> | undefined;
    (f.gateway as Gateway).jpegSource = async (_account, parameters) => {
      frozen = { ...parameters };
      throw new TripoError('TEXTURE_SOURCE_UNVERIFIED', 'Stop after observing the frozen export intent.');
    };
    const app = {
      service: f.service,
      studio: {
        client: new StudioClient(f.service.credentials, async () =>
          Response.json({ code: 0, data: { riggable: true, rig_type: 'biped' } }),
        ),
      },
      close: () => f.jobs.close(),
    } as unknown as Application;
    const plan = makePlan([source.job_id], { then: 'rig,retarget:animations=["preset:idle","preset:walk"]' });
    await executePlan(app, plan, { download: false, requestId: 'knight-moves' }).catch(() => undefined);
    const animate = submitted.filter((x) => x.operation === 'animate');
    assert.equal(animate.length, 2);
    assert.ok(frozen, 'the export step must reach the JPEG default check');
    assert.equal(frozen.with_animation, true);
    assert.deepEqual(frozen.animations, [
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ]);
    assert.equal(submitted.filter((x) => x.operation === 'export').length, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
