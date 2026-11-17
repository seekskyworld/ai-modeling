/** 多次另存必须保留已登记原文件；遗失旧路径不得从相同字节反推授权。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
import { fixture, tinyGlb } from './helpers.ts';
import { StudioClient } from '../studio/api/client.ts';
import { exportFrontend, type FrontendExportRuntime } from '../cli/core/frontend-export.ts';
import { frontendOutputKey } from '../cli/core/frontend-output.ts';
import { TripoError, text } from '../studio/contracts/errors.ts';

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const metadata = { forward_axis: '-y', pivot_to_center_bottom: true } as const;
async function prepared() {
  const f = await fixture(),
    data = tinyGlb(),
    root = await realpath(path.join(f.dir, 'output'));
  f.service.config.outputDir = '';
  const counts = { forbidden: 0, source: 0, read: 0, convert: 0 };
  const forbidden = async (): Promise<never> => {
    counts.forbidden++;
    throw Error('No upstream call is allowed');
  };
  const client = new StudioClient(f.service.credentials, forbidden);
  const input = {
    project_id: 'history-project',
    operator_id: 'history-source',
    request_id: 'history-export',
    ...metadata,
    max_credits: 10,
  };
  const runtime: FrontendExportRuntime = {
    source: async () => {
      counts.source++;
      return { url: 'https://cdn.tripo3d.ai/frozen.glb', name: 'Frozen', metadata: {} };
    },
    read: async () => {
      counts.read++;
      return data;
    },
    convert: async () => {
      counts.convert++;
      return { bytes: data, proof: { source_sha256: hash(data), output_sha256: hash(data), metadata } };
    },
  };
  f.gateway.submit = async () => {
    f.gateway.posts++;
    return {
      remote_ids: { project_id: input.project_id, operator_id: input.operator_id },
      status: { state: 'succeeded', progress: 100, artifacts: [] },
    };
  };
  f.gateway.status = forbidden;
  f.gateway.artifactUrl = forbidden;
  const a = path.join(root, 'A.glb'),
    b = path.join(root, 'B.glb'),
    c = path.join(root, 'C.glb');
  const initial = await exportFrontend(f.service, client, { ...input, destination_path: a }, runtime);
  const id = text(initial.job_id),
    originalCounts = { ...counts };
  const frozenRuntime: FrontendExportRuntime = { source: forbidden, read: forbidden, convert: forbidden };
  const run = (destination: string, service = f.service) =>
    exportFrontend(service, client, { ...input, destination_path: destination }, frozenRuntime);
  const artifact = () => f.jobs.get(id).artifacts[0]!;
  const mutate = (change: (value: ReturnType<typeof artifact>) => void) => {
    const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
    try {
      const current = artifact();
      change(current);
      db.prepare('UPDATE jobs SET artifacts=? WHERE job_id=?').run(JSON.stringify([current]), id);
    } finally {
      db.close();
    }
  };
  return { ...f, data, root, a, b, c, id, run, artifact, mutate, originalCounts, counts, forbidden };
}
const fileIdentity = async (file: string) => {
  const stat = await lstat(file);
  return { inode: stat.ino, device: stat.dev, mtime: stat.mtimeMs, sha256: hash(await readFile(file)) };
};
const close = async (f: Awaited<ReturnType<typeof prepared>>) => {
  f.jobs.close();
  await rm(f.dir, { recursive: true, force: true });
};

test('A to B to C survives reopen and standalone original-request replay to every registered path', async () => {
  const f = await prepared();
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await f.service.download(f.id, 'model', f.b);
    await f.service.download(f.id, 'model', f.c);
    const before = f.jobs.get(f.id),
      identities = await Promise.all([f.a, f.b, f.c].map(fileIdentity));
    assert.deepEqual(
      f.artifact().frontend_deliveries?.map((entry) => entry.path),
      [f.a, f.b, f.c],
    );
    assert.equal(f.artifact().local_path, f.c);
    reopened = await fixture(f.dir);
    reopened.service.config.outputDir = '';
    reopened.gateway.submit = f.forbidden;
    reopened.gateway.status = f.forbidden;
    reopened.gateway.artifactUrl = f.forbidden;
    for (const destination of [f.a, f.b, f.c]) {
      const result = await f.run(destination, reopened.service);
      assert.equal(result.job_id, f.id);
      assert.equal(result.local_path, destination);
      assert.equal(result.sha256, hash(f.data));
    }
    assert.deepEqual(await Promise.all([f.a, f.b, f.c].map(fileIdentity)), identities);
    assert.deepEqual(f.jobs.get(f.id), before);
    assert.deepEqual(f.counts, f.originalCounts);
    assert.equal(f.gateway.posts, 1);
  } finally {
    reopened?.jobs.close();
    await close(f);
  }
});

test('concurrent different downloads merge the current transaction registry without losing older paths', async () => {
  const f = await prepared(),
    other = await fixture(f.dir);
  other.service.config.outputDir = '';
  try {
    other.gateway.submit = f.forbidden;
    other.gateway.status = f.forbidden;
    other.gateway.artifactUrl = f.forbidden;
    await Promise.all([f.service.download(f.id, 'model', f.b), other.service.download(f.id, 'model', f.c)]);
    assert.deepEqual(
      f
        .artifact()
        .frontend_deliveries?.map((entry) => entry.path)
        .sort(),
      [f.a, f.b, f.c].sort(),
    );
    for (const destination of [f.a, f.b, f.c]) assert.equal((await f.run(destination)).job_id, f.id);
    assert.equal(f.gateway.posts, 1);
    assert.equal(other.gateway.posts, 0);
    assert.equal(f.counts.forbidden, 0);
  } finally {
    other.jobs.close();
    await close(f);
  }
});

test('unregistered copies, hardlinks and final symlinks remain ineligible even when every byte matches', async () => {
  const f = await prepared();
  try {
    await f.service.download(f.id, 'model', f.b);
    const copy = path.join(f.root, 'copy.glb'),
      hard = path.join(f.root, 'hard.glb'),
      symbolic = path.join(f.root, 'symbolic.glb');
    await copyFile(f.a, copy);
    await link(f.a, hard);
    await symlink(f.a, symbolic);
    for (const destination of [copy, hard, symbolic])
      await assert.rejects(f.run(destination), { code: 'OUTPUT_EXISTS' });
    assert.deepEqual(
      f.artifact().frontend_deliveries?.map((entry) => entry.path),
      [f.a, f.b],
    );
    assert.equal((await lstat(symbolic)).isSymbolicLink(), true);
    assert.deepEqual(await readFile(copy), f.data);
    assert.equal(f.counts.forbidden, 0);
    assert.equal(f.gateway.posts, 1);
  } finally {
    await close(f);
  }
});

test('an equal-byte replacement inode is rejected, but an empty registered path may be freshly published', async () => {
  const f = await prepared();
  try {
    await f.service.download(f.id, 'model', f.b);
    const before = f.artifact().frontend_deliveries!.find((entry) => entry.path === f.a)!;
    const aside = path.join(f.root, 'kept-original.glb');
    await rename(f.a, aside);
    await writeFile(f.a, f.data);
    assert.notEqual((await lstat(f.a)).ino, Number(before.inode));
    await assert.rejects(f.run(f.a), { code: 'OUTPUT_EXISTS' });
    assert.equal(f.artifact().frontend_deliveries!.find((entry) => entry.path === f.a)!.inode, before.inode);
    await rm(f.a);
    const republished = await f.run(f.a);
    assert.equal(republished.job_id, f.id);
    const after = f.artifact().frontend_deliveries!.find((entry) => entry.path === f.a)!;
    assert.notEqual(after.inode, before.inode);
    assert.equal(after.inode, String((await lstat(f.a)).ino));
    assert.equal(f.artifact().frontend_deliveries!.length, 2);
    assert.deepEqual(await readFile(aside), f.data);
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.counts.forbidden, 0);
  } finally {
    await close(f);
  }
});

test('legacy migration retains only its verified current local_path and never revives an orphaned original', async () => {
  for (const state of ['valid', 'missing', 'corrupt']) {
    const f = await prepared();
    try {
      await f.service.download(f.id, 'model', f.b);
      f.mutate((artifact) => {
        delete artifact.frontend_deliveries;
      });
      if (state === 'missing') await rm(f.b);
      if (state === 'corrupt') await writeFile(f.b, Buffer.alloc(f.data.length));
      await assert.rejects(f.run(f.a), { code: 'OUTPUT_EXISTS' });
      await f.service.download(f.id, 'model', f.c);
      assert.deepEqual(
        f.artifact().frontend_deliveries?.map((entry) => entry.path),
        state === 'valid' ? [f.b, f.c] : [f.c],
      );
      if (state === 'valid') assert.equal((await f.run(f.b)).job_id, f.id);
      else {
        if (state === 'missing') await copyFile(f.a, f.b);
        await assert.rejects(f.run(f.b), { code: 'OUTPUT_EXISTS' });
      }
      await assert.rejects(f.run(f.a), { code: 'OUTPUT_EXISTS' });
      assert.deepEqual(await readFile(f.a), f.data);
      assert.equal(f.gateway.posts, 1);
      assert.equal(f.counts.forbidden, 0);
    } finally {
      await close(f);
    }
  }
});

test('caller-supplied history cannot add an existing file or remove trusted prior entries', async () => {
  const f = await prepared();
  try {
    await f.service.download(f.id, 'model', f.b);
    const saved = f.artifact(),
      copy = path.join(f.root, 'unregistered.glb');
    await copyFile(f.a, copy);
    f.jobs.saveArtifact(f.id, {
      ...saved,
      frontend_deliveries: [{ ...saved.frontend_deliveries![0]!, path: copy }],
    });
    assert.deepEqual(
      f.artifact().frontend_deliveries?.map((entry) => entry.path),
      [f.a, f.b],
    );
    await assert.rejects(f.run(copy), { code: 'OUTPUT_EXISTS' });
    f.jobs.saveArtifact(f.id, { ...saved, frontend_deliveries: [] });
    assert.deepEqual(
      f.artifact().frontend_deliveries?.map((entry) => entry.path),
      [f.a, f.b],
    );
    assert.equal(f.gateway.posts, 1);
  } finally {
    await close(f);
  }
});

test('parent replacement, file corruption and FIFO cannot reuse an earlier registered path', async () => {
  const f = await prepared();
  try {
    const directory = path.join(f.root, 'original-dir');
    await mkdir(directory);
    const target = path.join(directory, 'model.glb');
    await f.service.download(f.id, 'model', target);
    const moved = path.join(f.root, 'moved-dir');
    await rename(directory, moved);
    await mkdir(directory);
    await rename(path.join(moved, 'model.glb'), target);
    await assert.rejects(f.run(target), { code: 'OUTPUT_EXISTS' });
    await writeFile(f.a, Buffer.alloc(f.data.length));
    await assert.rejects(f.run(f.a), { code: 'OUTPUT_EXISTS' });
    if (process.platform !== 'win32') {
      await rm(f.a);
      execFileSync('mkfifo', [f.a]);
      const before = performance.now();
      await assert.rejects(f.run(f.a), { code: 'OUTPUT_EXISTS' });
      assert(performance.now() - before < 1000);
      assert.equal((await lstat(f.a)).isFIFO(), true);
    }
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.counts.forbidden, 0);
  } finally {
    await close(f);
  }
});

test('old registered paths still require the current complete output proof on every reuse', async () => {
  const f = await prepared();
  try {
    await f.service.download(f.id, 'model', f.b);
    const before = await fileIdentity(f.a),
      original = f.jobs.requestPolicy.bind(f.jobs),
      job = f.jobs.get(f.id);
    f.jobs.requestPolicy = (account, key) => {
      const policy = original(account, key);
      return key === frontendOutputKey(job) && policy
        ? { ...policy, source_fingerprint: '0'.repeat(64) }
        : policy;
    };
    await assert.rejects(
      f.run(f.a),
      (error: unknown) => error instanceof TripoError && error.code === 'FRONTEND_OUTPUT_IDENTITY_CHANGED',
    );
    assert.deepEqual(await fileIdentity(f.a), before);
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.counts.forbidden, 0);
  } finally {
    await close(f);
  }
});
