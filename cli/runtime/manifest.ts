/** 固定网页引擎清单是安装和执行的共同信任边界，不接受调用方提供摘要。 */
import { createHash } from 'node:crypto';
import { TripoError } from '../../studio/contracts/errors.ts';

export const studioAssimpFiles = {
  glue: {
    name: 'assimpjs-meshopt-2422b47e7c.js',
    sha256: '2422b47e7cd0853a0ddd709e3f77ef70ecdd72c87ea46f845b6054be641625c8',
    bytes: 131409,
  },
  wasm: {
    name: 'assimpjs-meshopt-3aa9eca20d.wasm',
    sha256: '3aa9eca20dd3b912be99ffdc4813579ad880be4f5393023ca99fb84ac9832324',
    bytes: 2520806,
  },
} as const;
export type RuntimeKind = keyof typeof studioAssimpFiles;
export type StudioAssimpAssets = Record<RuntimeKind, Buffer>;
export const runtimeKinds: readonly RuntimeKind[] = ['glue', 'wasm'];
export const studioAssimpHash = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export const studioAssimpUrl = (kind: RuntimeKind): string =>
  `https://studio.tripo3d.ai/_assimp/wasm/${studioAssimpFiles[kind].name}`;

export function verifyRuntime(bytes: Buffer, kind: RuntimeKind): Buffer {
  const file = studioAssimpFiles[kind];
  if (bytes.length !== file.bytes || studioAssimpHash(bytes) !== file.sha256)
    throw new TripoError(
      'FRONTEND_RUNTIME_INTEGRITY',
      `Studio frontend runtime ${file.name} differs from its pinned size or SHA-256.`,
    );
  return bytes;
}
