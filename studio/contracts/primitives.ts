/** Studio 公开标识与文本边界供各功能契约复用。 */
import { z } from 'zod';
export const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_:.-]+$/);
export const prompt = z.string().trim().min(1).max(1000);
export const imageSource = z
  .object({ asset_id: id, output_index: z.number().int().min(0).max(15).default(0) })
  .strict();
