/** Image processing loads its native runtime only when an operation actually needs pixels. */
import { createRequire } from 'node:module';
import type Sharp from 'sharp';
import type { SharpOptions } from 'sharp';
import { TripoError } from '../../studio/contracts/errors.ts';
import { PACKAGE_NAME } from '../../version.ts';

const require = createRequire(import.meta.url);
let runtime: typeof Sharp | undefined;

/** Keep the callable API used by this project; returned pipelines are real Sharp instances. */
export default function sharp(options?: SharpOptions): ReturnType<typeof Sharp>;
export default function sharp(...args: Parameters<typeof Sharp>): ReturnType<typeof Sharp>;
export default function sharp(
  ...args: [options?: SharpOptions] | Parameters<typeof Sharp>
): ReturnType<typeof Sharp> {
  if (!runtime) {
    try {
      runtime = require('sharp') as typeof Sharp;
      if (typeof runtime !== 'function') throw new Error('Invalid image runtime.');
    } catch {
      runtime = undefined;
      throw new TripoError(
        'IMAGE_RUNTIME_UNAVAILABLE',
        `The local image runtime is unavailable. Reinstall ${PACKAGE_NAME} with optional dependencies enabled on this platform, then retry the original operation; do not regenerate completed work.`,
        'read',
      );
    }
  }
  return Reflect.apply(runtime, undefined, args) as ReturnType<typeof Sharp>;
}
