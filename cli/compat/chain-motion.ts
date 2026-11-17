/** 官方 make 链会按已知骨架挑选有效非双足动作；不把任意通用名称只换前缀后收费。 */
import { text } from '../../studio/contracts/errors.ts';

const bodyPresets: Record<string, string[]> = {
  quadruped: ['preset:quadruped:walk'],
  hexapod: ['preset:hexapod:walk'],
  octopod: ['preset:octopod:walk'],
  serpentine: ['preset:serpentine:march'],
  aquatic: ['preset:aquatic:march'],
};

export interface ChainMotion {
  parameters: Record<string, unknown>;
  warnings: string[];
  stopBeforeRetarget: boolean;
}

/** 只在原始链紧邻 rig→retarget 时应用官方提前停止；独立 retarget 保留网页能力。 */
export function adaptChainMotion(
  parameters: Record<string, unknown>,
  rigType: unknown,
  immediatelyAfterRig = false,
): ChainMotion {
  const result: ChainMotion = { parameters: { ...parameters }, warnings: [], stopBeforeRetarget: false };
  const type = text(rigType);
  if (immediatelyAfterRig && ['avian', 'others'].includes(type)) {
    result.stopBeforeRetarget = true;
    result.warnings.push(
      `Rig type ${type} has no preset animations; keep the rigged model and skip retarget.`,
    );
    return result;
  }
  // 明确体型、用户动作和混合列表不猜测替代；只有整组泛用预设采用官方体型建议。
  const supplied = parameters.animations ?? parameters.animation;
  const requested = Array.isArray(supplied) ? supplied : [supplied];
  if (
    !requested.length ||
    !requested.every((value) => typeof value === 'string' && /^preset:[^:]+$/.test(value))
  )
    return result;
  const presets = bodyPresets[type];
  if (presets) {
    delete result.parameters.animation;
    result.parameters.animations = [...presets];
    result.warnings.push(
      `Rig type ${type}: generic motions use ${presets.join(', ')} in the official CLI chain.`,
    );
  }
  return result;
}
