/** 官方 CLI 命名在此转换为网页领域参数；离线规划不触发认证、网络或上传。 */
import path from 'node:path';
import { homedir } from 'node:os';
import { scenarioFlags } from './scenarios.ts';
import { parseChain, type ChainStep } from './chain.ts';
import { validateCompatibilityChain } from './chain-policy.ts';
import { validateRigPolicy } from './rig-policy.ts';
import { classifyMakeInputs } from './make-input.ts';
import { adjustGeneration, validateTextureQuality } from './generation-policy.ts';
import { pSeriesGeneration, type GenerationLayout } from './p-series-generation.ts';
import { adjustProcessing, normalizeBbox, validatePublicConversion } from './processing-policy.ts';
import { adaptChainMotion } from './chain-motion.ts';
import { planImageReferences, type ImageReferenceBinding } from './image-references.ts';
import { normalizeTextureGuidance, textureWarnings } from './texture.ts';
import { applyImageSize } from './image-size.ts';
import { imageSizeWarning, type ImageSizeRequirement } from '../core/image-size-policy.ts';
import {
  takeImageBackground,
  imageBackgroundWarning,
  type ImageBackground,
} from '../core/image-background-policy.ts';
import { applyImagePolicy, validateImageTemplate, validateImageReferenceCount } from './image-policy.ts';
import { takeNativeMeshopt, nativeMeshoptWarning } from './native-output-policy.ts';
import { editMultiviewPlan } from './multiview-plan.ts';
import type { MultiviewBundle } from '../core/multiview-bundle.ts';
import { generationTextureModel, textureModelRequirement } from './texture-version.ts';
import {
  takeImageOutputFormat,
  imageOutputWarning,
  type ImageOutputFormat,
} from '../core/image-output-policy.ts';
import { nativeUnbakedPivot, needsExportTransform } from '../../studio/contracts/export-options.ts';
import { normalize, exportIntentSchema, DEFAULT_IMAGE_MODEL } from '../../studio/contracts/schemas.ts';
import { isUnquotedOperation } from '../../studio/contracts/unquoted-pricing.ts';
import {
  checkedSmartSegmentTransform,
  smartSegmentTransformWarning,
  type SmartSegmentTransformIntent,
} from './smartsegment-transform-plan.ts';
import type { ExportEdits } from './export-edits.ts';
import {
  smartSegmentIdentity,
  smartSegmentScaleMatrix,
  smartSegmentScaleWarning,
  type SmartSegmentScaleIntent,
} from './smartsegment-scale-plan.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import type { Operation } from '../../studio/contracts/types.ts';
import { taskType } from '../../studio/contracts/task-type.ts';
import { importedAnimationWarning } from './export-animation-default.ts';
import { canExplicitExportJpeg, exportJpegDefaultWarning } from '../core/export-jpeg-policy.ts';
import { uvImportWarning } from '../core/uv-import-policy.ts';
import { frontendConvertPlan, type FrontendConvertIntent } from './frontend-convert.ts';
import { labReferenceEditPlan, type LabReferenceEditIntent } from './lab-reference-edit-plan.ts';
import { labProjectedSegmentPlan } from './lab-projected-segment-plan.ts';
import { labModelIsolationWarning } from './lab-model-isolation-layout.ts';
import {
  smartSegmentAffineMatrix,
  smartSegmentAffinePlan,
  type SmartSegmentAffineIntent,
} from './smartsegment-affine-plan.ts';
import { transferAffinePlan } from './smartsegment-affine-transfer-plan.ts';
import {
  isImageSmartSegment,
  smartSegmentImageOptions,
  smartSegmentImageParameters,
  smartSegmentImageWarning,
  smartSegmentImageHintWarning,
} from './smartsegment-image.ts';
export type Flags = Record<string, unknown>;
const inputPath = (value: string): string =>
  /^(https?:\/\/|studio_file_)/i.test(value)
    ? value
    : path.resolve(value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value);
