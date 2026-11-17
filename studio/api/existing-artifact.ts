/** 从已有网页素材解析原文件，不创建导出或生成任务；签名链接只供内部下载器使用。 */
import { artifactFormat } from './artifact-format.ts';
import { z } from 'zod';
import { id } from '../contracts/primitives.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
import type { StudioClient } from './client.ts';
import { CanvasClient } from './canvas-client.ts';
import { canvasArtifactSource } from './canvas-artifact.ts';
import { segmentationPreviewUrl } from './semantic-mask.ts';
import { templateImage } from './template-image.ts';
import type { ExistingArtifactSource } from '../contracts/artifact-source.ts';
export const existingArtifactSchema = z
  .object({
    kind: z.enum([
      'image',
      'model',
      'motion',
      'uv_layout',
      'segmentation_preview',
      'template_model',
      'template_image',
      'canvas_input',
      'canvas_node',
      'lab_artifact',
      'lab_input',
    ]),
    id,
    output_index: z.number().int().min(0).max(15).default(0),
    operator_id: id
      .optional()
      .describe(
        'Exact model version or applied motion; required for motion, uv_layout and segmentation_preview.',
      ),
    current_operator_id: id.optional().describe('Original UV context model version, required for uv_layout.'),
    template_id: id
      .optional()
      .describe('Source Canvas template, required for template_model or template_image.'),
    canvas_id: id.optional().describe('Source saved Canvas, required for canvas_input.'),
    node_id: id
      .optional()
      .describe('Exact source node, required for canvas_input, canvas_node and template_image.'),
    job_id: id
      .optional()
      .describe('Remote Lab job ID for lab_artifact or lab_input; not a local CLI job ID.'),
    destination_path: z.string().min(1).max(4096),
  })
  .strict()
  .superRefine((x, ctx) => {
    if (!['model', 'motion', 'uv_layout', 'segmentation_preview'].includes(x.kind) && x.operator_id)
      ctx.addIssue({
        code: 'custom',
        message: 'operator_id is available for model, motion, UV and segmentation preview downloads only.',
      });
    if (x.kind === 'motion' && !x.operator_id)
      ctx.addIssue({
        code: 'custom',
        message: 'Motion download needs the exact applied motion operator_id.',
      });
    if (x.kind === 'segmentation_preview' && !x.operator_id)
      ctx.addIssue({ code: 'custom', message: 'Segmentation preview needs the exact operator_id.' });
    if (x.kind !== 'image' && x.output_index !== 0)
      ctx.addIssue({ code: 'custom', message: 'output_index is available for image downloads only.' });
    if (x.kind === 'uv_layout' && (!x.operator_id || !x.current_operator_id))
      ctx.addIssue({
        code: 'custom',
        message: 'UV layout needs current_operator_id and the selected candidate operator_id.',
      });
    if (x.kind !== 'uv_layout' && x.current_operator_id)
      ctx.addIssue({ code: 'custom', message: 'current_operator_id is only used for uv_layout.' });
    if (['template_model', 'template_image'].includes(x.kind) !== Boolean(x.template_id))
      ctx.addIssue({
        code: 'custom',
        message: 'template_id must be supplied exactly for template_model or template_image.',
      });
    for (const [needed, field] of [
      [x.kind === 'canvas_input', 'canvas_id'],
      [['canvas_input', 'canvas_node', 'template_image'].includes(x.kind), 'node_id'],
      [['lab_artifact', 'lab_input'].includes(x.kind), 'job_id'],
    ] as const)
      if (needed !== Boolean(x[field]))
        ctx.addIssue({ code: 'custom', message: `${field} must be supplied exactly for its source kind.` });
  });
