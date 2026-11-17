/** 官方绑定参数的组合约束在上传与生成前检查，不改写网页原生 skeleton_preset 契约。 */
import { text, TripoError } from '../../studio/contracts/errors.ts';

const models: Record<string, string> = {
  'v1.0': 'v1.0-20240301',
  'rig-v1.0': 'v1.0-20240301',
  'v2.5': 'v2.5-20260210',
  'rig-v2.0': 'v2.5-20260210',
  'rig-v2.5': 'v2.5-20260210',
  'v3.0': 'v3.0-20260909',
  'rig-v3.0': 'v3.0-20260909',
};

/** 保留官方四足默认 v2.5，其余默认 v3；完整 wire 名称不额外改写。 */
export function compatibleRigModel(model: unknown, rigType: unknown = 'biped'): string {
  if (model === undefined) return rigType === 'quadruped' ? 'v2.5-20260210' : 'v3.0-20260909';
  return models[text(model)] ?? text(model);
}

/** 只校验调用方显式 spec，网页默认 mixamo 不应导致合法四足输入被误拒。 */
export function validateRigPolicy(input: Record<string, unknown>, model?: unknown): void {
  const version = compatibleRigModel(model !== undefined ? model : input.model, input.rig_type);
  const rigType = input.rig_type ?? 'biped';
  const fail = (message: string): never => {
    throw new TripoError('INVALID_INPUT', message, 'not_submitted');
  };
  if (!['v1.0-20240301', 'v2.5-20260210', 'v3.0-20260909'].includes(version)) fail('Unsupported rig model.');
  if (version === 'v1.0-20240301' && rigType !== 'biped') fail('rig v1.0 only supports biped.');
  if (rigType === 'others' && version !== 'v3.0-20260909') fail('rig_type others requires rig v3.0.');
  if (input.spec !== undefined) {
    if (
      typeof input.spec !== 'string' ||
      !['tripo', 'mixamo', 'actorcore', 'unity', 'unreal', 'vrm'].includes(input.spec)
    )
      fail('Unsupported rig spec.');
    if (rigType !== 'biped') fail('rig spec only applies to biped.');
    if (!['tripo', 'mixamo'].includes(text(input.spec)) && version !== 'v3.0-20260909')
      fail('spec actorcore/unity/unreal/vrm requires rig v3.0.');
  }
}
