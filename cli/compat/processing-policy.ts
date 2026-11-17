/** 官方处理参数的联动与输入归一化；这里只调整调用意图，不实现模型加工。 */
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import { validateTextureQuality } from './generation-policy.ts';
type Flags = Record<string, unknown>;
const processingOptions = new Set([
  'format',
  'texture_size',
  'texture_format',
  'face_limit',
  'quad',
  'flatten_bottom',
  'fbx_preset',
  'export_orientation',
  'scale_factor',
  'pivot_to_center_bottom',
  'export_vertex_colors',
  'model',
  'texture_quality',
  'texture_alignment',
  'pbr',
  'rig_type',
  'spec',
  'out_format',
  'animation',
  'animate_in_place',
  'smart_uv',
  'bake',
  'completion_mode',
  'seg_type',
  'granularity',
  'hint',
  'bbox',
  'ref_image',
]);

/** 官方处理入口先收集独立选项，再用 -p 覆盖；Commander 的隐式 bake=true 也不能反盖 -p。 */
function processingFlags(name: string, supplied: Flags): Flags {
  const param = { ...object(supplied.param) };
  const flags: Flags = { ...supplied, param };
  // 官方 retarget 将多值 --animation 转成 animations，早于普通 -p 合并。
  if (name === 'retarget' && Array.isArray(flags.animation)) {
    if (flags.animation.length > 1) {
      param.animations = flags.animation;
      delete flags.animation;
    } else flags.animation = flags.animation[0];
  }
  for (const key of Object.keys(param))
    if (processingOptions.has(key))
      delete flags[key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase())];
  validateProcessingModel(name, Object.hasOwn(param, 'model') ? param.model : flags.model);
  if (name === 'texture')
    validateTextureQuality(
      Object.hasOwn(param, 'texture_quality') ? param.texture_quality : flags.textureQuality,
    );
  if (name === 'decimate') validateDefaultDecimateRange(flags, param);
  return flags;
}

function validateDefaultDecimateRange(flags: Flags, param: Flags): void {
  const model = Object.hasOwn(param, 'model') ? param.model : flags.model;
  // 指定旧引擎在后续规划中明确拒绝；这里只对齐官方默认入口，不收窄网页原生及 convert 内部减面。
  if (model !== undefined && model !== 'default') return;
  const faceLimit = Object.hasOwn(param, 'face_limit') ? param.face_limit : flags.faceLimit;
  if (faceLimit === undefined) return;
  const quad = Object.hasOwn(param, 'quad') ? param.quad : flags.quad;
  const maximum = quad === true ? 10000 : 20000;
  if (typeof faceLimit !== 'number' || !Number.isInteger(faceLimit) || faceLimit < 500 || faceLimit > maximum)
    throw new TripoError(
      'INVALID_INPUT',
      `Default decimate face_limit must be within 500–${maximum}${quad === true ? ' (quad mesh)' : ''}.`,
      'not_submitted',
    );
}

function validateProcessingModel(name: string, model: unknown): void {
  if (
    ['rig', 'texture', 'segment', 'edit', 'decimate'].includes(name) &&
    model !== undefined &&
    (typeof model !== 'string' || !model.trim())
  )
    throw new TripoError('INVALID_INPUT', 'Processing model must be a nonempty string.', 'not_submitted');
}

/** 只用于官方公开 convert 入口；网页原生导出和内部朝向/动画交付仍可选默认 GLB。 */
export function validatePublicConversion(supplied: Flags): void {
  const param = object(supplied.param);
  const format = Object.hasOwn(param, 'format') ? param.format : supplied.format;
  if (typeof format !== 'string' || !format.trim())
    throw new TripoError(
      'INVALID_INPUT',
      'convert requires format (GLTF/USDZ/FBX/OBJ/STL/3MF); use --format or --then convert:fbx.',
      'not_submitted',
    );
}

function remove(flags: Flags, param: Flags, key: string, flag = key): void {
  delete flags[flag];
  delete param[key];
}

function convert(flags: Flags, param: Flags, warnings: string[]): void {
  validateConversionFaceLimit(Object.hasOwn(param, 'face_limit') ? param.face_limit : flags.faceLimit);
  let format = text(flags.format ?? param.format).toLowerCase();
  const quad = flags.quad ?? param.quad;
  if (quad === true) validateQuad(flags, param);
  if (quad === true && ['glb', 'gltf'].includes(format))
    throw new TripoError('INVALID_INPUT', 'quad=true cannot export GLTF/GLB; use format=FBX.');
  if (quad === true && ['obj', 'stl', 'usdz', '3mf'].includes(format)) {
    warnings.push(`quad=true forces FBX output (format ${format.toUpperCase()} is overridden).`);
    flags.format = format = 'fbx';
  }
  if (quad === false) remove(flags, param, 'quad');
  if (param.auto_size === false) {
    delete param.auto_size;
    warnings.push(
      'auto_size=false keeps the native Studio scale and explicit scale_factor edits; no real-world size estimation is requested.',
    );
  }
  if (param.force_symmetry === false || (param.force_symmetry === true && quad !== true)) {
    if (param.force_symmetry) warnings.push('force_symmetry only applies with quad=true (removed).');
    delete param.force_symmetry;
  }
  convertExportFields(flags, param, format, warnings);
}

