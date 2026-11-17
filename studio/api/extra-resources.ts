/** 补充网页筛选、只读预检及服务历史；输入字段来自已存档的实际调用点。 */
import { z } from 'zod';
import { id } from '../contracts/primitives.ts';
import { Operations } from './operations.ts';
import type { ResourceSpec } from './resources.ts';

const page = {
  page_num: z.number().int().min(1).default(1),
  page_size: z.number().int().min(1).max(100).default(20),
};
export const extraResources: ResourceSpec[] = [
  {
    name: 'export_limit',
    description: 'Read the current Studio export allowance and account restrictions before exporting.',
    schema: z.object({}).strict(),
    readOnly: true,
    method: 'GET',
    path: () => '/v2/studio/marketing/export-limit',
  },
  {
    name: 'assets_filter',
    description: 'Filter Studio assets by library and model type using offset pagination.',
    schema: z
      .object({
        asset_type: z.enum(['mine', 'collected', 'team']).default('mine'),
        type: z.enum(['all', 'rigged', 'smart_mesh', 'textured', 'untextured']).default('all'),
        locale: z
          .string()
          .regex(/^[a-z-]{2,10}$/)
          .default('en'),
        offset: z.number().int().min(0).max(1000000).default(0),
        size: z.number().int().min(1).max(100).default(20),
      })
      .strict(),
    readOnly: true,
    method: 'GET',
    path: (x) =>
      `/v2/studio/assets/v2?${new URLSearchParams(Object.entries(x).map(([k, v]) => [k, String(v)]))}`,
  },
  {
    name: 'gallery_tag',
    description: 'Browse a gallery tag with model filters, sorting and continuation tokens.',
    schema: z
      .object({
        tag: z.string().min(1).max(200),
        locale: z
          .string()
          .regex(/^[a-z-]{2,10}$/)
          .default('en'),
        size: z.number().int().min(1).max(100).default(20),
        page_token: z.string().max(4096).optional(),
        model_type: z.enum(['all', 'pbr', 'rigged', 'segmented', 'smart_low_poly', 'smart_mesh']).optional(),
        sort_by: z.enum(['recommended', 'newest', 'most_likes']).default('recommended'),
      })
      .strict(),
    readOnly: true,
    method: 'POST',
    path: () => '/v2/studio/tag/page',
    body: (x) => ({ ...x, ...(x.model_type === 'all' ? { model_type: undefined } : {}) }),
  },
  {
    name: 'motion_recent',
    description: 'List recently used retarget motions for your Studio account.',
    schema: z.object({}).strict(),
    readOnly: true,
    method: 'POST',
    path: () => '/v2/studio/operation/get_user_operation_context',
    body: () => ({ record_type: 'recent_retarget_motions' }),
  },
  {
    name: 'symmetry_check',
    description:
      'Check image symmetry before P2 modelling using an uploaded file token or an existing image asset.',
    schema: z
      .object({
        file_token: z
          .string()
          .regex(/^studio_file_image_[a-f\d-]{36}$/)
          .optional(),
        asset_id: id.optional(),
        output_index: z.number().int().min(0).max(15).default(0),
      })
      .strict()
      .refine((x) => Boolean(x.file_token) !== Boolean(x.asset_id), 'Choose one file_token or asset_id.'),
    readOnly: true,
    method: 'POST',
    path: () => '/v2/studio/operation/symmetry_check',
    prepare: async (client, x) => {
      const image = await new Operations(client, []).imageReference(
        x.file_token
          ? { image_path: x.file_token }
          : { image_asset: { asset_id: x.asset_id, output_index: x.output_index } },
      );
      return { image: { bucket: image.bucket, key: image.key } };
    },
  },
  {
    name: 'refine_history',
    description: 'Read your human refinement service requests; does not place an order.',
    schema: z.object(page).strict(),
    readOnly: true,
    method: 'POST',
    path: () => '/v2/studio/pro_refine/history',
    body: (x) => x,
  },
  {
    name: 'refine_allowance',
    description: 'Read the remaining human refinement allowance; does not place an order.',
    schema: z.object({}).strict(),
    readOnly: true,
    method: 'GET',
    path: () => '/v2/studio/pro_refine/free_times',
  },
];