const inputExtension = (value: string): string =>
  path.extname(/^https?:\/\//i.test(value) ? new URL(value).pathname : value).toLowerCase();
const inputName = (value: string): string =>
  path.basename(/^https?:\/\//i.test(value) ? new URL(value).pathname : value, inputExtension(value)) ||
  'imported-model';
const isModelSource = (source: string): boolean =>
  /^(https?:\/\/|studio_file_model_)/i.test(source) ||
  ['.glb', '.gltf', '.fbx', '.obj', '.stl'].includes(inputExtension(source));
const isTaskReference = (value: string): boolean => /^@|^[a-f\d]{8}-[a-f\d-]{27}$|^task_/i.test(value);
export interface PlannedStep {
  name: string;
  operation: Operation;
  parameters: Record<string, unknown>;
  source?: string;
  /** Lab原件与网页Studio规范化副本不同，只有调用方明确选择后才允许续接。 */
  sourceRepresentation?: 'studio_normalized';
  animationsFromChain?: boolean;
  animationsFromSource?: boolean;
  exportDefaults?: Array<
    'with_animation' | 'texture_size' | 'animate_in_place' | 'export_orientation' | 'texture_format'
  >;
  requireStaticExportSource?: boolean;
  exportEdits?: ExportEdits;
  preflight?: 'rig';
  requireTextureBaking?: boolean;
  requireNativeMeshopt?: true;
  uvImportFromChain?: true;
  requireUvCompressionInput?: true;
  requireTextureModel?: string;
  imageOutputFormat?: ImageOutputFormat;
  imageSize?: ImageSizeRequirement;
  imageBackground?: ImageBackground;
  genericAnimation?: string;
  chainIndex?: number;
  imageReferences?: ImageReferenceBinding[];
  frontendConvert?: FrontendConvertIntent;
  /** 仅重做传递冻结意图版本；普通调用重入读取原版本，新请求默认采用当前轴向映射。 */
  frontendConvertRevision?: 1 | 2;
  warnings?: string[];
}
export interface Plan {
  labReferenceEdit?: LabReferenceEditIntent;
  smartSegmentAffine?: SmartSegmentAffineIntent;
  /** 旧七步链的新增费用同意独立于不可变业务布局，只适用于尚未冻结的步骤。 */
  legacyAffineUnquotedConsent?: true;
  smartSegmentScale?: SmartSegmentScaleIntent;
  smartSegmentTransform?: SmartSegmentTransformIntent;
  smartSegmentImage?: { source: string; granularity: string; hint: string };
  multiviewEdit?: MultiviewBundle['intent'];
  steps: PlannedStep[];
  pending_uploads: string[];
  warnings: string[];
  downloadGeneration?: boolean;
  generationExport?: boolean;
  generationSteps?: number;
  generationLayout?: GenerationLayout;
  sourceValidation?: { reference: string; chain: ChainStep[] };
  chainIntent?: ChainStep[];
}
export const modelAliases: Record<string, string> = {
  'tripo-p2': 'Nexus-v2.0-20260801',
  p2: 'Nexus-v2.0-20260801',
  'p2.0': 'Nexus-v2.0-20260801',
  'p2.0 preview': 'Nexus-v2.0-20260801',
  'p2-20260801': 'Nexus-v2.0-20260801',
  'tripo-p1': 'Nexus-v1.0-20260214',
  p1: 'Nexus-v1.0-20260214',
  'p1.0': 'Nexus-v1.0-20260214',
  'p1-20260311': 'Nexus-v1.0-20260214',
  'tripo-v3.1': 'v3.1-20260211',
  'v3.1': 'v3.1-20260211',
  'h3.1': 'v3.1-20260211',
  'tripo-v3.0': 'v3.0-20250812',
  'v3.0': 'v3.0-20250812',
  'h3.0': 'v3.0-20250812',
  'tripo-v2.5': 'v2.5-20250123',
  'v2.5': 'v2.5-20250123',
  'h2.5': 'v2.5-20250123',
};
export const imageAliases: Record<string, string> = {
  banana: 'gemini_2.5_flash_image_preview',
  banana2: 'gemini_3.1_flash_image_preview',
  banana_pro: 'gemini_3_pro_image_preview',
  'gemini-2.5-flash': 'gemini_2.5_flash_image_preview',
  'gemini-3-pro': 'gemini_3_pro_image_preview',
  'gemini-3.1-flash': 'gemini_3.1_flash_image_preview',
  'chat_image_1.5': 'gpt_image_1.5',
  chat_image_2: 'gpt_image_2',
  'chat_image_2.5_sunburst': 'gpt_image_2.5_sunburst',
};
export function parameters(flags: Flags): Record<string, unknown> {
  const x = { ...object(flags.param) };
  for (const key of [
    'textureQuality',
    'textureAlignment',
    'faceLimit',
    'quad',
    'format',
    'textureSize',
    'textureFormat',
    'fbxPreset',
    'exportOrientation',
    'scaleFactor',
    'pivotToCenterBottom',
    'exportVertexColors',
    'flattenBottom',
    'bake',
    'rigType',
    'spec',
    'animation',
    'bbox',
    'completionMode',
    'smartUv',
    'segType',
    'granularity',
    'hint',
    'refImage',
  ]) {
    if (flags[key] !== undefined) x[key.replace(/[A-Z]/g, (v) => '_' + v.toLowerCase())] = flags[key];
  }
  for (const key of ['texture_quality']) if (x[key] === 'extreme') x[key] = 'ultra';
  if (x.smart_low_poly !== undefined) {
    x.smart_poly = x.smart_low_poly;
    delete x.smart_low_poly;
  }
  return x;
}
function step(
  name: string,
  operation: Operation,
  input: Record<string, unknown>,
  source?: string,
): PlannedStep {
  return { name, operation, parameters: normalize(operation, input), ...(source ? { source } : {}) };
}
function meshoptRequirement(
  input: Record<string, unknown>,
  operation: string,
  warnings: string[],
): Pick<PlannedStep, 'requireNativeMeshopt'> {
  if (!takeNativeMeshopt(input, operation)) return {};
  warnings.push(nativeMeshoptWarning);
  return { requireNativeMeshopt: true };
}
function imageOutputRequirement(
  input: Record<string, unknown>,
  warnings: string[],
): Pick<PlannedStep, 'imageOutputFormat'> {
  const imageOutputFormat = takeImageOutputFormat(input);
  if (!imageOutputFormat) return {};
  warnings.push(imageOutputWarning);
  return { imageOutputFormat };
}
export function generation(name: string, inputs: string[], flags: Flags): PlannedStep {
  validateTextureQuality(
    flags.textureQuality !== undefined ? flags.textureQuality : object(flags.param).texture_quality,
  );
  const x = parameters(flags);
  const version = generationVersion(x, flags, name);
  delete x.model;
  const source = inputs.length === 1 && isTaskReference(inputs[0]!) ? inputs[0] : undefined;
  if (name === 'image-to-multiview' && version)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Studio multiview uses its website engine; an API model override has no verified mapping.',
    );
  if (name === 'image-to-multiview')
    return step(
      name,
      'image_process',
      {
        ...x,
        action: 'multiview',
        ...(source ? { asset_id: 'upstream' } : { image_path: inputPath(inputs[0]!) }),
      },
      source,
    );
  if (['text-to-image', 'image-to-image'].includes(name))
    return imageGeneration(name, inputs, x, flags, version, source);
  const modes: Record<string, string> = {
    'text-to-model': 'text',
    'image-to-model': 'image',
    'multiview-to-model': 'multiview',
  };
  const mode = modes[name];
  if (!mode)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      `${name} has no verified Studio equivalent.`,
      'not_submitted',
    );
  x.mode = mode;
  x.model_version = modelAliases[(version || 'tripo-p2').toLowerCase()] ?? version;
  if (x.texture === undefined) x.texture = true;
  if (x.pbr === undefined) x.pbr = false;
  if (mode === 'text' && x.prompt === undefined) x.prompt = inputs.join(' ');
  const references = modelImageReferences(mode, inputs, source, flags.viewSlots);
  if (references) Object.assign(x, references.parameters);
  else applyImageSource(x, mode, inputs, source, flags.viewSlots);
  if (flags.seed !== undefined) x.model_seed = flags.seed;
  const requestedTextureQuality = x.texture_quality;
  const warnings = adjustGeneration(x);
  const requirements = {
    ...meshoptRequirement(x, 'model', warnings),
    ...generationTextureModel(x, warnings, requestedTextureQuality),
  };
  return {
    ...step(name, 'model', x, mode === 'text' ? undefined : source),
    warnings,
    ...requirements,
    ...(references ? { imageReferences: references.bindings } : {}),
  };
}
function modelImageReferences(mode: string, inputs: string[], source: string | undefined, views: unknown) {
  if (mode !== 'multiview' || source) return undefined;
  return planImageReferences(Array.isArray(views) ? views : orderViews(inputs));
}
/** 显式无效模型不能退回默认引擎，否则校验失败会变成一次不同的付费生成。 */
function generationVersion(input: Record<string, unknown>, flags: Flags, kind: string): string {
  const imageModel = ['text-to-image', 'image-to-image'].includes(kind) && Object.hasOwn(input, 'model');
  const requested = imageModel
    ? input.model
    : flags.model !== undefined
      ? flags.model
      : Object.hasOwn(input, 'model')
        ? input.model
        : input.model_version;
  if (requested !== undefined && (typeof requested !== 'string' || !requested.trim()))
    throw new TripoError('INVALID_INPUT', 'model must be a nonempty string.', 'not_submitted');
  if (
    ['text-to-image', 'image-to-image'].includes(kind) &&
    requested !== undefined &&
    requested !== text(requested).trim()
  )
    throw new TripoError(
      'INVALID_INPUT',
      'Image model must not contain surrounding whitespace.',
      'not_submitted',
    );
  return text(requested).trim();
}
function imagePixelRequirement(
  input: Record<string, unknown>,
  model: string,
  warnings: string[],
): Pick<PlannedStep, 'imageSize'> {
  const imageSize = applyImageSize(input, model);
  if (!imageSize) return {};
  warnings.push(imageSizeWarning);
  return { imageSize };
}
function imageBackgroundRequirement(
  input: Record<string, unknown>,
  warnings: string[],
): Pick<PlannedStep, 'imageBackground'> {
  const imageBackground = takeImageBackground(input);
  if (!imageBackground) return {};
  warnings.push(imageBackgroundWarning);
  return { imageBackground };
}
function imageGeneration(
  name: string,
  inputs: string[],
  x: Record<string, unknown>,
  flags: Flags,
  version: string,
  source?: string,
): PlannedStep {
  validateImageTemplate(x, name === 'image-to-image');
  if (version) x.model_version = imageAliases[version] ?? version;
  validateImageReferenceCount(
    inputs,
    text(x.model_version) || DEFAULT_IMAGE_MODEL,
    name === 'image-to-image',
  );
  const warnings = applyImagePolicy(x, text(x.model_version) || DEFAULT_IMAGE_MODEL);
  const background = imageBackgroundRequirement(x, warnings);
  const requirements = imageOutputRequirement(x, warnings);
  if (x.aspect_ratio !== undefined) {
    x.scale = x.aspect_ratio;
    delete x.aspect_ratio;
  }
  const pixels = imagePixelRequirement(x, text(x.model_version) || DEFAULT_IMAGE_MODEL, warnings);
  if (x.template) x.template_name = x.template;
  delete x.template;
  const references =
    name === 'image-to-image' ? planImageReferences(inputs, Boolean(flags.editBase)) : undefined;
  if (name === 'text-to-image') {
    if (x.prompt === undefined) x.prompt = inputs.join(' ');
  } else {
    x.prompt = flags.prompt ?? x.prompt;
    if (references) Object.assign(x, references.parameters);
    else if (source) x.image_asset = { asset_id: 'upstream', output_index: 0 };
    else if (inputs.length === 1 || flags.editBase) {
      x.image_path = inputPath(inputs[0]!);
      if (inputs.length > 1) x.image_paths = inputs.slice(1).map(inputPath);
    } else x.image_paths = inputs.map(inputPath);
  }
  if (text(x.prompt).trim().length > 1800)
    throw new TripoError(
      'INVALID_INPUT',
      'Image prompts must be at most 1800 characters in the official CLI contract. Use studio image for the website 10000-character limit.',
    );
  return {
    ...step(name, 'image', x, name === 'image-to-image' ? source : undefined),
    ...requirements,
    ...pixels,
    ...background,
    warnings,
    ...(references ? { imageReferences: references.bindings } : {}),
  };
}
function applyImageSource(
  x: Record<string, unknown>,
  mode: string,
  inputs: string[],
  source?: string,
  explicitViews?: unknown,
): void {
  if (mode === 'image') {
    if (source) x.image_asset = { asset_id: 'upstream', output_index: 0 };
    else x.image_path = inputPath(inputs[0]!);
  }
  if (mode === 'multiview') {
    if (source) x.image_assets = [0, 1, 2, 3].map((output_index) => ({ asset_id: 'upstream', output_index }));
    else
      x.image_paths = (Array.isArray(explicitViews) ? explicitViews : orderViews(inputs)).map((value) =>
        value ? inputPath(text(value)) : null,
      );
  }
}
/** 沿用官方按文件名分配视角的约定；网页缺失视角用空位保持索引，不能左移后面的视图。 */
export function orderViews(inputs: string[]): (string | null)[] {
  if (inputs.length < 2 || inputs.length > 4)
    throw new TripoError('INVALID_INPUT', 'multiview needs 2–4 images.');
  const hints = [/front|正面|前/i, /left|左/i, /back|背面|后/i, /right|右/i];
  const views: (string | undefined)[] = Array(4).fill(undefined);
  const remaining: string[] = [];
  for (const input of inputs) {
    const index = hints.findIndex((hint, i) => !views[i] && hint.test(path.basename(input)));
    if (index < 0) remaining.push(input);
    else views[index] = input;
  }
  for (const input of remaining) views[views.findIndex((v) => !v)] = input;
  if (!views[0]) throw new TripoError('INVALID_INPUT', 'multiview requires a front view.');
  // 网页 B6eazMdU.js 保留四个槽位，缺失侧面明确发送 null。
  return views.map((value) => value ?? null);
}
function smartSegment(source: string, x: Record<string, unknown>): PlannedStep {
  if (isImageSmartSegment(source, x)) {
    const reference = isTaskReference(source);
    return {
      ...step('smartsegment', 'model', {
        ...smartSegmentImageParameters(x),
        ...(reference
          ? { image_asset: { asset_id: 'cli-reference-0', output_index: 0 } }
          : { image_path: inputPath(source) }),
      }),
      // 沿既有图片引用解析器核对账号、图片任务类型、完成状态、资产身份和审核；不把模型task当图片。
      ...(reference ? { imageReferences: [{ reference: source, target: 'image_asset' as const }] } : {}),
      warnings: [smartSegmentImageWarning],
    };
  }
  if (/\.(png|jpe?g|webp)$/i.test(source) || x.transform)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Model smartsegment requires a model source and a verified identity transform. Use seg_type=image for image inputs; native model imports normalize size and axes.',
    );
  x.segmentation_granularity = x.granularity ?? 'medium';
  if (x.hint !== undefined) x.prompt = x.hint;
  x.model = 'v2.0-20260430';
  delete x.seg_type;
  delete x.granularity;
  delete x.hint;
  return processing('segment', source, { param: x });
}
export function processing(name: string, source: string, flags: Flags): PlannedStep {
  if (name === 'rig-check') return { ...processing('rig', source, flags), name, preflight: 'rig' };
  flags = { ...flags, model: flags.model ?? object(flags.param).model };
  const x = parameters(flags);
  if (name === 'smartsegment') return smartSegment(source, x);
  delete x.model;
  const ops: Record<string, Operation> = {
    texture: 'texture',
    convert: 'export',
    import: 'import_model',
    rig: 'rig',
    retarget: 'animate',
    decimate: 'remesh',
    segment: 'segment',
    complete: 'complete',
    uv: 'uv_generate',
    edit: 'local_edit',
  };
  const op = ops[name];
  if (!op) throw new TripoError('INVALID_INPUT', `Unsupported processing step: ${name}`);
  if (name === 'decimate' && flags.model && flags.model !== 'default')
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Studio remesh exposes model_version=default; the requested fixed version has no verified exact Studio mapping and is not replaced with another engine.',
    );
  if (name === 'import')
    return step(name, op, {
      model_path: inputPath(source),
      name: text(flags.name) || inputName(source),
      ...x,
    });
  x.project_id = 'upstream';
  normalizeTexture(name, x, flags);
  normalizeConversion(name, x, flags);
  normalizeAnimation(name, x, flags);
  const requireTextureBaking = x.bake !== false;
  normalizeMesh(name, x, flags);
  const meshopt = takeNativeMeshopt(x, op);
  const automaticAnimations = name === 'convert' && x.with_animation === true && x.animations === undefined;
  const planned: PlannedStep = automaticAnimations
    ? { name, operation: op, parameters: exportIntentSchema.parse(x), source, animationsFromSource: true }
    : step(name, op, x, source);
  const requestedAnimation = parameters(flags).animation;
  if (
    name === 'retarget' &&
    /^preset:[^:]+$/.test(text(requestedAnimation)) &&
    parameters(flags).rig_type === undefined
  )
    planned.genericAnimation = text(requestedAnimation).slice('preset:'.length);
  const finished = finishProcessing(planned, name, x, flags, requireTextureBaking);
  configureExportDefaults(name, x, finished);
  if (meshopt) {
    finished.requireNativeMeshopt = true;
    finished.warnings = [...(finished.warnings ?? []), nativeMeshoptWarning];
  }
  return finished;
}
/** 缺省意图留在本地，首次执行再解析；不改旧计划参数和已收费链的持久布局。 */
function configureExportDefaults(name: string, input: Record<string, unknown>, planned: PlannedStep): void {
  if (name !== 'convert' || input.public_model) return;
  planned.exportDefaults = (
    ['with_animation', 'texture_size', 'animate_in_place', 'export_orientation', 'texture_format'] as const
  ).filter(
    (field) =>
      input[field] === undefined &&
      (field !== 'with_animation' || (!input.enable_bake_animation && input.animations === undefined)),
  );
  if (planned.exportDefaults.includes('texture_format') && input.bake !== false)
    planned.warnings = [...(planned.warnings ?? []), exportJpegDefaultWarning];
}
function importAnimationWarnings(name: string, source: string, flags: Flags): string[] {
  return name === 'convert' && isModelSource(source) && parameters(flags).with_animation !== false
    ? [importedAnimationWarning]
    : [];
}
/** 保护意图单独由 request_policies 持久化，网页字段与旧 UV 请求指纹保持兼容。 */
function finishProcessing(
  planned: PlannedStep,
  name: string,
  input: Record<string, unknown>,
  flags: Flags,
  requireTextureBaking: boolean,
): PlannedStep {
  if (name === 'texture') {
    planned.warnings = textureWarnings(input, flags.model);
    const required = textureModelRequirement(flags.model);
    if (required) planned.requireTextureModel = required;
  }
  if (name === 'uv') {
    planned.requireTextureBaking = requireTextureBaking;
    planned.warnings = [
      requireTextureBaking
        ? 'Studio Smart UV removes textures; existing textures cannot be baked. Textured inputs are rejected before submission unless bake=false.'
        : 'bake=false uses native Studio Smart UV, which removes existing textures and returns geometry with UVs.',
    ];
  }
  if (name === 'convert' && needsExportTransform(input))
    planned.warnings = [
      canExplicitExportJpeg(planned.parameters)
        ? 'Explicit JPEG verifies the exact Studio source before export and uses local texture-only encoding while retaining model structures. Transparent or unsupported textures are rejected; final verification also runs with --no-download.'
        : 'Studio exports GLB; part selection, texture encoding, scale, bottom clipping and pivot are applied locally on download. Blender 4.5+ is required.',
    ];
  if (name === 'convert' && input.bake === false)
    planned.warnings = [
      'bake=false verifies the native static GLB against its frozen source: original embedded texture bytes, basic PBR, unlit/scalar-clearcoat/scalar-color-specular values and per-face UV/colors must be preserved. No skin/animation preservation or material baking is claimed; an unmet result retains its original receipt as needs_attention.',
      ...(nativeUnbakedPivot(input)
        ? [
            'Explicit pivot_to_center_bottom=true verifies the native -y export against the source-derived world bounding-box bottom center. The native file is preserved without local conversion; omitted/false pivot intent is not changed.',
          ]
        : []),
    ];
  return planned;
}
function compatibleExportFormat(value: unknown): string {
  const format = (text(value) || 'glb').toLowerCase();
  return format === 'gltf' ? 'glb' : format;
}
function normalizeConversion(name: string, input: Record<string, unknown>, flags: Flags): void {
  if (name !== 'convert') return;
  input.format = compatibleExportFormat(input.format);
  if (flags.name) input.name = flags.name;
  if (input.bake === false) input.expected_operator_id ??= 'upstream';
}
function validateUnbakedPlan(name: string, file: boolean, flags: Flags): void {
  const input = parameters(flags);
  if (
    name === 'convert' &&
    input.bake === false &&
    (file || input.face_limit !== undefined || input.quad !== undefined || needsExportTransform(input))
  )
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'bake=false requires an existing Studio source and cannot be combined with import or remesh; these can alter materials before the source is frozen.',
      'not_submitted',
    );
}
function normalizeMesh(name: string, x: Record<string, unknown>, flags: Flags): void {
  if (name === 'decimate') normalizeRemesh(x);
  if (name === 'edit' && flags.model && !['P2-20260801', 'p2', 'tripo-p2'].includes(text(flags.model)))
    throw new TripoError('STUDIO_CAPABILITY_UNAVAILABLE', 'Studio local edit requires the P2 pipeline.');
  if (name === 'segment') normalizeSegment(x, flags);
  if (x.segmentation_granularity)
    x.segmentation_granularity =
      ({ coarse: 'simple', medium: 'balanced', fine: 'detailed' } as Record<string, string>)[
        text(x.segmentation_granularity)
      ] ?? x.segmentation_granularity;
  if (name === 'uv') x.current_operator_id = x.current_operator_id ?? 'upstream';
  if (name === 'uv' && typeof x.bake === 'boolean') delete x.bake;
  if (name === 'edit') {
    x.source_operator_id = x.source_operator_id ?? 'upstream';
    if (x.bbox !== undefined) x.bbox = normalizeBbox(x.bbox);
  }
}
/** v2 专属选项不应在显式旧版本中被服务忽略；未知扩展字段仍由后续schema严格检查。 */
function normalizeSegment(x: Record<string, unknown>, flags: Flags): void {
  const guided = ['segmentation_granularity', 'split_by_connectivity', 'ref_image', 'prompt'].some(
    (key) => x[key] !== undefined,
  );
  x.model_version = flags.model ?? (guided ? 'v2.0-20260430' : 'v1.0-20250506');
  if (x.model_version === 'v1.0-20250506' && guided)
    throw new TripoError(
      'INVALID_INPUT',
      'Guided/granular segmentation requires model v2.0-20260430.',
      'not_submitted',
    );
  x.expected_operator_id = x.expected_operator_id ?? 'upstream';
}
function normalizeRemesh(x: Record<string, unknown>): void {
  if (x.smart_uv === false) delete x.smart_uv;
  if (x.face_limit === undefined) x.face_limit = x.quad ? 10000 : 20000;
  if (x.part_names) {
    x.part_name_list = x.part_names;
    delete x.part_names;
  }
}
function normalizeTexture(name: string, x: Record<string, unknown>, flags: Flags): void {
  if (name === 'texture') {
    if (flags.model && !['v3.0', 'v3.0-20250812', 'v3.5', 'v3.5-20260815'].includes(text(flags.model)))
      throw new TripoError(
        'STUDIO_CAPABILITY_UNAVAILABLE',
        'This texture version has no verified exact Studio mapping; another engine is not substituted.',
      );
    normalizeTextureGuidance(x);
  }
}
function normalizeAnimation(name: string, x: Record<string, unknown>, flags: Flags): void {
  if (name === 'rig') {
    validateRigPolicy(x, flags.model);
    x.skeleton_preset = x.spec ?? x.skeleton_preset ?? 'mixamo';
    delete x.spec;
    if (!flags.model && x.rig_type === 'quadruped') x.model_version = 'v2.5-20260210';
    if (flags.model)
      x.model_version =
        (
          {
            'v3.0': 'v3.0-20260909',
            'rig-v3.0': 'v3.0-20260909',
            'v2.5': 'v2.5-20260210',
            'rig-v2.5': 'v2.5-20260210',
            'rig-v2.0': 'v2.5-20260210',
            'v1.0': 'v1.0-20240301',
            'rig-v1.0': 'v1.0-20240301',
          } as Record<string, string>
        )[text(flags.model)] ?? flags.model;
  }
  if (name === 'retarget') {
    const raw = Array.isArray(x.animation) ? x.animation[0] : x.animation;
    if (Array.isArray(x.animation) && x.animation.length > 1)
      throw new TripoError(
        'INVALID_INPUT',
        'Use one retarget command per animation; combine completed operator IDs when exporting.',
      );
    x.animation = text(raw).replace(
      /^preset:(?!biped:|quadruped:|avian:|aquatic:|hexapod:|octopod:|serpentine:)/,
      `preset:${text(x.rig_type) || 'biped'}:`,
    );
    // 官方 retarget 没有独立 --rig-type；已限定种类的预设不能仍落到网页默认 biped。
    if (x.rig_type === undefined) x.rig_type = text(x.animation).split(':')[1];
  }
}
/** 多动作逐个保留任务身份，最终导出完整蒙皮模型；文件输入先执行独立导入任务。 */
function processingFlags(name: string, flags: Flags): { flags: Flags; pbr: boolean; geometry: boolean } {
  flags = {
    ...flags,
    outFormat: flags.outFormat ?? object(flags.param).out_format,
    animateInPlace: flags.animateInPlace ?? object(flags.param).animate_in_place,
  };
  const options = { ...object(flags.param) };
  delete options.out_format;
  if (name === 'retarget') delete options.animate_in_place;
  const pbr = name === 'texture' && options.pbr === true;
  if (name === 'texture') delete options.pbr;
  const geometry = options.export_with_geometry !== false;
  if (name === 'retarget') delete options.export_with_geometry;
  flags = { ...flags, param: options };
  return { flags, pbr, geometry };
}
function conversionRemesh(steps: PlannedStep[], source: string, flags: Flags): boolean {
  const mapped = parameters(flags);
  if (mapped.face_limit === undefined && mapped.quad !== true) return false;
  steps.push(
    processing('decimate', source, {
      param: { face_limit: mapped.face_limit ?? (mapped.quad ? 10000 : 20000), quad: mapped.quad ?? false },
    }),
  );
  delete mapped.face_limit;
  delete mapped.quad;
  steps.push(...processingPlan('convert', 'upstream', { name: flags.name, param: mapped }).steps);
  return true;
}

