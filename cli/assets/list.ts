/** Natural CLI and structured tools share one account-asset query contract. */
import { z } from 'zod';
import type { StudioGateway } from '../../studio/api/gateway.ts';

export const assetsListSchema = z
  .object({
    kind: z.enum(['model', 'image']).default('model'),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).max(1000000).default(0),
  })
  .strict();

export async function listAssets(studio: Pick<StudioGateway, 'assets'>, input: unknown) {
  const { kind, offset, limit } = assetsListSchema.parse(input);
  return await studio.assets(kind, offset, limit);
}
