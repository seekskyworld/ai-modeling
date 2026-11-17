/** 将已校验的领域输入转换为 Studio 操作；复杂的网页字段只在此模块出现。 */
import { advancedOperation } from './advanced-operations.ts';
import { StudioClient } from './client.ts';
import { object, text, array, TripoError } from '../contracts/errors.ts';
import type { Job, Operation } from '../contracts/types.ts';
import { uploadImage, type ImageReference } from './upload.ts';
import { readInput } from '../files.ts';
import { checkSegmentationMetadata } from '../segmentation.ts';
import { isFileToken, loadUpload } from '../auth/uploads.ts';
import { resolveImageTemplate } from './image-templates.ts';
import { textureSubmission } from './texture.ts';
import { needsExportTransform } from '../contracts/export-options.ts';
import { applyModelSymmetry } from './model-symmetry.ts';
import { isPSeries, validateModelSubmission } from '../contracts/model-policy.ts';
import { referenceImageResult } from '../auth/image-admission.ts';
import {
  assertNativeMergeSource,
  assertNativeMetadataSource,
  assertSegmentRouteOperation,
  nativeSegmentJob,
  type SubmissionOptions,
} from './segment-route.ts';

export interface Submission {
  route: string;
  body: Record<string, unknown>;
}
const quality = (value: unknown): string => (value === 'ultra' ? 'extreme' : text(value));
export class Operations {
  constructor(privateClient: StudioClient, roots: string[]) {
    this.client = privateClient;
    this.roots = roots;
  }
  private client: StudioClient;
  private roots: string[];
  async imageReference(input: Record<string, unknown>, file?: string): Promise<ImageReference> {
    const assetRef = object(input.image_asset);
    if (!file && text(assetRef.asset_id)) {
      const asset = object(
        await this.client.request('POST', '/v2/studio/image/get_image_asset', {
          asset_id: assetRef.asset_id,
        }),
      );
      if (asset.status !== 'success' || asset.asset_id !== assetRef.asset_id)
        throw new TripoError('INPUT_NOT_READY', 'Reference image is not ready.');
      const output = object(array(object(asset.output).data)[Number(assetRef.output_index ?? 0)]);
      const auditResult = await referenceImageResult(output, (image) =>
        this.client.request('POST', '/v2/studio/audit/image', { image }),
      );
      return {
        bucket: text(output.bucket),
        key: text(output.key),
        image_audit_result: auditResult,
        image_source: 'generate',
      };
    }
    const source = file ?? text(input.image_path);
    if (isFileToken(source)) {
      if (!source.startsWith('studio_file_image_'))
        throw new TripoError('CONTENT_AUDIT_REJECTED', 'A model upload token cannot be used as an image.');
      const saved = loadUpload(source, this.client.credentials.load()?.accountRef ?? '');
      const auditResult = await referenceImageResult(saved.reference, (image) =>
        this.client.request('POST', '/v2/studio/audit/image', { image }),
      );
      return { ...saved.reference, image_audit_result: auditResult, image_source: 'upload' };
    }
    const image = await readInput(source, this.roots);
    if (object(input._input_files)[source] !== image.sha256)
      throw new TripoError(
        'INPUT_CHANGED',
        'Input image changed after the request was prepared.',
        'not_submitted',
      );
    return await uploadImage(this.client, image.bytes, image.format);
  }
  async build(job: Job, options?: SubmissionOptions): Promise<Submission> {
    const input = job.input;
    assertSegmentRouteOperation(job, options);
    if (job.operation === 'image') return await this.image(input);
    if (job.operation === 'model') return await this.model(input);
    const detail = input.project_id
      ? await this.preflight(
          job.operation,
          text(input.project_id),
          job.operation === 'export' && input.public_model === true,
        )
      : {};
    assertNativeMergeSource(job, detail, options);
    assertNativeMetadataSource(job, detail, options);
    if (input.expected_operator_id && object(detail.operator).operator_id !== input.expected_operator_id)
      throw new TripoError(
        'PROJECT_CHANGED',
        'Model version changed; refresh the source before applying edits.',
        'not_submitted',
      );
    if (job.operation === 'modification' && input.indices_path)
      await checkSegmentationMetadata(input, object(detail.operator).metadata, this.roots);
    if (job.operation === 'resegment' && object(detail.operator).operator_id !== input.operator_id)
      throw new TripoError('PROJECT_CHANGED', 'Refresh the current operator before resegmenting.');
    if (job.operation === 'uv_commit' && object(detail.operator).operator_id !== input.current_operator_id)
      throw new TripoError(
        'PROJECT_CHANGED',
        'The current model changed after UV generation; choose the correct candidate explicitly.',
      );
    const advanced = await advancedOperation(nativeSegmentJob(job, detail, options), {
      client: this.client,
      roots: this.roots,
      imageReference: (x, f) => this.imageReference(x, f),
    });
    if (advanced) return advanced;
    if (job.operation === 'texture')
      return await textureSubmission(input, (x, f) => this.imageReference(x, f));
    if (job.operation === 'rig') return await this.rig(input);
    if (job.operation === 'animate') return this.animate(input, detail);
    return this.export(input, detail);
  }
  private async preflight(
    operation: Operation,
    project: string,
    publicExport = false,
  ): Promise<Record<string, unknown>> {
    const detail = object(
      await this.client.request('GET', `/v2/studio/project/detail/v3/${encodeURIComponent(project)}`),
    );
    const operator = object(detail.operator);
    const flags = { ...detail, ...object(operator.metadata), ...operator };
    if (flags.is_owner !== true && !publicExport)
      throw new TripoError('OWNERSHIP_REQUIRED', 'Only your own Studio projects can be changed.');
    if (
      detail.running_operator ||
      ['prepare', 'queued', 'pending', 'running', 'processing'].includes(text(flags.status))
    )
      throw new TripoError(
        'PROJECT_BUSY',
        'Wait for the current project operation before submitting another.',
      );
    // 网页 free-retry 由当前项目的生成重试额度控制；失败的编辑任务本身不是重试授权。
    if (operation === 'retry' && object(detail.retry_info).can_retry !== true)
      throw new TripoError(
        'STUDIO_CAPABILITY_UNAVAILABLE',
        'Studio does not currently allow a free generation retry for this project.',
        'not_submitted',
      );
    if (['rig', 'animate'].includes(operation) && flags.is_textured === false)
      throw new TripoError('TEXTURE_REQUIRED', 'Texture this project before rigging or animation.');
    if (operation === 'animate' && flags.is_rigged !== true)
      throw new TripoError('RIG_REQUIRED', 'Rig this project before animation.');
    if (['segment', 'resegment'].includes(operation) && flags.is_rigged === true)
      throw new TripoError(
        'STUDIO_CAPABILITY_UNAVAILABLE',
        'Studio segmentation does not support rigged models.',
      );
    if (operation === 'retexture') {
      if (!flags.is_textured)
        throw new TripoError('TEXTURE_REQUIRED', 'Magic Brush requires a textured model.');
      if (flags.is_segmented || flags.is_ultra_textured)
        throw new TripoError(
          'STUDIO_CAPABILITY_UNAVAILABLE',
          'Magic Brush is unavailable for segmented or ultra-textured models.',
        );
    }
    return detail;
  }
  private async image(input: Record<string, unknown>): Promise<Submission> {
    const body: Record<string, unknown> = {
      amount: input.amount,
      if_upload: true,
      model_version: input.model_version,
      prompt: input.prompt ?? '',
      resolution: input.resolution,
      ...(input.scale === 'auto' ? {} : { scale: input.scale }),
      sketch_to_render: input.sketch_to_render,
      t_pose: input.t_pose,
    };
    if (input.template_id) body.template_id = input.template_id;
    if (input.template_name)
      body.template_id = await resolveImageTemplate(this.client, text(input.template_name));
    if (input.image_paths)
      body.images = await Promise.all(
        array(input.image_paths).map((file) => (file ? this.imageReference(input, text(file)) : null)),
      );
    if (input.image_path || input.image_asset) body.image = await this.imageReference(input);
    if (input.image_assets || input.image_sources) body.images = await this.assetReferences(input);
    return { route: '/v2/studio/image/gen_image_v2', body };
  }
  private async model(input: Record<string, unknown>): Promise<Submission> {
    validateModelSubmission(input);
    const lowPoly = isPSeries(input);
    const body: Record<string, unknown> = {
      model_version: input.model_version,
      face_limit: input.face_limit,
      quad: input.quad,
      visibility: input.visibility,
      ...(!lowPoly
        ? { texture: input.texture, smart_poly: input.smart_poly, generate_parts: input.generate_parts }
        : {}),
    };
    for (const key of ['model_seed', 'texture_seed', 'symmetry', 'export_uv'])
      if (input[key] !== undefined) body[key] = input[key];
    if (input.variations) {
      body.variations = input.variations;
      delete body.face_limit;
    }
    // 网页将三个 UI 等级映射成 segmentation_granularity；原别名直接透传会被上游忽略。
    if (input.generate_parts)
      body.segmentation_granularity = { coarse: 'simple', medium: 'balanced', fine: 'detailed' }[
        text(input.generate_parts_level) as 'coarse' | 'medium' | 'fine'
      ];
    if (input.model_version === 'v3.1-20260211') body.geometry_quality = input.geometry_quality;
    if (input.texture)
      Object.assign(body, {
        pbr: input.pbr,
        delight: input.delight,
        texture_alignment: input.texture_alignment,
        texture_quality: quality(input.texture_quality),
      });
    if (input.mode === 'text')
      Object.assign(body, {
        prompt: input.prompt,
        ...(input.negative_prompt !== undefined ? { negative_prompt: input.negative_prompt } : {}),
        gen_image_model_version: 'flux.1_dev',
        sketch_to_render: false,
        t_pose: input.t_pose ?? false,
      });
    else if (input.mode === 'image') {
      body.image = await this.imageReference(input);
      if (!lowPoly) body.enable_image_autofix = input.enable_image_autofix;
    } else if (input.image_assets || input.image_sources) body.image = await this.assetReferences(input);
    else
      body.image = await Promise.all(
        array(input.image_paths).map((file) => (file ? this.imageReference(input, text(file)) : null)),
      );
    if (input.mode === 'batch') {
      body.image = array(body.image).map((image) => ({
        ...object(image),
        ...(body.texture_quality ? { texture_quality: body.texture_quality } : {}),
      }));
      if (!lowPoly) body.enable_image_autofix = input.enable_image_autofix;
    }
    await applyModelSymmetry(this.client, input, body);
    return {
      route: `/v2/studio/operation/${input.mode === 'text' ? 'text_to_model' : input.mode === 'image' ? 'image_to_model' : input.mode === 'batch' ? 'batch_image_to_model' : 'multiview_to_model'}`,
      body,
    };
  }
  private async assetReferences(input: Record<string, unknown>): Promise<(ImageReference | null)[]> {
    const sources = input.image_sources ?? input.image_assets;
    return await Promise.all(
      array(sources).map((source) => {
        if (!source) return null;
        const ref = object(source);
        // 文件继承同一准备阶段摘要，网页素材沿用 asset_id/output_index 审核；两种来源不互换角色。
        return ref.image_path
          ? this.imageReference(input, text(ref.image_path))
          : this.imageReference({ image_asset: ref });
      }),
    );
  }
  private async rig(input: Record<string, unknown>): Promise<Submission> {
    const model_version = text(input.model_version);
    const checked = object(
      await this.client.request('POST', '/v2/studio/operation/pre_rig_check', {
        model_version,
        project_id: input.project_id,
      }),
    );
    if (
      !input.force &&
      (checked.riggable !== true || (input.rig_type !== 'auto' && checked.rig_type !== input.rig_type))
    )
      throw new TripoError(
        'NOT_RIGGABLE',
        'Rig check did not match the requested skeleton; inspect anim check or explicitly set force.',
      );
    const rigType = input.rig_type === 'auto' ? text(checked.rig_type) : text(input.rig_type);
    if (
      !['biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic', 'others'].includes(
        rigType,
      )
    )
      throw new TripoError(
        'INPUT_NOT_READY',
        'Rig precheck returned no supported body type.',
        'not_submitted',
      );
    if (rigType !== 'biped' && !['mixamo', 'tripo'].includes(text(input.skeleton_preset)))
      throw new TripoError(
        'INVALID_INPUT',
        'Non-default skeleton_preset requires biped rigging.',
        'not_submitted',
      );
    if (
      (model_version === 'v1.0-20240301' && rigType !== 'biped') ||
      (rigType === 'others' && model_version !== 'v3.0-20260909')
    )
      throw new TripoError(
        'INVALID_INPUT',
        'The resolved body type is unavailable for this rig model.',
        'not_submitted',
      );
    return {
      route: '/v2/studio/operation/rigging_model',
      body: {
        model_version,
        project_id: input.project_id,
        rig_type: rigType,
        ...(rigType === 'biped' && input.skeleton_preset !== 'tripo' ? { spec: input.skeleton_preset } : {}),
      },
    };
  }
  private animate(input: Record<string, unknown>, detail: Record<string, unknown>): Submission {
    const currentType = text(object(object(detail.operator).rigging).type);
    const requestedType = input.animation ? text(input.animation).split(':')[1] : text(input.rig_type);
    if (currentType && currentType !== requestedType)
      throw new TripoError(
        'INVALID_INPUT',
        'Animation body type does not match the current project rig.',
        'not_submitted',
      );
    if (input.motion_asset_id && currentType !== 'biped')
      throw new TripoError(
        'INPUT_NOT_READY',
        'Generated motion requires a confirmed biped project rig.',
        'not_submitted',
      );
    return {
      route: '/v2/studio/operation/retarget_model',
      body: {
        model_version: 'default',
        project_id: input.project_id,
        rig_type: requestedType,
        ...(input.animation ? { animations: [input.animation] } : { motion_asset_id: input.motion_asset_id }),
      },
    };
  }
  private export(input: Record<string, unknown>, detail: Record<string, unknown>): Submission {
    if (
      input.with_animation === true &&
      !array(input.animations).length &&
      object(detail.operator).is_rigged !== true
    )
      throw new TripoError(
        'RIG_NOT_READY',
        'Exporting a skeleton without motion clips requires a confirmed rigged source.',
        'not_submitted',
      );
    // 真实原生产物保留缩放却丢部件平移；不能用成功回执掩盖坐标错误。
    const transforms = object(object(object(detail.operator).metadata).children_transform_matrix);
    if (
      Object.values(transforms).some((matrix) =>
        array(matrix)
          .slice(12, 15)
          .some((v) => Math.abs(Number(v)) > 1e-7),
      )
    )
      throw new TripoError(
        'NATIVE_EXPORT_TRANSLATION',
        'Studio native export drops edited part translations. Download the original model and use studio model-metadata-apply or local-convert --source-metadata instead.',
        'not_submitted',
      );
    const available = new Set(
      array(object(detail.operator).retarget)
        .map(object)
        .filter((motion) => motion.status === 'success' && text(motion.model_url))
        .map((motion) => text(motion.operator_id)),
    );
    if (array(input.animations).some((motion) => !available.has(text(motion))))
      throw new TripoError(
        'ANIMATION_NOT_READY',
        'Export requires completed animation operator IDs from this project.',
        'not_submitted',
      );
    return {
      route: input.public_model ? '/v2/studio/operation/export-public-model' : '/v2/studio/operation/export',
      body: {
        project_id: input.project_id,
        format: input.format === 'glb' || needsExportTransform(input) ? 'gltf' : input.format,
        name: input.name,
        model_version: 'default',
        texture_size: input.texture_size,
        texture_packaging: needsExportTransform(input) ? 'embedded' : input.texture_packaging,
        fbx_preset: input.fbx_preset,
        with_animation: input.with_animation,
        animations: input.animations,
        animate_in_place: input.animate_in_place,
        pack_uv: input.pack_uv,
        enable_bake_animation: input.enable_bake_animation,
        bake_animation_frame: input.bake_animation_frame,
        export_vertex_colors: input.export_vertex_colors,
        export_orientation: input.export_orientation,
      },
    };
  }
}
