/** 与官方 CLI 同名的生产预设；用户显式参数覆盖预设，网页后端逐步执行。 */
import type { Flags } from './planning.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
const presets: Record<string, { param: Record<string, unknown>; then?: string }> = {
  'game-mobile': {
    param: { texture: true, texture_quality: 'standard', face_limit: 15000 },
    then: 'convert:fbx',
  },
  'game-pc': { param: { texture: true, texture_quality: 'detailed' }, then: 'convert:fbx' },
  film: { param: { texture: true, quad: true, texture_quality: 'detailed' } },
  print: { param: { texture: false, pbr: false }, then: 'convert:stl,flatten_bottom=true' },
  'ar-web': { param: { texture: true, face_limit: 20000 }, then: 'convert:usdz' },
  anim: { param: { texture: true }, then: 'rig-check,rig,retarget:animations=["preset:idle","preset:walk"]' },
  toy: { param: { texture: true, face_limit: 20000 } },
};
export function scenarioFlags(flags: Flags): Flags {
  if (!flags.for) return flags;
  const preset = presets[text(flags.for)];
  if (!preset)
    throw new TripoError('INVALID_INPUT', `Unknown scenario; choose ${Object.keys(presets).join(', ')}.`);
  return {
    ...flags,
    param: { ...preset.param, ...object(flags.param) },
    then: flags.then ?? preset.then,
  };
}
