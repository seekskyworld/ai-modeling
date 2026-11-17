/** Install only bundled guidance; never initialize account, task or credential services. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lockSync } from 'proper-lockfile';
import { VERSION } from '../../version.ts';
import { object, TripoError } from '../../studio/contracts/errors.ts';
import { resolveSkillLocation, type SkillLocation, type SkillOptions } from './targets.ts';
export type { SkillOptions } from './targets.ts';

const manifestName = '.ai-modeling-install.json';
const maxFiles = 256;
const maxFileBytes = 2 * 1024 * 1024;
const maxTotalBytes = 16 * 1024 * 1024;
const packageRoot = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? '../../' : '../../../', import.meta.url),
);
type Identity = { dev: bigint; ino: bigint };
type FileRecord = { path: string; sha256: string; bytes: number };
type Manifest = { schema_version: 1; package: 'ai-modeling'; version: string; files: FileRecord[] };
type Conflict = { path: string; reason: string };
type Location = SkillLocation & { parent: string; directory: string };
type Tree = { files: Map<string, Buffer>; directories: string[] };
type Installation = {
  status: 'not_installed' | 'installed' | 'unmanaged' | 'modified';
  manifest?: Manifest;
  identity?: Identity;
  conflicts: Conflict[];
};

function missing(error: unknown): boolean {
  return object(error).code === 'ENOENT';
}

function identity(file: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function conflict(message: string, details: Record<string, unknown> = {}): never {
  throw new TripoError('SKILL_INSTALL_CONFLICT', message, 'not_submitted', details);
}

function validRelative(file: string): boolean {
  return (
    file.length > 0 &&
    file.length <= 512 &&
    !/[\\:]/.test(file) &&
    ![...file].some((character) => character.charCodeAt(0) < 32) &&
    !path.posix.isAbsolute(file) &&
    file.split('/').every((part) => part && part !== '.' && part !== '..' && !/[. ]$/.test(part))
  );
}

function readRegular(file: string): Buffer {
  const before = identity(file);
  if (!before?.isFile() || before.isSymbolicLink() || before.size > BigInt(maxFileBytes))
    conflict('Skill content must be a bounded regular file.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(before, opened) || before.size !== opened.size)
      conflict('Skill file changed while opening.');
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = identity(file);
    if (
      !current ||
      !sameIdentity(before, current) ||
      !sameIdentity(before, after) ||
      BigInt(length) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      conflict('Skill file changed while reading.');
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}

function readTree(root: string): Tree {
  const tree: Tree = { files: new Map(), directories: [] };
  let total = 0;
  function visit(relative: string): void {
    const directory = path.join(root, relative);
    const before = identity(directory);
    if (!before?.isDirectory() || before.isSymbolicLink()) conflict('Skill directory must not be a symlink.');
    for (const name of fs.readdirSync(directory).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      if (!validRelative(child)) conflict('Skill content contains an unsafe path.', { file: child });
      const info = identity(path.join(root, child));
      if (!info || info.isSymbolicLink())
        conflict('Skill content changed or contains a symlink.', { file: child });
      if (info.isDirectory()) {
        if (tree.directories.length >= maxFiles || child.split('/').length > 16)
          conflict('Skill content exceeds directory limits.');
        tree.directories.push(child);
        visit(child);
      } else {
        if (tree.files.size >= maxFiles) conflict('Skill content exceeds file limits.');
        const bytes = readRegular(path.join(root, child));
        total += bytes.length;
        if (total > maxTotalBytes) conflict('Skill content exceeds size limits.');
        tree.files.set(child, bytes);
      }
    }
    const after = identity(directory);
    if (!after || !sameIdentity(before, after) || before.mtimeNs !== after.mtimeNs)
      conflict('Skill directory changed while reading.');
  }
  visit('');
  return tree;
}

function records(files: Map<string, Buffer>): FileRecord[] {
  return [...files]
    .map(([file, bytes]) => ({
      path: file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function parseManifest(bytes: Buffer): Manifest {
  const value = object(JSON.parse(bytes.toString('utf8')));
  if (
    value.schema_version !== 1 ||
    value.package !== 'ai-modeling' ||
    typeof value.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][\da-zA-Z.-]+)?$/.test(value.version) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length >= maxFiles
  )
    conflict('Skill installation manifest is invalid.');
  const seen = new Set<string>();
  const files = value.files.map((item) => {
    const file = object(item);
    if (
      typeof file.path !== 'string' ||
      !validRelative(file.path) ||
      file.path === manifestName ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.bytes !== 'number' ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > maxFileBytes
    )
      conflict('Skill installation manifest contains an unsafe entry.');
    const key = file.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) conflict('Skill installation manifest contains duplicate paths.');
    seen.add(key);
    return { path: file.path, sha256: file.sha256, bytes: file.bytes };
  });
  if (!seen.has('skill.md') || !seen.has('license')) conflict('Skill installation manifest is incomplete.');
  return { schema_version: 1, package: 'ai-modeling', version: value.version, files };
}

function compareTree(tree: Tree, manifest: Manifest): Conflict[] {
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const directories = new Set<string>();
  for (const file of manifest.files) {
    const parts = file.path.split('/');
    while (parts.length > 1) {
      parts.pop();
      directories.add(parts.join('/'));
    }
  }
  const conflicts: Conflict[] = [];
  for (const file of records(tree.files)) {
    if (file.path === manifestName) continue;
    const original = expected.get(file.path);
    if (!original) conflicts.push({ path: file.path, reason: 'added' });
    else if (file.sha256 !== original.sha256 || file.bytes !== original.bytes)
      conflicts.push({ path: file.path, reason: 'changed' });
    expected.delete(file.path);
  }
  for (const file of expected.keys()) conflicts.push({ path: file, reason: 'missing' });
  for (const directory of tree.directories)
    if (!directories.has(directory)) conflicts.push({ path: directory, reason: 'added_directory' });
  return conflicts;
}

function inspect(directory: string): Installation {
  const root = identity(directory);
  if (!root) return { status: 'not_installed', conflicts: [] };
  if (!root.isDirectory() || root.isSymbolicLink())
    return { status: 'modified', conflicts: [{ path: '.', reason: 'unsafe_directory' }] };
  if (!identity(path.join(directory, manifestName)))
    return {
      status: 'unmanaged',
      identity: root,
      conflicts: [{ path: manifestName, reason: 'not_managed' }],
    };
  try {
    const manifestBytes = readRegular(path.join(directory, manifestName));
    const manifest = parseManifest(manifestBytes);
    const tree = readTree(directory);
    if (!tree.files.get(manifestName)?.equals(manifestBytes))
      conflict('Skill manifest changed while reading.');
    const conflicts = compareTree(tree, manifest);
    return { status: conflicts.length ? 'modified' : 'installed', manifest, identity: root, conflicts };
  } catch (error) {
    return {
      status: 'modified',
      identity: root,
      conflicts: [
        {
          path: '.',
          reason: error instanceof SyntaxError ? 'invalid_manifest' : 'unsafe_or_changed_content',
        },
      ],
    };
  }
}

function location(options: SkillOptions): Location {
  const selected = resolveSkillLocation(options);
  if (selected.projectDirectory) {
    const project = identity(selected.projectDirectory);
    if (!project?.isDirectory() || project.isSymbolicLink())
      conflict('--project-dir must name an existing real project directory.');
  }
  return {
    ...selected,
    parent: selected.requestedParent,
    directory: path.join(selected.requestedParent, 'ai-modeling'),
  };
}

function prepareParent(requested: string, create: boolean): string | undefined {
  const info = identity(requested);
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()) conflict('The Skill parent must be a real directory.');
    return fs.realpathSync(requested);
  }
  if (!create) return;
  const parent = prepareParent(path.dirname(requested), true)!;
  const canonical = path.join(parent, path.basename(requested));
  try {
    fs.mkdirSync(canonical, { mode: 0o755 });
  } catch (error) {
    if (object(error).code !== 'EEXIST') throw error;
  }
  const created = identity(canonical);
  if (!created?.isDirectory() || created.isSymbolicLink())
    conflict('The Skill parent changed during creation.');
  return canonical;
}

function resolvedLocation(selected: Location, create: boolean): Location {
  const parent = prepareParent(selected.requestedParent, create);
  return parent ? { ...selected, parent, directory: path.join(parent, 'ai-modeling') } : selected;
}

function requireUnmodified(current: Installation): void {
  if (current.status === 'modified' || current.status === 'unmanaged')
    conflict(
      'Existing Skill files are unmanaged or changed; preserve them and resolve conflicts before retrying.',
      { conflicts: current.conflicts },
    );
}

function result(action: string, selected: Location, current: Installation, status: string = current.status) {
  return {
    action,
    target: selected.target,
    scope: selected.scope,
    project_directory: selected.projectDirectory,
    directory: selected.directory,
    status,
    managed: current.status === 'installed',
    installed_version: current.manifest?.version ?? null,
    bundled_version: VERSION,
    file_count: current.manifest?.files.length ?? 0,
    conflicts: current.conflicts,
  };
}

function withLock<T>(selected: Location, run: (verifyParent: () => void) => T): T {
  const before = identity(selected.parent)!;
  const verifyParent = () => {
    const current = identity(selected.parent);
    const requested = identity(selected.requestedParent);
    if (
      !current ||
      !sameIdentity(before, current) ||
      !requested?.isDirectory() ||
      requested.isSymbolicLink() ||
      fs.realpathSync(selected.requestedParent) !== selected.parent
    )
      conflict('The Skill parent changed during the operation.');
  };
  verifyParent();
  let release: () => void;
  try {
    release = lockSync(selected.directory, {
      realpath: false,
      stale: 120000,
      retries: 0,
      lockfilePath: path.join(selected.parent, '.ai-modeling-skill.lock'),
    });
  } catch {
    throw new TripoError(
      'SKILL_INSTALL_BUSY',
      'Another Skill installation operation is active. Retry after it finishes.',
      'not_submitted',
    );
  }
  try {
    verifyParent();
    return run(verifyParent);
  } finally {
    release();
  }
}

function bundle(): { files: Map<string, Buffer>; manifest: Manifest } {
  const tree = readTree(path.join(packageRoot, 'skills', 'ai-modeling'));
  if (!tree.files.has('SKILL.md') || tree.files.has(manifestName))
    conflict('Bundled Skill content is invalid.');
  const license = readRegular(path.join(packageRoot, 'LICENSE'));
  if (tree.files.has('LICENSE') && !tree.files.get('LICENSE')!.equals(license))
    conflict('Bundled Skill license differs from the package.');
  tree.files.set('LICENSE', license);
  const manifest: Manifest = {
    schema_version: 1,
    package: 'ai-modeling',
    version: VERSION,
    files: records(tree.files),
  };
  parseManifest(Buffer.from(JSON.stringify(manifest)));
  return { files: tree.files, manifest };
}

function unchanged(directory: string, original: Installation): void {
  const current = inspect(directory);
  requireUnmodified(current);
  if (
    current.status !== original.status ||
    (original.identity && (!current.identity || !sameIdentity(original.identity, current.identity))) ||
    JSON.stringify(current.manifest) !== JSON.stringify(original.manifest)
  )
    conflict('The installed Skill changed during the operation.');
}

function writeBundle(directory: string, source: ReturnType<typeof bundle>): void {
  fs.mkdirSync(directory, { mode: 0o755 });
  for (const [relative, bytes] of source.files) {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o644 });
  }
  fs.writeFileSync(path.join(directory, manifestName), JSON.stringify(source.manifest, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}

function transaction(
  selected: Location,
  original: Installation,
  verifyParent: () => void,
  source?: ReturnType<typeof bundle>,
): void {
  const temporary = fs.mkdtempSync(path.join(selected.parent, '.ai-modeling-skill-'));
  const previous = path.join(temporary, 'previous');
  const next = path.join(temporary, 'next');
  let moved = false;
  let published = false;
  let preserve = false;
  try {
    if (source) writeBundle(next, source);
    verifyParent();
    unchanged(selected.directory, original);
    if (original.status === 'installed') {
      fs.renameSync(selected.directory, previous);
      moved = true;
      unchanged(previous, original);
    }
    verifyParent();
    if (identity(selected.directory)) conflict('The Skill destination was created concurrently.');
    if (source) {
      fs.renameSync(next, selected.directory);
      published = true;
    }
    if (moved) {
      unchanged(previous, original);
      fs.rmSync(previous, { recursive: true });
      moved = false;
    }
  } catch (error) {
    try {
      verifyParent();
      if (moved) {
        if (published) {
          const installed = inspect(selected.directory);
          if (
            installed.status !== 'installed' ||
            JSON.stringify(installed.manifest) !== JSON.stringify(source?.manifest)
          )
            conflict('The newly installed Skill changed before rollback.');
          fs.renameSync(selected.directory, next);
        }
        if (identity(selected.directory)) conflict('The destination is occupied during rollback.');
        fs.renameSync(previous, selected.directory);
      }
    } catch {
      preserve = true;
      conflict(
        'A concurrent filesystem change blocked rollback; recover the preserved transaction before retrying.',
        { recovery_directory: temporary },
      );
    }
    throw error;
  } finally {
    if (!preserve) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function statusSkill(options: SkillOptions = {}) {
  const selected = resolvedLocation(location(options), false);
  return result('status', selected, inspect(selected.directory));
}

export function installSkill(options: SkillOptions = {}) {
  const selectedInput = location(options);
  const source = bundle();
  const selected = resolvedLocation(selectedInput, true);
  return withLock(selected, (verifyParent) => {
    const current = inspect(selected.directory);
    requireUnmodified(current);
    if (JSON.stringify(current.manifest) === JSON.stringify(source.manifest))
      return result('install', selected, current, 'current');
    transaction(selected, current, verifyParent, source);
    const installed = inspect(selected.directory);
    if (
      installed.status !== 'installed' ||
      JSON.stringify(installed.manifest) !== JSON.stringify(source.manifest)
    )
      conflict('The Skill changed after installation; inspect its status before retrying.');
    return result('install', selected, installed, current.status === 'installed' ? 'updated' : 'installed');
  });
}

export function uninstallSkill(options: SkillOptions = {}) {
  const selected = resolvedLocation(location(options), false);
  if (!identity(selected.parent))
    return result('uninstall', selected, { status: 'not_installed', conflicts: [] });
  return withLock(selected, (verifyParent) => {
    const current = inspect(selected.directory);
    requireUnmodified(current);
    if (current.status === 'not_installed') return result('uninstall', selected, current);
    transaction(selected, current, verifyParent);
    return result('uninstall', selected, { status: 'not_installed', conflicts: [] }, 'uninstalled');
  });
}
