/** 对照网页 _pBd4tHi.js 的逐节点公式；不为缺失的收费参数猜测默认值。 */
import { array, object, text, TripoError } from '../contracts/errors.ts';
import type { Operation } from '../contracts/types.ts';
const operations: Record<string, Operation> = {
  GENERATE_IMAGE: 'image',
  GENERATE_HD_MODEL: 'model',
  GENERATE_SM_MODEL: 'model',
  TEXTURE: 'texture',
  RETOPOLOGY: 'remesh',
  SMART_UV: 'uv_generate',
  SEGMENTATION: 'segment',
  RIGGING: 'rig',
  PBR: 'texture',
  ANIMATION: 'animate',
  MULTIVIEW: 'image_process',
  IMAGE_SPLIT: 'image_process',
  PARTS_DETECT: 'image_process',
};

/** Command mapping shares the actual run-price registry; it does not imply parameter or account acceptance. */
export function canvasExecutionCommand(nodeType: string): string | undefined {
  const type = nodeType.replace(/^NODE_TYPE_/, '');
  if (Object.hasOwn(operations, type) || ['SEMANTIC_SPLIT', 'SPLIT_RESULT'].includes(type))
    return 'ai-modeling studio canvas-run';
  if (type === 'AI_3D_LAB') return 'ai-modeling studio canvas-lab';
  if (type === 'HOLY_MOLLY') return 'ai-modeling studio canvas-turn';
  if (type === 'REVIEW') return 'ai-modeling canvas review';
}
function quality(value: unknown): string {
  if (!['standard', 'detailed', 'extreme'].includes(text(value)))
    throw new TripoError('PRICE_UNKNOWN', 'Canvas texture_quality must be explicit.');
  return value === 'extreme' ? 'ultra' : text(value);
}
function imagePrice(x: Record<string, unknown>): Record<string, unknown> {
  if (!text(x.model_version))
    throw new TripoError('PRICE_UNKNOWN', 'Canvas image model_version must be explicit.');
  const amount = x.amount ?? 1;
  if (!Number.isSafeInteger(amount) || Number(amount) < 1)
    throw new TripoError('PRICE_UNKNOWN', 'Canvas image amount must be a positive integer.');
  if (x.resolution && !['1K', '2K', '4K'].includes(text(x.resolution)))
    throw new TripoError('PRICE_UNKNOWN', 'Unknown Canvas image resolution.');
  return { ...x, amount };
}
function modelPrice(type: string, x: Record<string, unknown>): Record<string, unknown> {
  if (type === 'GENERATE_SM_MODEL') {
    if (!['Nexus-v1.0-20260214', 'Nexus-v2.0-20260801'].includes(text(x.model_version)))
      throw new TripoError('PRICE_UNKNOWN', 'Unknown Canvas Smart Mesh model.');
    // 网页 Smart Mesh 公式仅包含基础与四边面，不叠加 HD 模型的贴图收费项。
    return { model_version: x.model_version, quad: x.quad === true };
  }
  if (
    !['v3.1-20260211', 'v3.0-20250812', 'v2.5-20250123'].includes(text(x.model_version)) ||
    typeof x.texture !== 'boolean'
  )
    throw new TripoError('PRICE_UNKNOWN', 'Canvas HD model_version and texture must be explicit.');
  return { ...x, ...(x.texture ? { texture_quality: quality(x.texture_quality) } : {}) };
}
export function canvasNodeQuote(
  node: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const type = text(node.type).replace('NODE_TYPE_', '');
  if (type === 'HOLY_MOLLY')
    throw new TripoError(
      'UNSUPPORTED_OPERATION',
      'HolyMolly uses studio canvas-turn with explicit capabilities=["holy_molly"], material refs and accepted variable billing. Use node_id to target an existing game; Canvas CreateRun is not its execution route.',
      'not_submitted',
    );
  if (type === 'REVIEW')
    throw new TripoError(
      'INVALID_INPUT',
      'Use canvas review to approve this checkpoint, then run the returned downstream node IDs.',
    );
  const x = object(node.params);
  let operation = Object.hasOwn(operations, type) ? operations[type] : undefined;
  let params = { ...x };
  if (['SEMANTIC_SPLIT', 'SPLIT_RESULT'].includes(type)) {
    if (input.action === 'detect') {
      operation = 'image_process';
      params = { action: 'split' };
    } else {
      operation = 'image';
      params = imagePrice({
        ...x,
        amount: type === 'SPLIT_RESULT' ? 1 : array(input.parts).length || x.amount,
      });
    }
  }
  if (!operation) throw new TripoError('PRICE_UNKNOWN', `No executable reviewed Canvas price for ${type}.`);
  if (type === 'GENERATE_IMAGE') params = imagePrice(x);
  if (operation === 'model') params = modelPrice(type, x);
  if (type === 'TEXTURE') params = { ...x, action: 'generate', texture_quality: quality(x.texture_quality) };
  if (type === 'PBR') params.action = 'pbr';
  if (type === 'ANIMATION' && !['preset', 'asset', 'remove'].includes(text(x.motion_source)))
    operation = 'motion';
  if (['MULTIVIEW', 'IMAGE_SPLIT', 'PARTS_DETECT'].includes(type))
    params.action = type === 'MULTIVIEW' ? 'multiview' : 'split';
  if (type === 'SMART_UV') params.action = 'generate';
  return { node_id: node.id, node_type: type, operation, parameters: params };
}
/** action 枚举只适用于语义提取；普通节点“重新生成”仍发送网页原有无 action 的 CreateRun。 */
export function canvasAction(
  selected: Record<string, unknown>[],
  input: Record<string, unknown>,
): string | undefined {
  const extraction = selected.some((n) => n.type === 'NODE_TYPE_SEMANTIC_SPLIT');
  if (!extraction) {
    if (input.action === 'detect' || array(input.parts).length)
      throw new TripoError('INVALID_INPUT', 'detect/parts requires an extraction node.');
    // 网页对子图更新 prompt 后直接 CreateRun；父执行器的阶段 action 不能带到单张重跑。
    if (input.action === 'retry' && selected.some((n) => n.type === 'NODE_TYPE_SPLIT_RESULT'))
      throw new TripoError('INVALID_INPUT', 'Retry failed extraction results through their executor.');
    return undefined;
  }
  return (
    {
      generate: 'RUN_ACTION_GENERATE',
      regenerate: 'RUN_ACTION_REGENERATE',
      retry: 'RUN_ACTION_RETRY_FAILED',
      detect: 'RUN_ACTION_DETECT',
    } as Record<string, string>
  )[text(input.action)];
}
