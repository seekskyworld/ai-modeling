/** 新三步的原字节、完整metadata、旧请求分派和未知结果恢复；不连接真实账号。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { executePlan } from '../cli/compat/runtime.ts';
import { executionPreview } from '../cli/compat/run-plan.ts';
import { validateSmartSegmentFiles } from '../cli/compat/smartsegment-file-preflight.ts';
import { legacyAffinePlan } from '../cli/compat/smartsegment-affine-transfer-plan.ts';
import { freezeAffineIntent } from '../cli/compat/smartsegment-affine-source.ts';
import { affineIntentKey } from '../cli/core/smartsegment-affine-policy.ts';
import {
  transferChildRequest,
  transferIntentKey,
  transferSourceKey,
} from '../cli/core/smartsegment-affine-transfer-policy.ts';
import { object } from '../studio/contracts/errors.ts';
import { quote } from './helpers.ts';
import { transferFixture, transferMatrix, transferRequest } from './helpers-smartsegment-transfer.ts';

for (const file of [false, true])
  test(`affine transfer ${file ? 'file' : 'reference'} sends unchanged bytes and frozen three-step intent`, async () => {
    const f = await transferFixture({ file });
    try {
      assert.deepEqual(
        f.plan().steps.map((step) => step.operation),
        ['import_model', 'project_edit', 'segment'],
      );
      const result = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(result.native_step_count, 3);
      assert.equal(f.gateway.posts, 3);
      assert.equal((result.chain as unknown[]).length, 3);
      assert.deepEqual(
        f.chain().map((job) => job.request_id),
        [0, 1, 2].map((index) => transferChildRequest(transferRequest, index)),
      );
      assert.equal(f.jobs.requestPolicy('test-account', affineIntentKey(transferRequest)), undefined);
      assert.deepEqual(object(f.sourcePolicy().preparation).transform_matrix, transferMatrix);
      assert.equal(object(f.sourcePolicy().preparation).kind, 'pure_rotation_import_affine');
      const validation = object(result.smartsegment_affine_transfer_validation);
      assert.equal(validation.status, 'verified');
      assert.equal(validation.native_step_count, 3);
      assert.equal(validation.matched_oriented_faces, 4);
      assert.deepEqual(validation.transform_matrix, transferMatrix);
      assert.equal(object(validation.tolerance).position, 4e-5);
      for (const artifact of f.artifacts) await rm(artifact.local_path!);
      await rm(f.mask.local_path!);
      await rm(f.input);
      await rm(f.native);
      await validateSmartSegmentFiles(f.app, f.plan(), transferRequest);
      f.service.config.outputDir = '';
      const resumed = await executePlan(f.app, f.plan(), {
        ...f.flags,
        download: true,
        out: path.join(f.dir, 'caller-output'),
      });
      assert.equal(resumed.status, 'success', JSON.stringify(resumed));
      assert.equal(resumed.download_error, undefined);
      assert.equal(resumed.task_id, result.task_id);
      assert.equal(f.gateway.posts, 3);
      await assert.rejects(executePlan(f.app, f.plan(transferMatrix, 'different hint'), f.flags), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      assert.equal(f.gateway.posts, 3);
    } finally {
      await f.close();
    }
  });

for (const material_factor of [{}, { roughness: 0.8 }, { metallic: 0.2 }, { metallic: 0.2, roughness: 0.8 }])
  test(`new transfer preserves exact source Studio material values: ${JSON.stringify(material_factor)}`, async () => {
    const f = await transferFixture({ sourceMetadata: { material_factor } });
    try {
      const result = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.deepEqual(f.submissions[1]!.input.material_factor, material_factor);
      assert.deepEqual(object(f.sourcePolicy().metadata).material_factor, material_factor);
      assert.deepEqual(f.originalMetadata().material_factor, material_factor);
      assert.deepEqual(f.states.get('transfer-op-1')!.material_factor, material_factor);
      assert.equal(f.submissions[1]!.input.replace, true);
      assert.equal(f.gateway.posts, 3);
    } finally {
      await f.close();
    }
  });

for (const options of [{ wrongImport: true }, { wrongFinal: true }])
  test(`transfer stops on ${options.wrongImport ? 'import' : 'final'} geometry mismatch without a replacement request`, async () => {
    const f = await transferFixture(options);
    try {
      const result = await executePlan(f.app, f.plan(), f.flags),
        posts = f.gateway.posts;
      assert.equal(result.status, 'needs_attention', JSON.stringify(result));
      assert.equal(posts, options.wrongImport ? 1 : 3);
      if (options.wrongFinal) {
        assert.equal(f.final().state, 'succeeded');
        await assert.rejects(f.service.download(f.final().job_id, 'model', 'blocked.glb'));
        await assert.rejects(f.service.download(f.final().job_id, 'semantic-mask', 'blocked.png'));
      }
      const again = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(again.status, 'needs_attention');
      assert.equal(f.gateway.posts, posts);
    } finally {
      await f.close();
    }
  });

for (const options of [{ failedIndex: 0 }, { failedIndex: 1 }, { unknownIndex: 0 }, { unknownIndex: 2 }])
  test(`transfer preserves terminal or unknown stage ${JSON.stringify(options)}`, async () => {
    const f = await transferFixture(options);
    try {
      const result = await executePlan(f.app, f.plan(), f.flags),
        posts = f.gateway.posts;
      assert.equal(
        result.status,
        options.unknownIndex === undefined ? 'failed' : 'outcome_unknown',
        JSON.stringify(result),
      );
      const again = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(again.task_id, result.task_id);
      assert.equal(again.status, result.status);
      assert.equal(f.gateway.posts, posts);
    } finally {
      await f.close();
    }
  });

test('a historical seven-step intent restores its original preview without acquiring a transfer intent', async () => {
  const f = await transferFixture();
  try {
    const original = legacyAffinePlan(f.plan());
    freezeAffineIntent(f.app, original, transferRequest);
    const preview = executionPreview(f.app, f.plan(), f.flags);
    assert.deepEqual(preview, original);
    assert.equal(preview.steps.length, 7);
    assert.equal(f.jobs.requestPolicy('test-account', transferIntentKey(transferRequest)), undefined);
    assert.equal(f.gateway.posts, 0);
  } finally {
    await f.close();
  }
});

for (const request of [
  `${transferRequest}-0`,
  `${transferRequest}-6`,
  `${transferRequest}:smartsegment-affine:first-0`,
  transferChildRequest(transferRequest, 0),
])
  test(`an orphan native receipt cannot acquire a new transfer intent: ${request}`, async () => {
    const f = await transferFixture();
    try {
      f.jobs.prepare('test-account', request, 'import_model', { model_path: f.input }, quote);
      await assert.rejects(executePlan(f.app, f.plan(), f.flags), {
        code: 'SMARTSEGMENT_TRANSFER_UNVERIFIED',
      });
      assert.equal(f.jobs.requestPolicy('test-account', transferIntentKey(transferRequest)), undefined);
      assert.equal(f.gateway.posts, 0);
    } finally {
      await f.close();
    }
  });

for (const importedNodeName of [undefined, 'new-native-root'])
  test(`single-node Studio rename follows verified imported identity: ${importedNodeName ?? 'same name'}`, async () => {
    const children_rename = { 'editable-mesh': '原显示名' },
      f = await transferFixture({ sourceMetadata: { children_rename }, importedNodeName });
    try {
      const result = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.deepEqual(f.submissions[1]!.input.children_rename, {
        [importedNodeName ?? 'editable-mesh']: '原显示名',
      });
      assert.deepEqual(
        f.states.get('transfer-op-1')!.children_rename,
        f.submissions[1]!.input.children_rename,
      );
      assert.deepEqual(f.originalMetadata().children_rename, children_rename);
      assert.equal(f.gateway.posts, 3);
    } finally {
      await f.close();
    }
  });

test('a rename for an absent source node is rejected before any native transfer submission', async () => {
  const f = await transferFixture({ sourceMetadata: { children_rename: { 'not-in-source': 'named-part' } } });
  try {
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), { code: 'SMARTSEGMENT_TRANSFER_UNVERIFIED' });
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.requestPolicy('test-account', transferSourceKey(transferRequest)), undefined);
  } finally {
    await f.close();
  }
});

for (const options of [
  { sourceNodeName: 'Part One', sourceMetadata: { children_rename: { Part_One: 'alias' } } },
  {
    sourceNodeName: 'source',
    sourceSceneName: 'source',
    sourceMetadata: { children_rename: { source_1: 'alias' } },
  },
])
  test(`a source display rename with an unproven loader key stops before import: ${JSON.stringify(options)}`, async () => {
    const f = await transferFixture(options);
    try {
      await assert.rejects(executePlan(f.app, f.plan(), f.flags), {
        code: 'SMARTSEGMENT_TRANSFER_UNVERIFIED',
      });
      assert.equal(f.gateway.posts, 0);
    } finally {
      await f.close();
    }
  });

test('a source without display rename can use a verified safe imported node name', async () => {
  const f = await transferFixture({
    file: true,
    sourceNodeName: 'Part One',
    importedNodeName: 'safe-native-node',
  });
  try {
    const result = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(f.gateway.posts, 3);
    assert.deepEqual(Object.keys(object(f.submissions[1]!.input.children_transform_matrix)), [
      'safe-native-node',
    ]);
  } finally {
    await f.close();
  }
});

test('an unsafe imported loader selector stops before metadata and preserves the import receipt', async () => {
  const f = await transferFixture({ importedNodeName: 'native raw:node' });
  try {
    const result = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(result.status, 'needs_attention', JSON.stringify(result));
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.chain()[0]!.state, 'succeeded');
    await executePlan(f.app, f.plan(), f.flags);
    assert.equal(f.gateway.posts, 1);
  } finally {
    await f.close();
  }
});

for (const index of [1, 2])
  for (const extra of [{ transform_matrix: transferMatrix }, { unrecognized_field: true }])
    test(`complete native metadata stays frozen across the submission boundary ${index}: ${Object.keys(extra)[0]}`, async () => {
      const f = await transferFixture();
      try {
        f.before.submit = (_job, current) => {
          if (current === index)
            f.states.set(`transfer-op-${index - 1}`, {
              ...f.states.get(`transfer-op-${index - 1}`),
              ...extra,
            });
        };
        const result = await executePlan(f.app, f.plan(), f.flags);
        assert.equal(result.status, 'failed', JSON.stringify(result));
        assert.equal(object(result.error).code, 'PROJECT_CHANGED');
        assert.equal(f.gateway.posts, index);
      } finally {
        await f.close();
      }
    });