/** 静态选部件/缩放优先保存到独立网页副本，避免覆盖源资产；复制与编辑各自持久化。 */
function nativeExportSteps(steps: PlannedStep[], source: string, flags: Flags): boolean {
  const x = parameters(flags);
  if (
    (!x.part_names && (x.scale_factor === undefined || x.scale_factor === 1)) ||
    x.with_animation ||
    x.enable_bake_animation ||
    x.public_model
  )
    return false;
  const edits: ExportEdits = {
    ...(x.part_names !== undefined
      ? { part_names: exportIntentSchema.shape.part_names.parse(x.part_names) }
      : {}),
    ...(x.scale_factor !== undefined
      ? { scale_factor: exportIntentSchema.shape.scale_factor.parse(x.scale_factor) }
      : {}),
  };
  const final = { ...x };
  delete final.part_names;
  delete final.scale_factor;
  const exported = processing('convert', 'upstream', { ...flags, scaleFactor: undefined, param: final });
  const copy = step('export-copy', 'copy', { project_id: 'upstream', operator_id: 'upstream' }, source);
  if (x.with_animation === undefined) copy.requireStaticExportSource = true;
  steps.push(copy);
  steps.push({
    ...step(
      'export-edit',
      'project_edit',
      { project_id: 'upstream', expected_operator_id: 'upstream' },
      'upstream',
    ),
    exportEdits: edits,
  });
  exported.warnings = [
    'Static part selection/scale use a separately billed Studio copy, native metadata edit and native export. Each task is resumable; the original project is preserved.',
    ...(exported.warnings ?? []),
  ];
  steps.push(exported);
  return true;
}
function appendAnimations(steps: PlannedStep[], ref: string, flags: Flags, geometry: boolean): void {
  const raw = flags.animation ?? object(flags.param).animations ?? object(flags.param).animation;
  const animations = Array.isArray(raw) ? raw : [raw];
  if (!animations.length || animations.length > 5)
    throw new TripoError('INVALID_INPUT', 'Select 1–5 animations.');
  const param = { ...object(flags.param) };
  delete param.animations;
  delete param.animation;
  for (const animation of animations) steps.push(processing('retarget', ref, { ...flags, animation, param }));
  if (geometry) {
    const exported = processing('convert', 'upstream', {
      format: flags.outFormat ?? 'glb',
      param: { animate_in_place: flags.animateInPlace ?? false },
    });
    exported.animationsFromChain = true;
    steps.push(exported);
  }
}
/** 文件输入独立导入，禁止在需要既有绑定/部件的操作上伪造来源。 */
function processingImports(
  name: string,
  source: string,
  flags: Flags,
  file: boolean,
  transform?: SmartSegmentTransformIntent,
): PlannedStep[] {
  if (name === 'smartsegment' && object(flags.param).transform !== undefined) {
    flags.param = { ...object(flags.param) };
    delete object(flags.param).transform;
  }
  if (file && ['retarget', 'complete'].includes(name))
    throw new TripoError('INVALID_INPUT', `${name} requires an existing task or project.`);
  return file && name !== 'import'
    ? [
        processing('import', source, {
          name: flags.name,
          ...(transform ? { param: { transform_matrix: transform.matrix, use_original_uv: true } } : {}),
        }),
      ]
    : [];
}
/** 显式Lab来源选择单独规划，原处理命令的参数转换仍复用同一入口。 */
function labSourceProcessingPlan(
  name: string,
  source: string,
  supplied: Flags,
  representation: unknown,
): Plan {
  if (representation !== 'studio_normalized' || !isTaskReference(source))
    throw new TripoError(
      'INVALID_INPUT',
      'source_representation=studio_normalized requires an explicit local Lab task or history reference.',
      'not_submitted',
    );
  const param = { ...object(supplied.param) };
  delete param.source_representation;
  const plan = processingPlan(name, source, { ...supplied, param });
  if (
    plan.labReferenceEdit ||
    plan.smartSegmentAffine ||
    plan.smartSegmentScale ||
    plan.smartSegmentTransform ||
    plan.steps.some((step) => step.frontendConvert || step.uvImportFromChain) ||
    !plan.steps.some((step) => step.source === source)
  )
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'This processing combination has no verified continuation from a Lab Studio-normalized representation.',
      'not_submitted',
    );
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.source === source ? { ...step, sourceRepresentation: 'studio_normalized' } : step,
    ),
    sourceValidation: plan.sourceValidation ?? { reference: source, chain: [{ name, param }] },
    warnings: [
      ...plan.warnings,
      'Explicitly selected the actual Studio-normalized representation of a verified Lab result. Studio can center/scale geometry, quantize normals, merge primitives and change metadata. The original Lab artifact and its preservation proof remain unchanged; the selected source and differences are frozen and disclosed.',
      labModelIsolationWarning,
    ],
  };
}
/** Lab扩展仅匹配其显式输入；投影不由参考图猜测，也不丢弃调用方引擎参数。 */
function optionalLabProcessingPlan(name: string, source: string, flags: Flags): Plan | undefined {
  if (name !== 'edit' && name !== 'segment') return;
  const input = parameters(flags);
  if (flags.model !== undefined) input.model = flags.model;
  return name === 'edit' ? labReferenceEditPlan(source, input) : labProjectedSegmentPlan(source, input);
}
export function processingPlan(name: string, source: string, supplied: Flags): Plan {
  const input = parameters(supplied);
  // Lab 同意选择的是其整套可变计费后端，保持原来的专用校验和持久意图。
  if (
    input.accept_variable_cost === undefined ||
    (name === 'edit' && input.ref_image !== undefined) ||
    (name === 'segment' && (input.ref_image !== undefined || input.reference_projection !== undefined))
  )
    return processingPlanCore(name, source, supplied);
  if (input.accept_variable_cost !== true)
    throw new TripoError(
      'INVALID_INPUT',
      'accept_variable_cost must be true when supplied.',
      'not_submitted',
    );
  const param = { ...object(supplied.param) };
  delete param.accept_variable_cost;
  const plan = processingPlanCore(name, source, { ...supplied, param });
  if (!plan.steps.some((entry) => isUnquotedOperation(entry.operation)))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'This processing plan has no reviewed operation that accepts billing without an advance quote. Omit accept_variable_cost.',
      'not_submitted',
    );
  const warning =
    'Explicitly accepted unknown Studio charges for import/apply operations in this processing plan. Submission still requires a current reviewed pricing snapshot; this consent is neither a zero-credit estimate nor a spending cap and cannot be combined with max-credits.';
  return {
    ...plan,
    steps: plan.steps.map((entry) =>
      isUnquotedOperation(entry.operation)
        ? {
            ...entry,
            // 仿射来源的导入文件尚待精确原件准备；只传已校验的同意，不提前补全/校验占位请求。
            parameters: { ...entry.parameters, accept_variable_cost: true },
            warnings: [...(entry.warnings ?? []), warning],
          }
        : entry,
    ),
    warnings: [...plan.warnings, warning],
  };
}
function processingPlanCore(name: string, source: string, supplied: Flags): Plan {
  const representation = object(supplied.param).source_representation;
  if (representation !== undefined) return labSourceProcessingPlan(name, source, supplied, representation);
  if (name === 'uv' && parameters(supplied).compress !== undefined) return compressedUvPlan(source, supplied);
  const adjusted = adjustProcessing(name, supplied);
  const lab = optionalLabProcessingPlan(name, source, adjusted.flags);
  if (lab) return lab;
  // 图片URL也会被普通模型导入规则匹配；必须在导入和单位矩阵消去之前选择图片分支。
  if (name === 'smartsegment' && isImageSmartSegment(source, parameters(adjusted.flags))) {
    const options = smartSegmentImageOptions(parameters(adjusted.flags));
    const image = processing(name, source, adjusted.flags);
    const steps = [image];
    if (options.hint) {
      image.name = 'smartsegment-model';
      const segment = processing('smartsegment', 'upstream', { param: options });
      segment.name = 'smartsegment';
      steps.push(segment);
    }
    return {
      steps,
      pending_uploads: isTaskReference(source) ? [] : [inputPath(source)],
      warnings: [
        ...adjusted.warnings,
        ...(image.warnings ?? []),
        options.hint
          ? smartSegmentImageHintWarning
          : 'Image smartsegment uses the billed Studio H3.1 Generate Parts pipeline.',
      ],
      ...(options.hint
        ? {
            smartSegmentImage: {
              source: isTaskReference(source) ? source : inputPath(source),
              granularity: options.granularity,
              hint: options.hint,
            },
          }
        : {}),
    };
  }
  const affine = plannedAffine(name, source, adjusted.flags);
  if (affine) return affine;
  const orientation = name === 'uv' ? parameters(adjusted.flags).export_orientation : undefined;
  if (orientation !== undefined) {
    // 先校验导出意图，避免 UV 已收费后才发现朝向非法；网页 UV 本身不接收导出参数。
    const exported = processing('convert', 'upstream', { param: { export_orientation: orientation } });
    const param = { ...object(adjusted.flags.param) };
    delete param.export_orientation;
    const uv = buildProcessingPlan(name, source, { ...adjusted.flags, exportOrientation: undefined, param });
    return {
      ...uv,
      steps: [...uv.steps, exported],
      warnings: [...adjusted.warnings, ...uv.warnings, orientationWarning],
      ...(isTaskReference(source)
        ? { sourceValidation: { reference: source, chain: [{ name, param: parameters(supplied) }] } }
        : {}),
    };
  }
  const plan = buildProcessingPlan(name, source, adjusted.flags);
  return {
    ...plan,
    warnings: [...adjusted.warnings, ...plan.warnings, ...importAnimationWarnings(name, source, supplied)],
    ...(isTaskReference(source) && !['import', 'smartsegment'].includes(name)
      ? { sourceValidation: { reference: source, chain: [{ name, param: parameters(supplied) }] } }
      : {}),
  };
}
function plannedAffine(name: string, source: string, flags: Flags): Plan | undefined {
  const affine = name === 'smartsegment' ? smartSegmentAffineMatrix(parameters(flags).transform) : undefined;
  if (affine) {
    const file = isModelSource(source),
      param = { ...parameters(flags) };
    delete param.transform;
    if (file && !/^https?:\/\//i.test(source) && inputExtension(source) !== '.glb')
      throw new TripoError(
        'STUDIO_CAPABILITY_UNAVAILABLE',
        'Native affine smartsegment requires an original GLB file/URL or owned task/project.',
        'not_submitted',
      );
    const first = file
      ? processing('import', source, {
          name: flags.name,
          param: { transform_matrix: smartSegmentIdentity, use_original_uv: true },
        })
      : step('smartsegment-affine-copy', 'copy', { project_id: 'upstream', operator_id: 'upstream' }, source);
    return transferAffinePlan(
      smartSegmentAffinePlan(
        first,
        processing('smartsegment', 'upstream', { ...flags, param }),
        affine,
        file ? inputPath(source) : source,
        file,
        file ? [inputPath(source)] : [],
      ),
    );
  }
}
/** 网页UV本身不产压缩；显式组合原生导入，并把坐标/UV验收约束留在本地。 */
function compressedUvPlan(source: string, flags: Flags): Plan {
  const input = parameters(flags);
  if (input.compress !== 'geometry')
    throw new TripoError('INVALID_INPUT', 'compress must be geometry.', 'not_submitted');
  if (input.export_orientation !== undefined)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'UV compression and export_orientation have no verified combined delivery. Omit export_orientation for the native import-compression chain.',
      'not_submitted',
    );
  const param = { ...object(flags.param) };
  delete param.compress;
  const base = processingPlan('uv', source, { ...flags, param });
  const imported: PlannedStep = {
    ...step('uv-compress', 'import_model', {
      model_path: 'upstream',
      name: 'uv-compressed',
      use_original_uv: true,
    }),
    uvImportFromChain: true,
    warnings: [uvImportWarning],
  };
  return {
    ...base,
    steps: [
      ...base.steps.map((entry) =>
        entry.operation === 'uv_generate' ? { ...entry, requireUvCompressionInput: true as const } : entry,
      ),
      imported,
    ],
    warnings: [...base.warnings, uvImportWarning],
  };
}
function buildProcessingPlan(name: string, source: string, supplied: Flags): Plan {
  if (name === 'decimate' && (supplied.smartUv === true || object(supplied.param).smart_uv === true))
    return remeshWithUv(source, supplied);
  const { flags, pbr, geometry } = processingFlags(name, supplied);
  const file = isModelSource(source);
  const frontend = name === 'convert' ? frontendConvertPlan(source, parameters(flags), file) : undefined;
  if (frontend) return frontend;
  validateUnbakedPlan(name, file, flags);
  const scale = plannedSegmentScale(name, source, flags);
  if (scale) return scaledSmartSegmentPlan(source, flags, file, scale);
  const smartSegmentTransform = plannedSegmentTransform(name, source, flags);
  const steps = processingImports(name, source, flags, file, smartSegmentTransform);
  const ref = steps.length ? 'upstream' : source;
  if (name === 'convert' && conversionRemesh(steps, ref, flags))
    return {
      steps,
      pending_uploads: file ? [inputPath(source)] : [],
      warnings: [
        'Studio convert performs a billed remesh before export; each step has its own task and receipt.',
        ...steps.flatMap((s) => s.warnings ?? []),
      ],
    };
  if (name === 'convert' && nativeExportSteps(steps, ref, flags)) {
    // 后续公共返回负责暴露分步和费用差异。
  } else if (name === 'retarget') {
    appendAnimations(steps, ref, flags, geometry);
  } else {
    steps.push(processing(name, ref, flags));
    if (name === 'uv')
      steps.push(
        step(
          'uv-apply',
          'uv_commit',
          { project_id: 'upstream', current_operator_id: 'source_base', candidate_operator_id: 'upstream' },
          'upstream',
        ),
      );
    if (pbr)
      steps.push(
        processing('texture', 'upstream', {
          param: { action: 'pbr', ...(steps.at(-1)?.requireNativeMeshopt ? { compress: 'geometry' } : {}) },
        }),
      );
    appendRigExport(steps, name, flags);
  }
  return withSegmentTransform(
    {
      steps,
      pending_uploads: file ? [inputPath(source)] : [],
      warnings: steps.flatMap((s) => s.warnings ?? []),
    },
    smartSegmentTransform,
  );
}
function scaledSmartSegmentPlan(source: string, flags: Flags, file: boolean, matrix: number[]): Plan {
  if (file && !/^https?:\/\//i.test(source) && !/\.glb$/i.test(source))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Metadata smartsegment currently requires an original GLB file/URL or an owned task/project.',
      'not_submitted',
    );
  const param = { ...object(flags.param) };
  delete param.transform;
  return {
    smartSegmentScale: { matrix, source_kind: file ? 'file' : 'reference' },
    steps: [
      file
        ? processing('import', source, {
            name: flags.name,
            param: { transform_matrix: smartSegmentIdentity, use_original_uv: true },
          })
        : step('smartsegment-copy', 'copy', { project_id: 'upstream', operator_id: 'upstream' }, source),
      step(
        'smartsegment-scale',
        'project_edit',
        { project_id: 'upstream', expected_operator_id: 'upstream' },
        'upstream',
      ),
      processing('smartsegment', 'upstream', { ...flags, param }),
    ],
    pending_uploads: file ? [inputPath(source)] : [],
    warnings: [smartSegmentScaleWarning],
  };
}
function appendRigExport(steps: PlannedStep[], name: string, flags: Flags): void {
  if (name === 'rig' && flags.outFormat)
    steps.push(processing('convert', 'upstream', { format: flags.outFormat }));
}
function plannedSegmentScale(name: string, source: string, flags: Flags): number[] | undefined {
  return name === 'smartsegment' ? smartSegmentScaleMatrix(object(flags.param).transform, source) : undefined;
}
function plannedSegmentTransform(
  name: string,
  source: string,
  flags: Flags,
): SmartSegmentTransformIntent | undefined {
  return name === 'smartsegment'
    ? checkedSmartSegmentTransform(source, object(flags.param).transform)
    : undefined;
}
function withSegmentTransform(plan: Plan, smartSegmentTransform?: SmartSegmentTransformIntent): Plan {
  return smartSegmentTransform
    ? { ...plan, smartSegmentTransform, warnings: [...plan.warnings, smartSegmentTransformWarning] }
    : plan;
}
/** REST remesh 实测拒绝 smart_uv；通过网页独立 UV 的生成与应用实现同一交付目标，保留分步计费。 */
function remeshWithUv(source: string, supplied: Flags): Plan {
  const param = { ...object(supplied.param) };
  delete param.smart_uv;
  const remesh = processingPlan('decimate', source, { ...supplied, smartUv: undefined, param });
  const uv = processingPlan('uv', 'upstream', {});
  return {
    ...remesh,
    steps: [...remesh.steps, ...uv.steps],
    warnings: [
      ...remesh.warnings,
      'Studio --smart-uv performs remesh, UV generation and UV application as separate tasks; each step uses website pricing.',
    ],
  };
}
const orientationWarning =
  'export_orientation uses a separate native Studio export after generation/UV. Each step has its own task and receipt; --no-wait is unavailable for this chain.';