/** 校验服务返回身份及完成状态；不能用另一个最新任务的 URL 替代指定历史版本。 */
export async function existingArtifact(
  client: StudioClient,
  input: z.infer<typeof existingArtifactSchema>,
): Promise<ExistingArtifactSource> {
  const account = client.credentials.load()?.accountRef;
  if (!account) throw new TripoError('AUTH_REQUIRED', 'Sign in to Studio first.');
  const bound = client.forAccount(account);
  if (['canvas_input', 'canvas_node', 'lab_artifact', 'lab_input'].includes(input.kind))
    return await canvasArtifactSource(bound, input);
  if (input.kind === 'template_model') return await templateModel(bound, input.id, input.template_id!);
  if (input.kind === 'template_image')
    return await templateImage(bound, input.template_id!, input.node_id!, input.id);
  if (input.kind === 'uv_layout') {
    const candidate = await uvCandidate(bound, input.id, input.current_operator_id!, input.operator_id!);
    const url = text(object(candidate.uv_layout).url);
    if (!url) throw new TripoError('ARTIFACT_NOT_FOUND', 'Selected UV candidate has no layout image.');
    bound.credentials.load();
    return { url, format: 'image', source_id: input.id, operator_id: input.operator_id };
  }
  if (input.kind === 'image') {
    const asset = object(
      await bound.request('POST', '/v2/studio/image/get_image_asset', { asset_id: input.id }),
    );
    if (asset.asset_id !== input.id)
      throw new TripoError('CONTRACT_CHANGED', 'Studio returned a different image asset.');
    if (asset.status !== 'success')
      throw new TripoError('ARTIFACT_NOT_READY', 'Wait for this image task to complete.');
    const url = text(object(array(object(asset.output).data)[input.output_index]).url);
    if (!url) throw new TripoError('ARTIFACT_NOT_FOUND', 'Selected image output does not exist.');
    bound.credentials.load();
    return { url, format: 'image', source_id: input.id };
  }
  const suffix = input.operator_id ? `?operator_id=${encodeURIComponent(input.operator_id)}` : '';
  const project = object(
    await bound.request('GET', `/v2/studio/project/detail/v3/${encodeURIComponent(input.id)}${suffix}`),
  );
  const operator = object(project.operator);
  if (project.id !== input.id || (input.operator_id && operator.operator_id !== input.operator_id))
    throw new TripoError('CONTRACT_CHANGED', 'Studio returned a different project or history version.');
  if (input.kind === 'motion') return appliedMotion(bound, project, input.id, input.operator_id!);
  if (input.kind === 'segmentation_preview') {
    const url = segmentationPreviewUrl(project, input.id, input.operator_id!);
    bound.credentials.load();
    return { url, format: 'image', source_id: input.id, operator_id: input.operator_id };
  }
  if (operator.status !== 'success' || !text(project.model_url))
    throw new TripoError('ARTIFACT_NOT_READY', 'This model version has no completed original file.');
  bound.credentials.load();
  return {
    url: text(project.model_url),
    format: artifactFormat(text(project.model_url), 'glb'),
    source_id: input.id,
    operator_id: text(operator.operator_id),
  };
}

/** 动作版本的顶层 model_url 仍是主骨架；精确核对其 retarget，不能回退另一个文件。 */
function appliedMotion(
  client: StudioClient,
  project: Record<string, unknown>,
  projectId: string,
  operatorId: string,
): ExistingArtifactSource {
  const operator = object(project.operator);
  if (project.is_owner !== true && operator.is_owner !== true)
    throw new TripoError('OWNERSHIP_REQUIRED', 'Applied motion download requires your own project.');
  const matches = array(operator.retarget)
    .map(object)
    .filter((value) => value.operator_id === operatorId || value.id === operatorId);
  if (!matches.length)
    throw new TripoError('ARTIFACT_NOT_FOUND', 'Selected motion is absent from this project version.');
  const motion = matches[0]!;
  if (
    matches.length !== 1 ||
    motion.operator_id !== operatorId ||
    (motion.id !== undefined && motion.id !== operatorId)
  )
    throw new TripoError('CONTRACT_CHANGED', 'Studio returned inconsistent applied motion identities.');
  if (operator.status !== 'success' || motion.status !== 'success' || !text(motion.model_url))
    throw new TripoError('ARTIFACT_NOT_READY', 'This applied motion has no completed original file.');
  client.credentials.load();
  const format = artifactFormat(text(motion.model_url), 'glb');
  return {
    url: text(motion.model_url),
    // 原动作允许仅含骨骼/clip 的 GLB；使用已有动画结构验证，不能要求它重复携带主网格。
    format: format === 'glb' ? 'animation' : format,
    source_id: projectId,
    operator_id: operatorId,
  };
}

/** 模板模型由专用 RPC 提供原文件；图片模板资源实测不适用，不能假设 URL 的角色。 */
async function templateModel(client: StudioClient, assetId: string, templateId: string) {
  const result = object(
    await new CanvasClient(client).call('/tripo.canvas.api.agent.TemplateService/GetTemplateAssetDetail', {
      assetId,
      templateId,
    }),
  );
  const detail = object(result.detail);
  if (result.assetId !== assetId || result.provider !== 'studio')
    throw new TripoError('CONTRACT_CHANGED', 'Template returned another asset or provider.');
  if (detail.status !== 'success' || !text(detail.model_url))
    throw new TripoError('ARTIFACT_NOT_READY', 'Template model has no completed original file.');
  client.credentials.load();
  return {
    url: text(detail.model_url),
    format: artifactFormat(text(detail.model_url), 'glb'),
    source_id: assetId,
    operator_id: text(detail.operator_id),
  };
}

/** UV 候选绑定生成时的基础 operator；不能用当前选中或最新候选替代指定历史产物。 */
export async function uvCandidate(
  client: Pick<StudioClient, 'request'>,
  projectId: string,
  baseId: string,
  candidateId: string,
): Promise<Record<string, unknown>> {
  const context = object(
    await client.request('POST', '/v2/studio/operation/uv_edit/context', {
      project_id: projectId,
      current_operator_id: baseId,
    }),
  );
  if (context.project_id !== projectId || context.current_operator_id !== baseId)
    throw new TripoError('CONTRACT_CHANGED', 'Studio returned a different UV source context.');
  const candidate = array(context.candidates)
    .map(object)
    .find((value) => value.operator_id === candidateId);
  if (!candidate)
    throw new TripoError('ARTIFACT_NOT_FOUND', 'Selected UV candidate is absent from this source context.');
  return candidate;
}
