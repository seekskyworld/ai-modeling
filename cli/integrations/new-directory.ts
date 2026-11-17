/** Reserve a new export directory; rollback removes only entries created by this invocation. */
import { lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TripoError } from '../../studio/contracts/errors.ts';

interface OwnedEntry {
  location: string;
  kind: 'directory' | 'file';
  dev: bigint;
  ino: bigint;
}

async function identity(location: string) {
  try {
    return await lstat(location, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function matches(entry: OwnedEntry): Promise<boolean> {
  const current = await identity(entry.location);
  return Boolean(
    current &&
    !current.isSymbolicLink() &&
    (entry.kind === 'directory' ? current.isDirectory() : current.isFile()) &&
    current.dev === entry.dev &&
    current.ino === entry.ino,
  );
}

function validRelative(filename: string): boolean {
  return filename.split('/').every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
}

export async function writeNewDirectory(
  requested: string,
  files: { relative: string; content: string }[],
  packageRoot: string,
): Promise<string> {
  if (
    !requested?.trim() ||
    /[\0\r\n]/.test(requested) ||
    !files.length ||
    files.some((file) => !validRelative(file.relative))
  )
    throw new TripoError(
      'INVALID_INPUT',
      'Choose a new output directory and safe relative export filenames.',
      'not_submitted',
    );
  const selected = path.resolve(requested);
  let parent: string;
  try {
    parent = await realpath(path.dirname(selected));
  } catch {
    throw new TripoError('INVALID_OUTPUT', 'The output parent must already exist.', 'not_submitted');
  }
  const parentInfo = await identity(parent);
  if (!parentInfo?.isDirectory())
    throw new TripoError('INVALID_OUTPUT', 'The output parent must be a directory.', 'not_submitted');
  const output = path.join(parent, path.basename(selected));
  const source = await realpath(packageRoot);
  if (output === source || output.startsWith(source + path.sep))
    throw new TripoError(
      'INVALID_OUTPUT',
      'Choose an output directory outside the ai-modeling installation.',
      'not_submitted',
    );
  if (await identity(output))
    throw new TripoError(
      'OUTPUT_EXISTS',
      'The output path already exists; choose a new directory.',
      'not_submitted',
    );
  const parentEntry: OwnedEntry = {
    location: parent,
    kind: 'directory',
    dev: parentInfo.dev,
    ino: parentInfo.ino,
  };
  const owned: OwnedEntry[] = [];
  const verifyParents = async () => {
    if (!(await matches(parentEntry)) || (await realpath(path.dirname(selected)).catch(() => '')) !== parent)
      throw new TripoError('OUTPUT_CHANGED', 'The output parent changed during export.', 'not_submitted');
    for (const entry of owned.filter((entry) => entry.kind === 'directory'))
      if (!(await matches(entry)))
        throw new TripoError('OUTPUT_CHANGED', 'An output directory changed during export.', 'not_submitted');
  };
  const createDirectory = async (location: string) => {
    await verifyParents();
    await mkdir(location, { mode: 0o700 });
    const created = await identity(location);
    if (!created?.isDirectory() || created.isSymbolicLink())
      throw new TripoError(
        'OUTPUT_CHANGED',
        'An output directory changed while being created.',
        'not_submitted',
      );
    owned.push({ location, kind: 'directory', dev: created.dev, ino: created.ino });
  };
  try {
    await createDirectory(output);
    for (const file of files) {
      const parts = file.relative.split('/');
      let directory = output;
      for (const part of parts.slice(0, -1)) {
        directory = path.join(directory, part);
        if (!owned.some((entry) => entry.kind === 'directory' && entry.location === directory))
          await createDirectory(directory);
      }
      await verifyParents();
      const filename = path.join(output, ...parts);
      const handle = await open(filename, 'wx', 0o600);
      try {
        const created = await handle.stat({ bigint: true });
        owned.push({ location: filename, kind: 'file', dev: created.dev, ino: created.ino });
        await handle.writeFile(file.content, 'utf8');
      } finally {
        await handle.close();
      }
    }
    await verifyParents();
    for (const entry of owned)
      if (!(await matches(entry)))
        throw new TripoError('OUTPUT_CHANGED', 'An exported file changed during export.', 'not_submitted');
    return output;
  } catch (error) {
    await rollback(owned);
    if (error instanceof TripoError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new TripoError(
        'OUTPUT_EXISTS',
        'An output path already exists; no existing file was overwritten.',
        'not_submitted',
      );
    throw new TripoError(
      'EXPORT_FAILED',
      'Plugin export failed; inspect the selected output directory before retrying.',
      'not_submitted',
    );
  }
}

async function rollback(owned: OwnedEntry[]): Promise<void> {
  const directories = owned.filter((entry) => entry.kind === 'directory');
  for (const entry of [...owned].reverse()) {
    try {
      const ancestors = directories.filter((directory) =>
        entry.location.startsWith(directory.location + path.sep),
      );
      if (!(await matches(entry)) || !(await Promise.all(ancestors.map(matches))).every(Boolean)) continue;
      if (entry.kind === 'file') await unlink(entry.location);
      else await rmdir(entry.location); // A concurrently added file keeps its containing directory intact.
    } catch {
      // Preserve anything whose identity or contents cannot be established safely.
    }
  }
}
