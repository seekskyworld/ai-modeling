/** Shared package identity; reading this module does not initialize the application. */
import { readFileSync } from 'node:fs';

export const PACKAGE_NAME = '@seekskyworld/ai-modeling';

const metadataUrl = new URL(
  import.meta.url.endsWith('.ts') ? './package.json' : '../package.json',
  import.meta.url,
);
const metadata = JSON.parse(readFileSync(metadataUrl, 'utf8')) as { name?: unknown; version?: unknown };
if (
  metadata.name !== PACKAGE_NAME ||
  typeof metadata.version !== 'string' ||
  !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(
    metadata.version,
  )
)
  throw new Error('Invalid ai-modeling package identity.');

export const VERSION: string = metadata.version;