/** 官方生成朝向仅影响交付文件；保留网页原模型并复用原生导出，不修改生成请求。 */
export function generationPlan(name: string, inputs: string[], flags: Flags): Plan {
  if (name === 'edit-multiview') return editMultiviewPlan(inputs[0]!, flags);
  const param = { ...object(flags.param) };
  const orientation = flags.exportOrientation ?? param.export_orientation;
  const model = ['text-to-model', 'image-to-model', 'multiview-to-model'].includes(name);
  const exported =
    model && orientation !== undefined
      ? processing('convert', 'upstream', { param: { export_orientation: orientation } })
      : undefined;
  if (exported) delete param.export_orientation;
  const initial = generation(name, inputs, {
    ...flags,
    ...(exported ? { exportOrientation: undefined, param } : {}),
  });
  if (exported && initial.requireNativeMeshopt)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Native export_orientation re-exports geometry without verified Meshopt compression. Omit export_orientation when using compress=geometry.',
      'not_submitted',
    );
  const prefix = pSeriesGeneration(initial, (param) => processingPlan('texture', 'upstream', { param }));
  return {
    steps: [...prefix.steps, ...(exported ? [exported] : [])],
    pending_uploads: [],
    warnings: [...(initial.warnings ?? []), ...prefix.warnings, ...(exported ? [orientationWarning] : [])],
    generationSteps: prefix.steps.length + Number(Boolean(exported)),
    ...(prefix.layout ? { generationLayout: prefix.layout } : {}),
    ...(exported ? { generationExport: true } : {}),
  };
}
/** 只有用户显式的全局 PBR 才继承到贴图步骤；步骤自己的 false 优先。 */
function makeChain(flags: Flags, supplied: Flags): ChainStep[] {
  const chain = parseChain(text(flags.then)).map((item) => ({
    ...item,
    param:
      item.name === 'texture' && item.param.pbr === undefined && object(supplied.param).pbr !== undefined
        ? { ...item.param, pbr: object(supplied.param).pbr }
        : item.param,
  }));
  for (const item of chain) if (item.name === 'convert') validatePublicConversion({ param: item.param });
  return chain;
}
function makeInitialPlan(
  classified: ReturnType<typeof classifyMakeInputs>,
  flags: Flags,
  supplied: Flags,
): Plan | undefined {
  const inputs = classified.values;
  if (classified.kind === 'reference') return undefined;
  if (classified.kind === 'model')
    // 场景生成参数不属于模型导入请求；导入已有文件后只执行场景的处理步骤。
    return processingPlan('import', inputs[0]!, { name: flags.name, param: supplied.param });
  if (['image', 'multiview'].includes(classified.kind))
    return generationPlan(
      classified.kind === 'multiview' ? 'multiview-to-model' : 'image-to-model',
      inputs,
      flags,
    );
  return generationPlan('text-to-model', inputs, flags);
}

