/** 资产库和社区浏览使用网页的 Content/Search 服务；只读目录不含互动消息和用户管理。 */
import { z } from 'zod';
import { id } from '../contracts/primitives.ts';
import type { ResourceSpec } from './resources.ts';

const page = {
  page_size: z.number().int().min(1).max(100).default(20),
  page_token: z.string().max(4096).default(''),
};
const query = z.string().trim().max(500).default('');
const modelType = z.enum(['all', 'pbr', 'rigged', 'segmented', 'smart_low_poly', 'smart_mesh']);
const gallerySchema = z
  .object({
    ...page,
    query,
    category: z
      .enum([
        'featured',
        'abstract / symbol',
        'creatures & animals',
        'architecture',
        'character',
        'clothing',
        'food',
        'furniture',
        'machine',
        'nature & environment',
        'props',
        'vehicle',
        'weapon',
      ])
      .default('featured'),
    model_type: modelType.default('all'),
    use_case: z.enum(['all', '3d_printing']).default('all'),
    sort: z.enum(['recommended', 'newest', 'most_likes']).default('recommended'),
    featured_only: z.boolean().default(false),
  })
  .strict();

/** 数字 scope/sort 与网页 sO/cO 映射一致；标签前缀区分模型类型和拓扑类型。 */
function galleryBody(x: Record<string, unknown>): Record<string, unknown> {
  const labels: string[] = [];
  if (x.model_type === 'smart_mesh') labels.push('mtp:smart_mesh');
  else if (x.model_type !== 'all') labels.push(`mt:${x.model_type}`);
  if (!x.query && x.use_case === '3d_printing') labels.push('uc:3d printing');
  return {
    scope: 1,
    search: {
      query: x.query,
      pageSize: x.page_size,
      pageToken: x.page_token,
      sort: x.sort === 'newest' ? 2 : x.sort === 'most_likes' ? 5 : x.query ? 1 : 4,
      filter: {
        itemTypes: ['project_3d'],
        ...(!x.query && x.category !== 'featured' ? { categories: [x.category] } : {}),
        ...(x.featured_only || (!x.query && x.category === 'featured') ? { featured: true } : {}),
        ...(labels.length ? { labels } : {}),
      },
    },
  };
}
const spec = (
  name: string,
  service: 'search.Search' | 'content.Content',
  method: string,
  schema: z.ZodType,
  description: string,
  body: ResourceSpec['body'],
): ResourceSpec => ({
  name,
  description,
  schema,
  readOnly: true,
  method: 'POST',
  micro: true,
  path: () => `/tripo.community.api.${service}Service/${method}`,
  body: (x) => ({ appId: 'tripo', ...(body?.(x) as Record<string, unknown>) }),
});

export const libraryResources: ResourceSpec[] = [
  spec(
    'gallery_feed',
    'search.Search',
    'ListGalleryFeed',
    z.object(page).strict(),
    'Browse the Studio gallery feed using its continuation token.',
    (x) => ({ pageSize: x.page_size, pageToken: x.page_token }),
  ),
  spec(
    'gallery_browse',
    'search.Search',
    'SearchItems',
    gallerySchema,
    'Search and filter gallery models by category, topology, material, use case and sort order.',
    galleryBody,
  ),
  spec(
    'collection_list',
    'search.Search',
    'SearchMyCollectedItems',
    z.object({ ...page, query }).strict(),
    'List or search the models in your Studio collection.',
    (x) => ({
      filter: { itemTypes: ['project_3d'] },
      query: x.query,
      pageSize: x.page_size,
      pageToken: x.page_token,
    }),
  ),
  spec(
    'library_list',
    'search.Search',
    'SearchItems',
    z
      .object({
        ...page,
        scope: z.enum(['mine', 'team']).default('mine'),
        type: z.enum(['all', 'rigged', 'smart_mesh', 'textured', 'untextured']).default('all'),
      })
      .strict(),
    'List your models or models in the active team workspace, filtered by operation type.',
    (x) => ({
      scope: x.scope === 'team' ? 3 : 2,
      search: {
        query: '',
        sort: 2,
        pageSize: x.page_size,
        pageToken: x.page_token,
        filter: { itemTypes: ['project_3d'], ...(x.type === 'all' ? {} : { opTags: [x.type] }) },
      },
    }),
  ),
  spec(
    'gallery_item',
    'content.Content',
    'GetItem',
    z.object({ item_id: id }).strict(),
    'Read a gallery item with the same full detail view used by Studio.',
    (x) => ({ itemId: x.item_id, source: 1, view: 2 }),
  ),
  spec(
    'library_user_items',
    'content.Content',
    'ListItemsByUser',
    z.object({ ...page, user_id: id }).strict(),
    'List accessible model and collection cards for a specified Studio creator.',
    (x) => ({ userId: x.user_id, source: 5, pageSize: x.page_size, pageToken: x.page_token }),
  ),
];
