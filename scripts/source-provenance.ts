/** Fingerprint public build inputs and require an independent, tracked Git root for release identity. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const directories = new Set([
  'cli',
  'mcp',
  'studio',
  'scripts',
  'tests',
  'docs',
  'examples',
  'skills',
  'assets',
  '.github',
]);
const rootFiles = new Set([
  'package.json',
  'package-lock.json',
  'version.ts',
  'tsconfig.json',
  'tsconfig.build.json',
  'eslint.config.mjs',
  '.prettierrc.json',
  '.prettierignore',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.env.example',
  'LICENSE',
  'NOTICE',
]);

async function inputs(root: string, relative = ''): Promise<string[]> {
  const files: string[] = [];
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (item.name === '.DS_Store' || item.name === '__pycache__' || item.name.endsWith('.pyc')) continue;
    if (!relative && !directories.has(item.name) && !rootFiles.has(item.name) && !item.name.endsWith('.md'))
      continue;
    const filename = relative ? `${relative}/${item.name}` : item.name;
    if (item.isSymbolicLink())
      throw new Error(
        `Public source input must be a regular file or real directory, not a symlink: ${filename}`,
      );
    if (item.isDirectory()) files.push(...(await inputs(root, filename)));
    else if (item.isFile()) files.push(filename);
    else throw new Error(`Public source input is not a regular file: ${filename}`);
  }
  return files.sort();
}

export async function sourceProvenance(root: string) {
  const actual = await realpath(root);
  const files = await inputs(actual);
  const hash = createHash('sha256');
  for (const file of files) {
    const filename = path.join(actual, file);
    const before = await lstat(filename);
    const handle = await open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || before.ino !== opened.ino || before.dev !== opened.dev)
        throw new Error(`Public source input changed: ${file}`);
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size)
        throw new Error(`Public source input changed: ${file}`);
      hash.update(`${file}\0${bytes.length}\0`).update(bytes);
    } finally {
      await handle.close();
    }
  }
  let source_commit: string | null = null;
  let source_dirty: boolean | null = null;
  let source_tracked = false;
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: actual,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  try {
    if ((await realpath(git(['rev-parse', '--show-toplevel']).trim())) === actual) {
      const commit = git(['rev-parse', 'HEAD']).trim();
      const tracked = new Set(git(['ls-files', '--cached', '-z']).split('\0'));
      const dirty = Boolean(git(['status', '--porcelain', '--untracked-files=all']).trim());
      if (git(['rev-parse', 'HEAD']).trim() === commit) {
        source_commit = commit;
        source_dirty = dirty;
        source_tracked = files.length > 0 && files.every((file) => tracked.has(file));
      }
    }
  } catch {
    /* Source archives and unrelated parent repositories do not identify this project. */
  }
  return { source_commit, source_dirty, source_tracked, source_files_sha256: hash.digest('hex') };
}
