/** 新三步完整义务损坏、原件恢复、交付路径和异步变更的离线回归。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executePlan } from '../cli/compat/runtime.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import {
  transferChildRequest,
  transferIntentKey,
  transferSourceKey,
  transferSourceAnchorKey,
  transferStageKey,
  transferStageAnchorKey,
  transferEditKey,
  transferEditAnchorKey,
  transferStepKey,
  transferInputKey,
  transferOutputKey,
  transferOutputAnchorKey,
} from '../cli/core/smartsegment-affine-transfer-policy.ts';
import { array, object, text } from '../studio/contracts/errors.ts';
import { transferFixture, transferRequest } from './helpers-smartsegment-transfer.ts';
type Fixture = Awaited<ReturnType<typeof transferFixture>>;
function policy(f: Fixture, key: string, value?: Record<string, unknown>): void {
  const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
  try {
    if (value)
      db.prepare('UPDATE request_policies SET policy=? WHERE account_ref=? AND request_id=?').run(
        JSON.stringify(value),
        'test-account',
        key,
      );
    else
      db.prepare('DELETE FROM request_policies WHERE account_ref=? AND request_id=?').run(
        'test-account',
        key,
      );
  } finally {
    db.close();
  }
}
async function prepared(): Promise<Fixture> {
  const f = await transferFixture();
  const result = await executePlan(f.app, f.plan(), f.flags);
  assert.equal(result.status, 'success', JSON.stringify(result));
  f.service.config.outputDir = await realpath(f.service.config.outputDir);
  return f;
}
async function allSurfacesBlock(f: Fixture): Promise<void> {
  const job = f.final();
  assert.equal(object(await f.service.get(job.job_id)).state, 'needs_attention');
  const listed = array(f.service.list(100, 0).jobs)
    .map(object)
    .find((row) => row.job_id === job.job_id)!;
  assert.equal(listed.state, 'needs_attention');
  for (const [id, ext] of [
    ['model', 'glb'],
    ['semantic-mask', 'png'],
  ]) {
    const target = path.join(f.service.config.outputDir, `must-not-publish.${ext}`);
    await assert.rejects(f.service.download(job.job_id, id!, target));
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  }
  assert.equal(f.final().state, 'succeeded');
  assert.equal(f.gateway.posts, 3);
}
const missingKeys = [
  ['intent', () => transferIntentKey(transferRequest)],
  ['source', () => transferSourceKey(transferRequest)],
  ['source-anchor', () => transferSourceAnchorKey(transferRequest)],
  ['import', () => transferStageKey(transferRequest)],
  ['import-anchor', () => transferStageAnchorKey(transferRequest)],
  ['edit', () => transferEditKey(transferRequest)],
  ['edit-anchor', () => transferEditAnchorKey(transferRequest)],
  ...[0, 1, 2].flatMap((index) => [
    [`step-${index}`, () => transferStepKey(transferChildRequest(transferRequest, index))],
    [`input-${index}`, () => transferInputKey(transferChildRequest(transferRequest, index))],
  ]),
] as [string, () => string][];
for (const [name, key] of missingKeys)
  test(`transfer missing ${name} blocks get/list and both native artifacts`, async () => {
    const f = await prepared();
    try {
      policy(f, key());
      await allSurfacesBlock(f);
    } finally {
      await f.close();
    }
  });
for (const which of ['proof', 'anchor'])
  test(`transfer missing output ${which} blocks every delivery`, async () => {
    const f = await prepared();
    try {
      policy(f, which === 'proof' ? transferOutputKey(f.final()) : transferOutputAnchorKey(f.final()));
      await allSurfacesBlock(f);
    } finally {
      await f.close();
    }
  });
const mutateProof: [string, (proof: Record<string, unknown>) => void][] = [
  [
    'original-A',
    (p) => {
      p.transform_matrix = object(p.second_native_geometry).transform_matrix;
    },
  ],
  [
    'only-second-leg',
    (p) => {
      p.maximum_position_error = 4.883e-5;
    },
  ],
  [
    'accumulated-limit',
    (p) => {
      p.tolerance = { position: 8e-5 };
    },
  ],
  [
    'source-count',
    (p) => {
      p.matched_oriented_faces = Number(p.matched_oriented_faces) - 1;
    },
  ],
  [
    'second-leg',
    (p) => {
      object(p.second_native_geometry).maximum_position_error = 4.001e-5;
    },
  ],
  [
    'import-attributes',
    (p) => {
      object(object(p.import_geometry).import_attributes).unchanged_material_and_texture = false;
    },
  ],
  [
    'import-projection',
    (p) => {
      object(object(p.import_geometry).projected_final_geometry).actual_final_output_verified = true;
    },
  ],
  [
    'native-byte-modification',
    (p) => {
      p.native_result_modified = true;
    },
  ],
  [
    'mask-identity',
    (p) => {
      object(p.mask).identity = '0'.repeat(64);
    },
  ],
];
for (const [name, mutate] of mutateProof)
  test(`structurally invalid transfer ${name} fails even with matching output anchor`, async () => {
    const f = await prepared();
    try {
      const key = transferOutputKey(f.final()),
        value = f.jobs.requestPolicy('test-account', key)!;
      mutate(value);
      policy(f, key, value);
      policy(f, transferOutputAnchorKey(f.final()), { output: fingerprint(value) });
      await allSurfacesBlock(f);
    } finally {
      await f.close();
    }
  });
for (const kind of ['model', 'mask'])
  test(`transfer corrupt ${kind} cache is never overwritten or delivered`, async () => {
    const f = await prepared();
    try {
      const proof = f.jobs.requestPolicy('test-account', transferOutputKey(f.final()))!,
        selected = kind === 'model' ? proof : object(proof.mask),
        bucket = createHash('sha256').update('test-account').digest('hex'),
        cached = path.join(
          text(proof.cache_data_dir),
          'verified-output-cache',
          bucket,
          `${text(selected.sha256)}.glb`,
        ),
        bad = Buffer.from('corrupted original cache');
      await writeFile(cached, bad);
      await allSurfacesBlock(f);
      assert.deepEqual(await readFile(cached), bad);
    } finally {
      await f.close();
    }
  });
test('native model and PNG recover to multiple caller paths while damaged registered paths stay untouched', async () => {
  const f = await prepared();
  try {
    const job = f.final();
    for (const [id, ext] of [
      ['model', 'glb'],
      ['semantic-mask', 'png'],
    ]) {
      const first = path.join(f.service.config.outputDir, `first.${ext}`),
        second = path.join(f.service.config.outputDir, `second.${ext}`);
      const saved = await f.service.download(job.job_id, id!, first);
      const original = await readFile(first),
        initial = await lstat(first);
      await f.service.download(job.job_id, id!, second);
      assert.deepEqual(await readFile(second), original);
      await f.service.download(job.job_id, id!, first);
      assert.equal((await lstat(first)).ino, initial.ino);
      assert.equal(saved.sha256, createHash('sha256').update(original).digest('hex'));
      const corrupted = Buffer.from('do not replace caller data');
      await writeFile(first, corrupted);
      await assert.rejects(f.service.download(job.job_id, id!, first), { code: 'OUTPUT_EXISTS' });
      assert.deepEqual(await readFile(first), corrupted);
    }
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});
test('missing verified final cache restores exact raw bytes without repeating any native task', async () => {
  const f = await prepared();
  try {
    const proof = f.jobs.requestPolicy('test-account', transferOutputKey(f.final()))!,
      bucket = createHash('sha256').update('test-account').digest('hex');
    for (const p of [proof, object(proof.mask)])
      await rm(
        path.join(text(proof.cache_data_dir), 'verified-output-cache', bucket, `${text(p.sha256)}.glb`),
      );
    assert.equal(object(await f.service.get(f.final().job_id)).state, 'succeeded');
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});
