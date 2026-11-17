/** 素材读写接口目录；每个动作单独校验，禁止通用 HTTP 透传与账号管理操作。 */
import { z } from 'zod';
import { id } from '../contracts/primitives.ts';
import { metadataSchema, metadataBody } from './metadata.ts';
import { object, text, sanitize, TripoError } from '../contracts/errors.ts';
import type { StudioClient } from './client.ts';
import { WebMicroClient } from './micro-client.ts';
import { libraryResources } from './library.ts';
import { extraResources } from './extra-resources.ts';
const empty = z.object({}).strict();
const project = z.object({ project_id: id }).strict();
const operator = z.object({ operator_id: id }).strict();
const asset = z.object({ asset_id: id }).strict();
const current = project.extend({ current_operator_id: id });
const ids = z.array(id).min(1).max(100);
type Input = Record<string, unknown>;
export interface ResourceSpec {
  name: string;
  description: string;
  schema: z.ZodType;
  readOnly: boolean;
  destructive?: boolean;
  micro?: boolean;
  method: 'GET' | 'POST' | 'DELETE';
  path: (x: Input) => string;
  body?: (x: Input) => unknown;
  projects?: (x: Input) => string[];
  prepare?: (client: StudioClient, x: Input) => Promise<unknown>;
}
const post = (
  name: string,
  description: string,
  schema: z.ZodType,
  route: string,
  readOnly = true,
): ResourceSpec => ({
  name,
  description,
  schema,
  readOnly,
  method: 'POST',
  path: () => route,
  body: (x) => x,
});
const own = (spec: ResourceSpec): ResourceSpec => ({ ...spec, projects: (x) => [text(x.project_id)] });
const query = (base: string, x: Input): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(x)) if (value !== undefined) params.set(key, String(value));
  return `${base}?${params}`;
};
export const resources: ResourceSpec[] = [
  ...libraryResources,
  ...extraResources,
  post(
    'segmentation_prompt',
    'Analyze a model operator and suggest a segmentation prompt by part or color; does not segment it.',
    z
      .object({
        operator_id: id,
        mode: z.enum(['part', 'color']).default('part'),
        locale: z
          .string()
          .regex(/^[A-Za-z-]{2,20}$/)
          .default('en'),
      })
      .strict(),
    '/v2/studio/operation/ai_segmentation/prompt',
  ),
  {
    ...own(
      post(
        'project_metadata',
        'Edit part transforms, names, visibility and material factors against an expected model version.',
        metadataSchema,
        '/v2/studio/operation/meta_modification',
        false,
      ),
    ),
    prepare: metadataBody,
  },
  {
    name: 'project_related',
    description: 'Find gallery models related to a project.',
    schema: project.extend({
      limit: z.number().int().min(1).max(100).default(10),
      locale: z.string().default('en'),
    }),
    readOnly: true,
    method: 'GET',
    path: (x) =>
      query(`/v2/studio/project/related_models/${x.project_id}`, { limit: x.limit, locale: x.locale }),
  },
  post(
    'gallery_like',
    'Like a model in the Studio gallery.',
    z.object({ id }).strict(),
    '/v2/studio/gallery/like',
    false,
  ),
  {
    ...post(
      'gallery_unlike',
      'Remove your like from a Studio gallery model.',
      z.object({ id }).strict(),
      '/v2/studio/gallery/like',
      false,
    ),
    method: 'DELETE',
  },
  post(
    'operation_cancel',
    'Request cancellation for a specific active operation.',
    z
      .object({
        operator_id: id,
        operation_type: z.string().min(1).max(100),
        scene: z.string().min(1).max(100),
      })
      .strict(),
    '/v2/studio/operation/cancel',
    false,
  ),

  {
    name: 'image_templates',
    description: 'List available Studio image templates.',
    schema: empty,
    readOnly: true,
    method: 'GET',
    path: () => '/v2/studio/image/available_templates',
  },
  post(
    'image_get',
    'Inspect an image asset and its individual outputs.',
    asset,
    '/v2/studio/image/get_image_asset',
  ),
  {
    ...post(
      'image_delete',
      'Delete selected image outputs from your library.',
      z
        .object({
          items: z
            .array(z.object({ asset_id: id, keys: z.array(z.string().min(1)).max(100) }).strict())
            .min(1)
            .max(100),
        })
        .strict(),
      '/v2/studio/image/batch_delete',
      false,
    ),
    destructive: true,
  },
  {
    name: 'project_get',
    description: 'Inspect a Studio project, optionally at a selected operator.',
    schema: project.extend({ operator_id: id.optional() }),
    readOnly: true,
    method: 'GET',
    path: (x) =>
      `/v2/studio/project/detail/v3/${x.project_id}${x.operator_id ? `?operator_id=${x.operator_id}` : ''}`,
  },
  {
    name: 'project_history',
    description: 'List a project’s saved operation history.',
    schema: project,
    readOnly: true,
    method: 'GET',
    path: (x) => `/v2/studio/project/history/${x.project_id}`,
  },
  {
    name: 'project_history_check',
    description: 'Check whether project history can be restored.',
    schema: project,
    readOnly: true,
    method: 'GET',
    path: (x) => `/v2/studio/project/history/check/${x.project_id}`,
  },
  own(
    post(
      'project_rename',
      'Rename your Studio project.',
      project.extend({ name: z.string().trim().min(1).max(100) }),
      '/v2/studio/operation/update_name',
      false,
    ),
  ),
  own(
    post(
      'project_tags',
      'Set your project’s custom tags.',
      project.extend({ tags: z.array(z.string().trim().min(1).max(100)).max(30) }),
      '/v2/studio/project/set-custom-tags',
      false,
    ),
  ),
  own(
    post(
      'project_visibility',
      'Set your project visibility.',
      project.extend({ visibility: z.enum(['public', 'private', 'shareable']) }),
      '/v2/studio/project/set-visibility',
      false,
    ),
  ),
  own(
    post(
      'project_restore',
      'Restore a selected project history version.',
      project.extend({ operator_id: id }),
      '/v2/studio/operation/restore',
      false,
    ),
  ),
  {
    name: 'project_delete',
    description: 'Delete explicitly selected projects you own.',
    schema: z.object({ project_ids: ids }).strict(),
    readOnly: false,
    destructive: true,
    method: 'DELETE',
    path: () => '/v2/studio/assets',
    body: (x) => x,
    projects: (x) => x.project_ids as string[],
  },
  post(
    'uv_context',
    'Inspect UV candidates, active tasks and the next permitted action.',
    current,
    '/v2/studio/operation/uv_edit/context',
  ),
  own(
    post(
      'uv_apply',
      'Apply a completed UV candidate to the expected current model version.',
      current.extend({ candidate_operator_id: id }),
      '/v2/studio/operation/uv_edit/apply',
      false,
    ),
  ),
  post(
    'retexture_get',
    'Inspect the generated Magic Brush preview.',
    operator,
    '/v2/studio/operation/get_retexture',
  ),
  post(
    'retexture_images',
    'List Magic Brush preview images for a project.',
    project,
    '/v2/studio/operation/get_retexture_images',
  ),
  post(
    'rig_check',
    'Check which skeleton type a model supports before rigging.',
    project.extend({
      model_version: z.enum(['v3.0-20260909', 'v2.5-20260210', 'v1.0-20240301']).default('v3.0-20260909'),
    }),
    '/v2/studio/operation/pre_rig_check',
  ),
  post('motion_get', 'Inspect a generated motion asset.', asset, '/v2/studio/motion/get_asset'),
  post(
    'motion_task',
    'Inspect one AI motion generation task.',
    z.object({ task_id: id }).strict(),
    '/v2/studio/motion/get_task',
  ),
  post('motion_list', 'List your generated motion assets.', empty, '/v2/studio/motion/list_assets'),
  post('motion_active', 'List your active AI motion tasks.', empty, '/v2/studio/motion/list_active_tasks'),
  post(
    'motion_rename',
    'Rename a generated motion asset.',
    asset.extend({ title: z.string().trim().min(1).max(100) }),
    '/v2/studio/motion/rename_asset',
    false,
  ),
  own(
    post(
      'animation_remove',
      'Remove one applied animation from a project.',
      project.extend({ model_operator_id: id, retarget_operator_id: id }),
      '/v2/studio/operation/remove_retarget',
      false,
    ),
  ),
  {
    name: 'gallery_search',
    description: 'Search the Studio model gallery.',
    schema: z
      .object({
        user_input: z.string().min(1).max(300),
        locale: z
          .string()
          .regex(/^[a-z-]{2,10}$/)
          .default('en'),
      })
      .strict(),
    readOnly: true,
    method: 'GET',
    path: (x) => query('/v2/studio/3d-model-gallery/search', x),
  },
  post(
    'gallery_collect',
    'Add a gallery model to your collection.',
    z.object({ id }).strict(),
    '/v2/studio/gallery/collect',
    false,
  ),
  {
    ...post(
      'gallery_uncollect',
      'Remove a gallery model from your collection.',
      z.object({ id }).strict(),
      '/v2/studio/gallery/collect',
      false,
    ),
    method: 'DELETE',
  },
  {
    name: 'usage',
    description: 'List Studio credit transactions.',
    schema: z
      .object({
        page_num: z.number().int().min(1).default(1),
        page_size: z.number().int().min(1).max(100).default(20),
      })
      .strict(),
    readOnly: true,
    method: 'GET',
    path: (x) => query('/v2/studio/txn/records', x),
  },
];
/** 写操作先确认归属和空闲状态；任何网络结果未知都返回错误，不自动重发。 */
export async function callResource(
  client: StudioClient,
  spec: ResourceSpec,
  input: unknown,
): Promise<unknown> {
  const x = spec.schema.parse(input) as Input;
  // 归属查询、异步准备和最终写必须共享最初账号，不能在中间重新登录后换一个身份完成操作。
  let session = await client.session(false);
  if (!session?.accountRef) {
    await client.recoverAuthentication(
      new TripoError(
        'AUTH_REQUIRED',
        'Sign in to Studio before reading or changing resources.',
        'not_submitted',
      ),
      'before_request',
    );
    session = await client.session(false);
  }
  if (!session?.accountRef)
    throw new TripoError('AUTH_REQUIRED', 'No verified Studio account is available.', 'not_submitted');
  client = client.forAccount(session.accountRef);
  if (spec.micro)
    return sanitize(await new WebMicroClient(client, 'community').call(spec.path(x), spec.body?.(x)));
  for (const projectId of spec.projects?.(x) ?? []) {
    const detail = object(await client.request('GET', `/v2/studio/project/detail/v3/${projectId}`));
    if (detail.is_owner !== true && object(detail.operator).is_owner !== true)
      throw new TripoError('OWNERSHIP_REQUIRED', 'Only your own project can be modified.');
    if (detail.running_operator)
      throw new TripoError('PROJECT_BUSY', 'Wait for the project operation to complete.');
  }
  const result = await client.request(
    spec.method,
    spec.path(x),
    spec.prepare ? await spec.prepare(client, x) : spec.body?.(x),
    {
      paid: !spec.readOnly,
      beforeSend: () => {
        client.credentials.load();
      },
    },
  );
  return sanitize(result ?? { ok: true });
}