/** 先验证完整链，再把已知骨架上下文传到动作步骤，避免中途才发现不支持的组合。 */
function makeSteps(initial: Plan | undefined, chain: ChainStep[], source: string): PlannedStep[] {
  const steps = initial ? [...initial.steps] : [];
  const generated = initial?.steps[0];
  validateCompatibilityChain(
    chain,
    generated ? taskType({ operation: generated.operation, input: generated.parameters }) : undefined,
  );
  steps.push(...compileChainTail(chain, 0, steps.length ? 'upstream' : source).steps);
  if (!steps.length)
    throw new TripoError('INVALID_INPUT', 'A task reference requires --then processing steps.');
  return steps;
}

/** 预检后从原始动作意图重编译剩余链；调用方持久化该决定后才允许提交。 */
export function compileChainTail(
  chain: ChainStep[],
  start: number,
  source: string,
  recommendation?: string,
  knownRig?: string,
): { steps: PlannedStep[]; warnings: string[] } {
  const steps: PlannedStep[] = [];
  const warnings: string[] = [];
  let rigType: unknown = knownRig;
  for (let index = start; index < chain.length; index++) {
    const { name, param: original } = chain[index]!;
    let param = { ...original };
    if (name === 'rig') {
      if (recommendation && param.rig_type === undefined) param.rig_type = recommendation;
      rigType = param.rig_type ?? 'biped';
    }
    if (name === 'retarget') {
      const motion = adaptChainMotion(param, rigType, chain[index - 1]?.name === 'rig');
      warnings.push(...motion.warnings);
      if (motion.stopBeforeRetarget) break;
      param = motion.parameters;
      if (rigType && param.rig_type === undefined) param.rig_type = rigType;
    }
    const compiled = processingPlan(name, steps.length ? 'upstream' : source, { param });
    steps.push(...compiled.steps.map((step) => ({ ...step, chainIndex: index })));
  }
  if (warnings.length && steps.length)
    steps[0] = { ...steps[0]!, warnings: [...(steps[0]!.warnings ?? []), ...warnings] };
  return { steps, warnings };
}

