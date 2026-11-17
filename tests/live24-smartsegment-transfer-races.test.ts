/** 新三步跨await和最终数据库事务必须保留原账号、原完整义务及原回执。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { executePlan } from '../cli/compat/runtime.ts';
import { downloadSmartSegmentTransferArtifact } from '../cli/artifacts/smartsegment-affine-transfer-output.ts';
import {
  transferSourceAnchorKey,
  transferSourceKey,
  transferOutputAnchorKey,
} from '../cli/core/smartsegment-affine-transfer-policy.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';
import type { Gateway } from '../studio/api/gateway.ts';
import { transferFixture, transferRequest } from './helpers-smartsegment-transfer.ts';
type Fixture = Awaited<ReturnType<typeof transferFixture>>;
function removePolicy(f: Fixture, key: string): void {
  const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
  try {
    db.prepare('DELETE FROM request_policies WHERE account_ref=? AND request_id=?').run('test-account', key);
  } finally {
    db.close();
  }
}
async function ready() {
  const f = await transferFixture();
  assert.equal((await executePlan(f.app, f.plan(), f.flags)).status, 'success');
  f.service.config.outputDir = await realpath(f.service.config.outputDir);
  return f;
}
for (const index of [0, 1, 2])
  for (const phase of ['quote', 'account', 'beforeSend'])
    test(`transfer stage ${index} refuses an original source-anchor race during ${phase}`, async () => {
      const f = await transferFixture();
      try {
        const operations = ['import_model', 'project_edit', 'segment'];
        const remove = () => removePolicy(f, transferSourceAnchorKey(transferRequest));
        if (phase === 'beforeSend')
          f.before.submit = (_job, stage) => {
            if (stage === index) remove();
          };
        else if (phase === 'quote') {
          const quote = f.service.pricing.quote.bind(f.service.pricing);
          f.service.pricing.quote = async (operation, input) => {
            const result = await quote(operation, input);
            if (
              operation === operations[index] &&
              f.jobs.requestPolicy('test-account', transferSourceKey(transferRequest))
            )
              remove();
            return result;
          };
        } else {
          const gateway: Gateway = f.gateway,
            original = gateway.account.bind(gateway);
          gateway.account = async () => {
            const result = await original();
            if (f.gateway.posts === index) remove();
            return result;
          };
        }
        try {
          assert.notEqual((await executePlan(f.app, f.plan(), f.flags)).status, 'success');
        } catch (error) {
          assert.equal((error as TripoError).code, 'SMARTSEGMENT_TRANSFER_UNVERIFIED');
        }
        assert.equal(f.gateway.posts, index);
      } finally {
        await f.close();
      }
    });
for (const id of ['model', 'semantic-mask'])
  for (const guardInvocation of [3, 5, 7, 9])
    test(`${id} cannot publish after policy drift at awaited delivery guard ${guardInvocation}`, async () => {
      const f = await ready();
      try {
        const job = f.final(),
          artifact = job.artifacts.find((a) => a.artifact_id === id)!,
          relative = id === 'model' ? 'race.glb' : 'race.png';
        let checks = 0;
        await assert.rejects(
          downloadSmartSegmentTransferArtifact(
            f.jobs,
            job,
            artifact,
            { root: f.service.config.outputDir, relative },
            () => {
              if (++checks === guardInvocation) removePolicy(f, transferOutputAnchorKey(job));
            },
          ),
          { code: 'SMARTSEGMENT_TRANSFER_UNVERIFIED' },
        );
        await assert.rejects(lstat(path.join(f.service.config.outputDir, relative)), { code: 'ENOENT' });
        assert.equal(f.gateway.posts, 3);
      } finally {
        await f.close();
      }
    });
for (const id of ['model', 'semantic-mask'])
  test(`${id} active-account change across cache read cannot publish`, async () => {
    const f = await ready();
    try {
      const job = f.final(),
        artifact = job.artifacts.find((a) => a.artifact_id === id)!,
        relative = id === 'model' ? 'account.glb' : 'account.png';
      let checks = 0;
      await assert.rejects(
        downloadSmartSegmentTransferArtifact(
          f.jobs,
          job,
          artifact,
          { root: f.service.config.outputDir, relative },
          () => {
            if (++checks === 3)
              f.service.credentials.save({
                ...f.service.credentials.load()!,
                accountRef: 'different-account',
              });
            if (f.service.accountRef() !== job.account_ref)
              throw new TripoError('ACCOUNT_MISMATCH', 'Changed account.');
          },
        ),
        { code: 'ACCOUNT_MISMATCH' },
      );
      await assert.rejects(lstat(path.join(f.service.config.outputDir, relative)), { code: 'ENOENT' });
    } finally {
      await f.close();
    }
  });
for (const id of ['model', 'semantic-mask'])
  test(`${id} final SQLite save rechecks transfer output anchor without an optional caller guard`, async () => {
    const f = await ready();
    try {
      const job = f.final(),
        before = f.jobs.get(job.job_id).artifacts,
        artifact = before.find((a) => a.artifact_id === id)!,
        data = await readFile(artifact.local_path!),
        target = path.join(f.service.config.outputDir, id === 'model' ? 'cas.glb' : 'cas.png');
      await writeFile(target, data);
      removePolicy(f, transferOutputAnchorKey(job));
      assert.throws(
        () =>
          f.jobs.saveArtifact(job.job_id, {
            ...artifact,
            local_path: target,
            sha256: createHash('sha256').update(data).digest('hex'),
            bytes: data.length,
          }),
        { code: 'SMARTSEGMENT_TRANSFER_UNVERIFIED' },
      );
      assert.deepEqual(f.jobs.get(job.job_id).artifacts, before);
    } finally {
      await f.close();
    }
  });
test('final SQLite save refuses the right bytes under another original remote identity', async () => {
  const f = await ready();
  try {
    const job = f.final(),
      artifact = job.artifacts.find((a) => a.kind === 'model')!;
    assert.throws(
      () =>
        f.jobs.saveArtifact(job.job_id, artifact, {
          account_ref: job.account_ref,
          operation: job.operation,
          input: job.input,
          remote_ids: { ...job.remote_ids, operator_id: 'another-original' },
          kind: artifact.kind,
          format: artifact.format,
          index: artifact.index,
        }),
      { code: 'NATIVE_OUTPUT_IDENTITY_CHANGED' },
    );
    assert.equal(object(f.service.summary(job)).state, 'succeeded');
  } finally {
    await f.close();
  }
});