function validateConversionFaceLimit(value: unknown): void {
  // null 不能经 ?? 回退成默认减面；错误必须早于导入和收费 remesh。
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value))
  )
    throw new TripoError('INVALID_INPUT', 'face_limit must be a finite integer.', 'not_submitted');
}
function validateQuad(flags: Flags, param: Flags): void {
  if (param.force_symmetry === true)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Quad force_symmetry has no verified Studio mapping.',
    );
  if (
    (flags.textureFormat ?? param.texture_format) !== undefined ||
    (flags.flattenBottom ?? param.flatten_bottom) === true ||
    (flags.pivotToCenterBottom ?? param.pivot_to_center_bottom) === true
  )
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Quad conversion cannot use postprocessing through triangulated GLB; use native FBX export without local texture/clip/pivot options.',
    );
}
function convertExportFields(flags: Flags, param: Flags, format: string, warnings: string[]): void {
  const textureFormat = flags.textureFormat ?? param.texture_format;
  if (typeof textureFormat === 'string') flags.textureFormat = textureFormat.toUpperCase();
  if (
    (flags.exportVertexColors ?? param.export_vertex_colors) === true &&
    !['obj', 'glb', 'gltf'].includes(format)
  ) {
    remove(flags, param, 'export_vertex_colors', 'exportVertexColors');
    warnings.push(`export_vertex_colors only applies to OBJ/GLTF (removed for ${format.toUpperCase()}).`);
  }
  const preset = flags.fbxPreset ?? param.fbx_preset;
  if (preset !== undefined) {
    if (!['blender', '3dsmax', 'mixamo', 'bake_scale'].includes(text(preset)))
      throw new TripoError('INVALID_INPUT', 'Unsupported fbx_preset.');
    if (format !== 'fbx') {
      remove(flags, param, 'fbx_preset', 'fbxPreset');
      warnings.push('fbx_preset only applies to FBX exports (removed).');
    }
  }
}

function retarget(flags: Flags, param: Flags, warnings: string[]): void {
  if ((flags.animation ?? param.animation) !== undefined && param.animations !== undefined)
    throw new TripoError('INVALID_INPUT', 'Specify animation or animations, not both.');
  if (param.bake_animation !== undefined) {
    delete param.bake_animation;
    warnings.push('bake_animation is deprecated and was ignored, matching the official CLI.');
  }
  if (param.export_with_geometry === false) {
    const format = text(flags.outFormat ?? param.out_format).toLowerCase();
    if (format && !['glb', 'gltf'].includes(format))
      throw new TripoError(
        'STUDIO_CAPABILITY_UNAVAILABLE',
        'Standalone Studio motion downloads are GLB; other out_format values require export_with_geometry=true.',
      );
    if ((flags.animateInPlace ?? param.animate_in_place) === true)
      throw new TripoError(
        'STUDIO_CAPABILITY_UNAVAILABLE',
        'animate_in_place requires the native model export step; standalone motion downloads have no verified mapping.',
      );
  }
}

/** 接受官方的两点、扁平数组和分隔文本；多余数字不能被切片后静默丢弃。 */
export function normalizeBbox(value: unknown): unknown {
  const flat =
    typeof value === 'string'
      ? value
          .split(/[/,;\s]+/)
          .filter(Boolean)
          .map(Number)
      : Array.isArray(value)
        ? value.flat()
        : undefined;
  if (!flat || flat.length !== 6 || !flat.every((v) => typeof v === 'number' && Number.isFinite(v)))
    throw new TripoError('INVALID_INPUT', 'bbox must contain exactly six finite numbers.');
  return [flat.slice(0, 3), flat.slice(3)];
}

/** 在导入、重拓扑或动作提交之前检查组合选项，返回的警告由 CLI 和 MCP 共同展示。 */
export function adjustProcessing(name: string, supplied: Flags): { flags: Flags; warnings: string[] } {
  const flags = processingFlags(name, supplied);
  const param = object(flags.param);
  const warnings: string[] = [];
  if (name === 'convert') convert(flags, param, warnings);
  if (name === 'retarget') retarget(flags, param, warnings);
  if (name === 'edit' && (flags.bbox ?? param.bbox) !== undefined)
    flags.bbox = normalizeBbox(flags.bbox ?? param.bbox);
  return { flags, warnings };
}