/** 按官方 make 输入分类和场景展开计划；只规划，不上传或提交网页任务。 */
export function makePlan(inputs: string[], flags: Flags): Plan {
  const classified = classifyMakeInputs(inputs);
  const supplied = flags;
  flags = scenarioFlags(flags);
  const first = classified.values[0]!;
  const initial = makeInitialPlan(classified, flags, supplied);
  const chain = makeChain(flags, supplied);
  const steps = makeSteps(initial, chain, first);
  if (flags.wait === false && steps.length > 1 && !(flags.requestId && initial?.generationLayout))
    throw new TripoError('INVALID_INPUT', '--no-wait cannot execute a processing chain.');
  return {
    steps,
    chainIntent: chain,
    pending_uploads: steps.flatMap((s) => [
      ...Object.entries(s.parameters)
        .filter(([k]) => k.endsWith('_path') && !(k === 'model_path' && s.uvImportFromChain))
        .map(([, v]) => text(v)),
      ...(Array.isArray(s.parameters.image_paths) ? (s.parameters.image_paths as string[]) : []),
    ]),
    warnings: [...new Set([...(initial?.warnings ?? []), ...steps.flatMap((s) => s.warnings ?? [])])],
    downloadGeneration: flags.for === 'ar-web' && supplied.then === undefined,
    ...(!initial ? { sourceValidation: { reference: first, chain } } : {}),
    ...(initial?.generationExport ? { generationExport: true } : {}),
    ...(initial?.generationSteps ? { generationSteps: initial.generationSteps } : {}),
    ...(initial?.generationLayout ? { generationLayout: initial.generationLayout } : {}),
  };
}
