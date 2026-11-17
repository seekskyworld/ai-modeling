/** 登记由最终保存事务维护；读取原文件描述符，不能凭同字节接纳任意现存路径。 */
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Artifact, FrontendDeliveryLocation } from '../../studio/contracts/types.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

function invalid(): never {
  throw new TripoError(
    'FRONTEND_OUTPUT_IDENTITY_CHANGED',
    'The registered frontend delivery locations differ from their original output proof.',
    'read',
  );
}
function registered(
  artifact: Artifact,
  identity: string,
  formats: readonly string[] = ['glb', 'png'],
): FrontendDeliveryLocation[] {
  if (artifact.frontend_deliveries === undefined) return [];
  if (!Array.isArray(artifact.frontend_deliveries)) return invalid();
  const seen = new Set<string>();
  for (const entry of artifact.frontend_deliveries) {
    if (
      !entry ||
      entry.identity !== identity ||
      entry.sha256 !== artifact.sha256 ||
      entry.bytes !== artifact.bytes ||
      typeof entry.path !== 'string' ||
      !path.isAbsolute(entry.path) ||
      path.normalize(entry.path) !== entry.path ||
      !formats.includes(artifact.format) ||
      path.extname(entry.path).toLowerCase() !== '.' + artifact.format ||
      ![entry.device, entry.inode, entry.parent_device, entry.parent_inode].every(
        (value) => typeof value === 'string' && /^\d+$/.test(value),
      ) ||
      seen.has(entry.path)
    )
      return invalid();
    seen.add(entry.path);
  }
  return artifact.frontend_deliveries;
}
function canonicalLocation(location: string | undefined): string | undefined {
  if (typeof location !== 'string' || !path.isAbsolute(location)) return;
  try {
    return path.join(realpathSync(path.dirname(location)), path.basename(location));
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code)))
      throw error;
  }
}
function sameNode(expected: BigIntStats, actual: BigIntStats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}
function sameFile(expected: BigIntStats, actual: BigIntStats): boolean {
  return (
    actual.isFile() &&
    sameNode(expected, actual) &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs
  );
}
/** 同步核验使发布路径与保存事务之间没有新的await；O_NONBLOCK阻止换入FIFO造成阻塞。 */
function inspect(
  artifact: Artifact,
  location: string | undefined,
  identity: string,
): FrontendDeliveryLocation | undefined {
  const target = canonicalLocation(location);
  if (!target || !artifact.sha256 || !artifact.bytes) return;
  let fd: number | undefined;
  try {
    const parent = path.dirname(target),
      directory = lstatSync(parent, { bigint: true }),
      before = lstatSync(target, { bigint: true });
    if (!directory.isDirectory() || !before.isFile()) return;
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      !sameNode(before, stat) ||
      stat.size !== BigInt(artifact.bytes) ||
      stat.size > 300n * 1024n * 1024n
    )
      return;
    const data = readFileSync(fd),
      after = lstatSync(target, { bigint: true }),
      parentAfter = lstatSync(parent, { bigint: true });
    if (
      createHash('sha256').update(data).digest('hex') !== artifact.sha256 ||
      !sameFile(stat, after) ||
      !parentAfter.isDirectory() ||
      !sameNode(directory, parentAfter) ||
      canonicalLocation(location) !== target
    )
      return;
    return {
      identity,
      path: target,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      parent_device: directory.dev.toString(),
      parent_inode: directory.ino.toString(),
    };
  } catch (error) {
    if (
      !['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EISDIR'].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    )
      throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function registeredFrontendTarget(
  artifact: Artifact,
  target: string,
  identity: string,
  formats?: readonly string[],
): boolean {
  const entries = registered(artifact, identity, formats),
    saved = entries.find((entry) => entry.path === target);
  // 旧版仅有local_path时仍认可那个当前位置，绝不扫描或回填已丢失的历史文件。
  if (
    !saved &&
    (artifact.frontend_deliveries !== undefined || canonicalLocation(artifact.local_path) !== target)
  )
    return false;
  const actual = inspect(artifact, target, identity);
  return Boolean(
    actual &&
    (!saved ||
      (actual.device === saved.device &&
        actual.inode === saved.inode &&
        actual.parent_device === saved.parent_device &&
        actual.parent_inode === saved.parent_inode)),
  );
}
/** 只合并数据库current与本次实际交付；调用方附带的历史列表一律不作为登记来源。 */
export function retainFrontendDeliveries(
  current: Artifact | undefined,
  next: Artifact,
  identity: string,
  formats?: readonly string[],
): Artifact {
  const locations = new Map(
    (current ? registered(current, identity, formats) : []).map((entry) => [entry.path, entry]),
  );
  const previous =
    current?.frontend_deliveries === undefined && current
      ? inspect(current, current.local_path, identity)
      : undefined;
  if (previous && !locations.has(previous.path)) locations.set(previous.path, previous);
  if (next.local_path) {
    const published = inspect(next, next.local_path, identity);
    if (!published)
      throw new TripoError(
        'FRONTEND_OUTPUT_CONTENT_CHANGED',
        'The published frontend file changed before its delivery location could be saved.',
        'read',
      );
    locations.set(published.path, published);
  }
  const saved = { ...next };
  delete saved.frontend_deliveries;
  if (locations.size) saved.frontend_deliveries = [...locations.values()];
  return saved;
}
