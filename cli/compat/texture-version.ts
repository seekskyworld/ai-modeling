/** 固定 v3.5 通过原生独立贴图及回执断言实现，不强改质量或把其他引擎当作同一版本。 */
import { TripoError } from '../../studio/contracts/errors.ts';
import { verifiedTextureModel } from '../core/texture-version-policy.ts';
import type { PlannedStep } from './planning.ts';

export function textureModelRequirement(model: unknown): string | undefined {
  return ['v3.5', verifiedTextureModel].includes(String(model)) ? verifiedTextureModel : undefined;
}
export function generationTextureModel(
  input: Record<string, unknown>,
  warnings: string[],
  requestedQuality?: unknown,
): Pick<PlannedStep, 'requireTextureModel'> {
  if (input.texture_version === undefined) return {};
  const model = textureModelRequirement(input.texture_version);
  const legacy = ['v3.0', 'v3.0-20250812', 'v2.5', 'v2.5-20250123'].includes(String(input.texture_version));
  // 已关闭贴图时合法旧版本不需要引擎映射；保留官方对版本/fast 组合的提交前校验。
  if (input.texture !== true && (model || legacy)) {
    if (
      (requestedQuality !== undefined &&
        !['fast', 'standard', 'detailed', 'ultra'].includes(String(requestedQuality))) ||
      (requestedQuality === 'fast' && !model)
    )
      throw new TripoError(
        'INVALID_INPUT',
        'texture_quality must be fast/standard/detailed/extreme; fast requires texture_version=v3.5.',
        'not_submitted',
      );
    warnings.push(
      `texture_version=${String(input.texture_version)} has no effect with texture=false; no texture engine is requested.`,
    );
    delete input.texture_version;
    return {};
  }
  if (!model)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Only texture_version=v3.5 has a verified Studio engine mapping. Other versions are not substituted.',
      'not_submitted',
    );
  delete input.texture_version;
  return { requireTextureModel: model };
}

export const explicitTextureWarning =
  'texture_version=v3.5 runs native geometry then a separately billed Studio texture task and verifies its exact operator engine. Website pricing and separate receipts apply; --no-wait is unavailable for this chain.';
