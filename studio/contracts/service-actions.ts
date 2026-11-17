/** 导出授权和人工精修是有副作用的网页动作；仍使用持久 request_id，而非可盲目重试的资源查询。 */
import { z } from 'zod';
import { id } from './primitives.ts';
export const serviceActionSchemas = {
  export_lite: z
    .object({
      project_id: id,
      operator_id: id,
      format: z.enum(['glb', 'fbx', 'obj', 'stl', 'usdz', '3mf']).default('glb'),
      public_model: z.boolean().default(false),
    })
    .strict(),
  refine_submit: z
    .object({
      project_id: id,
      requirement: z.string().min(1).max(10000),
      accept_variable_cost: z
        .literal(true)
        .describe(
          'Submit a human-service request; Studio determines allowance/payment. Does not pay automatically.',
        ),
    })
    .strict(),
};
