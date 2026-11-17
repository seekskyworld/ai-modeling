/** 素材目的地由每次调用指定；可选的服务配置只收紧范围，不替调用方选择项目目录。 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { TripoError } from '../../studio/contracts/errors.ts';

export async function resolveDestination(
  configuredRoot: string,
  requested: string,
): Promise<{ root: string; relative: string }> {
  if (!requested || requested.includes('\0'))
    throw new TripoError('OUTPUT_PATH_DENIED', 'Specify a destination path for this download.');
  if (configuredRoot)
    return {
      root: configuredRoot,
      relative: path.isAbsolute(requested) ? path.relative(configuredRoot, requested) : requested,
    };
  if (!path.isAbsolute(requested))
    throw new TripoError(
      'DESTINATION_REQUIRED',
      'Use an absolute destination_path, or configure an optional AI_MODELING_OUTPUT_DIR for relative paths.',
    );
  const root = path.dirname(path.resolve(requested));
  await mkdir(root, { recursive: true, mode: 0o700 });
  return { root, relative: path.basename(requested) };
}
