/** 按官方能力分组展示网页可映射模型；目录不是当前账号或每个参数组合的可用性保证。 */
import { modelAliases, imageAliases } from './planning.ts';
import { DEFAULT_IMAGE_MODEL, imageSchema, rigSchema } from '../../studio/contracts/schemas.ts';
function models(ids: string[], aliases: Record<string, string> = {}): Record<string, unknown>[] {
  return ids.map((id) => ({ id, aliases: Object.keys(aliases).filter((key) => aliases[key] === id) }));
}
export function listModels(): Record<string, unknown>[] {
  return [
    {
      capability: '3d-generation (text/image/multiview-to-model)',
      default: 'Nexus-v2.0-20260801',
      models: models([...new Set(Object.values(modelAliases))], modelAliases),
    },
    ...['text-to-image', 'image-to-image'].map((capability) => ({
      capability,
      default: DEFAULT_IMAGE_MODEL,
      models: models(
        imageSchema.shape.model_version
          .unwrap()
          .options.filter((id) => capability === 'text-to-image' || id !== 'midjourney'),
        imageAliases,
      ),
      note: 'Runtime pricing and availability apply; legacy GPT 1.5 has no reviewed current Studio price.',
    })),
    {
      capability: 'texture (model texture)',
      default: 'studio-current',
      models: models(['v3.5-20260815']),
      note: 'Studio selects its current engine; v3.0/v3.5 aliases do not pin an API engine. fast and texture_seed are supported for generation, but a repeated seed did not reproduce an identical texture.',
    },
    {
      capability: 'rig (anim rig)',
      default: 'v3.0-20260909',
      default_by_rig_type: { quadruped: 'v2.5-20260210' },
      models: models(rigSchema.shape.model_version.unwrap().options, {
        'rig-v2.0': 'v2.5-20260210',
        'rig-v2.5': 'v2.5-20260210',
        'rig-v3.0': 'v3.0-20260909',
        'rig-v1.0': 'v1.0-20240301',
      }),
    },
    {
      capability: 'segment (mesh segment)',
      default: 'v1.0-20250506',
      studio_default: 'v2.0-20260430',
      models: models(['v1.0-20250506', 'v2.0-20260430']),
    },
    {
      capability: 'decimate (mesh decimate)',
      default: 'default',
      models: models(['default']),
      note: 'Studio engine version is not an API decimate model version.',
    },
  ].map((entry) => ({ ...entry, backend: 'studio' }));
}
