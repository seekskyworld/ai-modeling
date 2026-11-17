/** Download a pinned, checksum-verified actionlint; never execute unverified bytes. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '1.7.12';
const digests: Record<string, string> = {
  linux_x64: '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
  linux_arm64: '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
  darwin_x64: '5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644',
  darwin_arm64: 'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f',
};
const platform = `${process.platform}_${process.arch}`;
const expected = digests[platform];
if (!expected) throw new Error('Run actionlint on a supported Linux or macOS runner.');
if (process.argv.length > 2) throw new Error('actionlint accepts no custom download location or executable.');
const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
const filename = `actionlint_${version}_${process.platform}_${architecture}.tar.gz`;
const response = await fetch(
  `https://github.com/rhysd/actionlint/releases/download/v${version}/${filename}`,
  {
    credentials: 'omit',
    signal: AbortSignal.timeout(120000),
  },
);
if (!response.ok || !response.body) throw new Error(`actionlint download failed: HTTP ${response.status}.`);
const reader = response.body.getReader();
const chunks: Uint8Array[] = [];
let size = 0;
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 32 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('actionlint download exceeds the expected bounded size.');
    }
    chunks.push(value);
  }
} finally {
  reader.releaseLock();
}
const archive = Buffer.concat(chunks);
if (createHash('sha256').update(archive).digest('hex') !== expected)
  throw new Error('actionlint archive checksum mismatch; nothing was extracted or executed.');
const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-actionlint-'));
try {
  const archivePath = path.join(directory, filename);
  await writeFile(archivePath, archive, { flag: 'wx' });
  execFileSync('tar', ['-xzf', archivePath, '-C', directory, 'actionlint'], { stdio: 'pipe' });
  const root = fileURLToPath(new URL('../', import.meta.url));
  const workflows = (await readdir(path.join(root, '.github/workflows')))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => path.join('.github/workflows', name));
  if (!workflows.length) throw new Error('No workflow definitions found.');
  execFileSync(path.join(directory, 'actionlint'), ['-shellcheck=', '-pyflakes=', ...workflows], {
    cwd: root,
    stdio: 'inherit',
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
