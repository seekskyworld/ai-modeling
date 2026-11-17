/** 普通本地转换恢复必须固定任务/原生源/产物，并只复用仍受登记inode保护的交付。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fixture, quote, tinyGlb } from './helpers.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import {
  assertLocalExportProduced,
  assertLocalExportSnapshot,
  LOCAL_EXPORT_PROCESSING,
} from '../cli/artifacts/local-export-delivery.ts';
import { registeredFrontendTarget } from '../cli/core/frontend-delivery.ts';
import { downloadTask, type Application } from '../cli/compat/runtime.ts';
import { fullTools } from '../cli/compat/full-tools.ts';

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const fileIdentity = async (file: string) => {
  const stat = await lstat(file);
  return { inode: stat.ino, device: stat.dev, mtime: stat.mtimeMs, sha256: hash(await readFile(file)) };
};
async function prepared(format = 'glb') {
  const f = await fixture(),
    bytes = format === 'glb' ? tinyGlb() : Buffer.from('solid test\nendsolid test\n'),
    root = await realpath(f.service.config.outputDir),
    input = normalize('export', { project_id: 'project', format, pivot_to_center_bottom: true }),
    pending = f.jobs.prepare('test-account', 'original-local-conversion', 'export', input, quote),
    currentPath = path.join(root, 'b.' + format),
    oldPath = path.join(root, 'a.' + format);
  f.service.config.outputDir = root;
  await writeFile(currentPath, bytes);
  await writeFile(oldPath, bytes);
  const artifact: Artifact = {
    artifact_id: 'model',
    kind: 'model',
    format,
    index: 0,
    local_path: currentPath,
    sha256: hash(bytes),
    bytes: bytes.length,
    processing: LOCAL_EXPORT_PROCESSING,
    source_sha256: hash(Buffer.from('exact original native input')),
  };
  const job = f.jobs.update(pending.job_id, 'succeeded', {
    remote_ids: { project_id: 'project', operator_id: 'original-native-export' },
    artifacts: [artifact],
  });
  f.jobs.bindRequestPolicy('test-account', 'unrelated-frozen-policy', { version: 1, original: true });
  const calls = { forbidden: 0 };
  const forbidden = async (): Promise<never> => {
    calls.forbidden++;
    throw new TripoError('NETWORK_ERROR', 'Controlled offline test: no actual upstream request.');
  };
  f.gateway.artifactUrl = f.gateway.submit = f.gateway.status = forbidden;
  const current = () => f.jobs.get(job.job_id).artifacts[0]!;
  const mutate = (change: (value: Job) => void) => {
    const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
    try {
      const value = f.jobs.get(job.job_id);
      change(value);
      db.prepare(
        'UPDATE jobs SET account_ref=?,request_id=?,operation=?,input_hash=?,input=?,remote_ids=?,artifacts=? WHERE job_id=?',
      ).run(
        value.account_ref,
        value.request_id,
        value.operation,
        value.input_hash,
        JSON.stringify(value.input),
        JSON.stringify(value.remote_ids),
        JSON.stringify(value.artifacts),
        value.job_id,
      );
    } finally {
      db.close();
    }
  };
  const policies = () => {
    const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'), { readOnly: true });
    try {
      return db.prepare('SELECT * FROM request_policies ORDER BY account_ref,request_id').all();
    } finally {
      db.close();
    }
  };
  return {
    ...f,
    id: job.job_id,
    job,
    bytes,
    root,
    currentPath,
    oldPath,
    current,
    mutate,
    policies,
    forbidden,
    calls,
  };
}
const close = async (f: Awaited<ReturnType<typeof prepared>>) => {
  f.jobs.close();
  await rm(f.dir, { recursive: true, force: true });
};

test('local conversion B/C/D/B/C survives restart with original source SHA and refuses lost A', async () => {
  const f = await prepared();
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const policies = f.policies(),
      initial = f.current(),
      original = await fileIdentity(f.currentPath);
    const c = await f.service.download(f.id, 'model', 'c.glb'),
      d = await f.service.download(f.id, 'model', 'd.glb'),
      paths = [f.currentPath, String(c.local_path), String(d.local_path)],
      states = await Promise.all(paths.map(fileIdentity));
    second = await fixture(f.dir);
    second.service.config.outputDir = f.root;
    second.gateway.artifactUrl = second.gateway.submit = second.gateway.status = f.forbidden;
    for (const file of [...paths, f.currentPath, String(c.local_path)]) {
      const restored = await second.service.download(f.id, 'model', file);
      assert.equal(restored.local_path, file);
      for (const field of ['sha256', 'bytes', 'processing', 'source_sha256'] as const)
        assert.equal(restored[field], initial[field]);
    }
    assert.deepEqual(
      f.current().frontend_deliveries?.map((entry) => entry.path),
      paths,
    );
    assert.deepEqual(await Promise.all(paths.map(fileIdentity)), states);
    assert.deepEqual(states[0], original);
    await assert.rejects(second.service.download(f.id, 'model', f.oldPath), { code: 'OUTPUT_EXISTS' });
    assert.deepEqual(await readFile(f.oldPath), f.bytes);
    assert.deepEqual(f.policies(), policies);
    assert.equal(f.calls.forbidden, 0);
  } finally {
    second?.jobs.close();
    await close(f);
  }
});

test('parallel local conversions merge transaction-current histories without trusting caller history', async () => {
  const f = await prepared(),
    second = await fixture(f.dir);
  try {
    second.service.config.outputDir = f.root;
    second.gateway.artifactUrl = second.gateway.submit = second.gateway.status = f.forbidden;
    await Promise.all([
      f.service.download(f.id, 'model', 'c.glb'),
      second.service.download(f.id, 'model', 'd.glb'),
    ]);
    const before = f.current();
    assert.deepEqual(before.frontend_deliveries?.map((entry) => path.basename(entry.path)).sort(), [
      'b.glb',
      'c.glb',
      'd.glb',
    ]);
    f.jobs.saveArtifact(f.id, { ...before, frontend_deliveries: [] });
    assert.deepEqual(f.current().frontend_deliveries, before.frontend_deliveries);
    for (const entry of before.frontend_deliveries!) await f.service.download(f.id, 'model', entry.path);
    assert.equal(f.calls.forbidden, 0);
  } finally {
    second.jobs.close();
    await close(f);
  }
});

test('local conversion rejects copied/hardlinked/symlinked files and changed file or parent inode', async () => {
  const f = await prepared();
  try {
    const nested = String((await f.service.download(f.id, 'model', 'nested/result.glb')).local_path),
      registry = f.current().frontend_deliveries;
    const copy = path.join(f.root, 'copy.glb'),
      hard = path.join(f.root, 'hard.glb'),
      symbolic = path.join(f.root, 'symbolic.glb');
    await copyFile(f.currentPath, copy);
    await link(f.currentPath, hard);
    await symlink(f.currentPath, symbolic);
    for (const file of [copy, hard, symbolic])
      await assert.rejects(f.service.download(f.id, 'model', file), { code: 'OUTPUT_EXISTS' });
    await rename(f.currentPath, f.currentPath + '.original');
    await writeFile(f.currentPath, f.bytes);
    await assert.rejects(f.service.download(f.id, 'model', f.currentPath), { code: 'OUTPUT_EXISTS' });
    const parent = path.dirname(nested),
      stat = await lstat(nested);
    await rename(parent, parent + '-original');
    await mkdir(parent);
    await link(path.join(parent + '-original', path.basename(nested)), nested);
    assert.equal((await lstat(nested)).ino, stat.ino);
    await assert.rejects(f.service.download(f.id, 'model', nested), { code: 'OUTPUT_EXISTS' });
    assert.deepEqual(f.current().frontend_deliveries, registry);
    assert.equal(f.calls.forbidden, 0);
  } finally {
    await close(f);
  }
});

test('replaced registered source cannot be laundered into a new directory by offline generic recovery', async () => {
  const f = await prepared();
  try {
    await f.service.download(f.id, 'model', f.currentPath);
    const registry = f.current().frontend_deliveries;
    await rename(f.currentPath, f.currentPath + '.original');
    await writeFile(f.currentPath, f.bytes);
    await assert.rejects(f.service.download(f.id, 'model', 'new.glb'), { code: 'NETWORK_ERROR' });
    await assert.rejects(lstat(path.join(f.root, 'new.glb')), { code: 'ENOENT' });
    assert.deepEqual(f.current().frontend_deliveries, registry);
  } finally {
    await close(f);
  }
});

test('CLI and full MCP local download both reject same-byte replacement at saved local_path', async () => {
  const f = await prepared();
  try {
    const app = { service: f.service } as Application,
      delivered = await downloadTask(app, await f.service.get(f.id), { out: f.root }),
      file = String(delivered.model_file),
      before = await fileIdentity(file);
    await rename(file, file + '.original');
    await writeFile(file, f.bytes);
    assert.notEqual((await lstat(file)).ino, before.inode);
    const state = await fileIdentity(file);
    await assert.rejects(downloadTask(app, await f.service.get(f.id), { out: f.root }), {
      code: 'OUTPUT_EXISTS',
    });
    const tool = fullTools(app.service, app.studio).find((entry) => entry.name === 'ai_modeling_download')!;
    await assert.rejects(tool.run({ task_id: f.id, output_dir: f.root }), { code: 'OUTPUT_EXISTS' });
    assert.deepEqual(await fileIdentity(file), state);
    assert.equal(f.calls.forbidden, 0);
  } finally {
    await close(f);
  }
});

test('the original unprocessed native local_path is never seeded as a processed delivery', async () => {
  const f = await prepared();
  try {
    f.mutate((job) => {
      delete job.artifacts[0]!.processing;
      delete job.artifacts[0]!.source_sha256;
    });
    const output = path.join(f.root, 'processed.glb');
    await writeFile(output, f.bytes);
    f.jobs.saveArtifact(f.id, {
      ...f.current(),
      local_path: output,
      processing: LOCAL_EXPORT_PROCESSING,
      source_sha256: hash(Buffer.from('exact original native input')),
    });
    assert.deepEqual(
      f.current().frontend_deliveries?.map((entry) => entry.path),
      [output],
    );
    await assert.rejects(f.service.download(f.id, 'model', f.currentPath), { code: 'OUTPUT_EXISTS' });
  } finally {
    await close(f);
  }
});

test('STL delivery history is supported explicitly without broadening frontend GLB/PNG defaults', async () => {
  const f = await prepared('stl');
  try {
    await f.service.download(f.id, 'model', 'c.stl');
    await f.service.download(f.id, 'model', f.currentPath);
    const artifact = f.current();
    assert.equal(artifact.frontend_deliveries?.length, 2);
    assert.throws(
      () => registeredFrontendTarget(artifact, f.currentPath, artifact.frontend_deliveries![0]!.identity),
      { code: 'FRONTEND_OUTPUT_IDENTITY_CHANGED' },
    );
    assert.equal(f.calls.forbidden, 0);
  } finally {
    await close(f);
  }
});

for (const [name, change] of [
  [
    'input',
    (job: Job) => {
      job.input.scale_factor = 2;
    },
  ],
  [
    'remote IDs',
    (job: Job) => {
      job.remote_ids.operator_id = 'different-export';
    },
  ],
  [
    'input hash',
    (job: Job) => {
      job.input_hash = 'changed';
    },
  ],
  [
    'request ID',
    (job: Job) => {
      job.request_id = 'different-request';
    },
  ],
  [
    'source SHA',
    (job: Job) => {
      job.artifacts[0]!.source_sha256 = 'b'.repeat(64);
    },
  ],
  [
    'output SHA',
    (job: Job) => {
      job.artifacts[0]!.sha256 = 'c'.repeat(64);
    },
  ],
  [
    'output size',
    (job: Job) => {
      job.artifacts[0]!.bytes! += 1;
    },
  ],
  [
    'processing',
    (job: Job) => {
      job.artifacts[0]!.processing = 'different processing';
    },
  ],
] as const)
  test(`registered local output refuses changed ${name} before publishing`, async () => {
    const f = await prepared();
    try {
      await f.service.download(f.id, 'model', f.currentPath);
      const originalJob = f.jobs.get(f.id),
        originalArtifact = f.current();
      f.mutate(change);
      assert.throws(() => assertLocalExportSnapshot(f.jobs, originalJob, originalArtifact), {
        code: 'LOCAL_EXPORT_IDENTITY_CHANGED',
      });
      await assert.rejects(
        f.service.download(f.id, 'model', 'no-publish.glb'),
        (error: unknown) =>
          error instanceof TripoError &&
          ['LOCAL_EXPORT_IDENTITY_CHANGED', 'FRONTEND_OUTPUT_IDENTITY_CHANGED'].includes(error.code),
      );
      await assert.rejects(lstat(path.join(f.root, 'no-publish.glb')), { code: 'ENOENT' });
      assert.equal(f.calls.forbidden, 0);
    } finally {
      await close(f);
    }
  });

for (const [name, change] of [
  [
    'source SHA',
    (artifact: Artifact) => {
      artifact.source_sha256 = 'd'.repeat(64);
    },
  ],
  [
    'output SHA',
    (artifact: Artifact) => {
      artifact.sha256 = 'e'.repeat(64);
    },
  ],
  [
    'output size',
    (artifact: Artifact) => {
      artifact.bytes! += 1;
    },
  ],
  [
    'processing',
    (artifact: Artifact) => {
      delete artifact.processing;
    },
  ],
] as const)
  test(`reprocessed local ${name} is rejected before publication and during final save`, async () => {
    const f = await prepared();
    try {
      await f.service.download(f.id, 'model', f.currentPath);
      const job = f.jobs.get(f.id),
        original = f.current(),
        produced = structuredClone(original);
      change(produced);
      assert.throws(() => assertLocalExportProduced(f.jobs, job, original, produced), {
        code: 'LOCAL_EXPORT_IDENTITY_CHANGED',
      });
      assert.throws(() => f.jobs.saveArtifact(f.id, produced), { code: 'LOCAL_EXPORT_IDENTITY_CHANGED' });
      assert.deepEqual(f.current(), original);
      assert.equal(f.calls.forbidden, 0);
    } finally {
      await close(f);
    }
  });
