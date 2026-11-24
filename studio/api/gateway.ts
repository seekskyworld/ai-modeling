/** 读接口按明确的任务身份解析；不以提示词或资产顺序推断未知提交的归属。 */
import { artifactFormat } from './artifact-format.ts';
import { imageAssets } from './image-assets.ts';
import { modelAssetSummary } from './asset-summary.ts';
import { transactionHistory } from './transaction-history.ts';
import { requiresSemanticMask, semanticMaskUrl } from './semantic-mask.ts';
import { StudioClient } from './client.ts';
import {
  hasModelResults,
  expectedModelCount,
  modelResults,
  modelResultChild,
  modelResultsStatus,
} from './model-results.ts';
import { submitServiceAction } from './service-actions.ts';
import { array, object, text, number, sanitize, TripoError } from '../contracts/errors.ts';
import { needsExportTransform, transformedExportFormat } from '../contracts/export-options.ts';
import type { Artifact, Job, RemoteIds, RemoteStatus, ObservedCost } from '../contracts/types.ts';
import type { ArtifactLinks } from '../auth/artifact-links.ts';
import { Operations } from './operations.ts';
import type { SubmissionOptions } from './segment-route.ts';
import { segmentEntitySnapshot, type SegmentEntitySnapshot } from './segment-entity-snapshot.ts';
import { uvCandidate } from './existing-artifact.ts';
import { prepareInput } from './preparation.ts';
import { submitCanvasRun, canvasRunStatus } from './canvas-run.ts';
import { canvasArtifactUrl, readCanvasRun } from './canvas-artifacts.ts';
import type { Operation } from '../contracts/types.ts';
import { creativeCanvasOperations } from '../contracts/canvas-agent.ts';
import { submitExportBatch, exportBatchStatus, batchChild } from './export-batch.ts';
import { submitCreativeTask, creativeStatus, creativeArtifactUrl, creativeCost } from './canvas-agent.ts';

export interface Gateway {
  segmentEntitySource?(accountRef: string, input: Record<string, unknown>): Promise<SegmentEntitySnapshot>;
  modelVersion?(job: Job): Promise<string>;
  uvSource?(
    accountRef: string,
    input: Record<string, unknown>,
  ): Promise<{ url: string; operator_id: string }>;
  jpegSource?(
    accountRef: string,
    input: Record<string, unknown>,
  ): Promise<{ url: string; operator_id: string }>;
  materialSource?(job: Job): Promise<{ url: string; material_factors: Record<string, unknown> }>;
  prepareInput?(operation: Operation, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  account(): Promise<Record<string, unknown>>;
  submit(
    job: Job,
    beforeSubmit?: () => void,
    options?: SubmissionOptions,
  ): Promise<{ remote_ids: RemoteIds; status?: RemoteStatus }>;
  status(job: Job): Promise<RemoteStatus>;
  artifactUrl(job: Job, artifact: Artifact): Promise<string>;
  cost?(job: Job): Promise<ObservedCost | undefined>;
}
function state(status: string): RemoteStatus['state'] {
  if (status === 'success') return 'succeeded';
  if (['failed', 'banned', 'cancelled', 'expired'].includes(status)) return 'failed';
  if (['prepare', 'queued', 'running', 'pending'].includes(status)) return 'running';
  throw new TripoError('CONTRACT_CHANGED', 'Studio returned an unknown task status.', 'read', {
    remote_status: /^[a-z_-]{1,64}$/.test(status) ? status : 'unrecognized',
  });
}
const modelArtifact = (format = 'glb', kind: 'model' | 'animation' | 'image' = 'model'): Artifact => ({
  artifact_id: 'model',
  kind,
  format,
  index: 0,
});
const exportFormat = (job: Job): string =>
  needsExportTransform(job.input) ? transformedExportFormat(job.input) : text(job.input.format);
/** P2 variations 的多个成功回执不能静默丢弃；无法唯一识别时保留结果未知。 */
function acceptedReceipt(raw: unknown): Record<string, unknown> {
  if (Array.isArray(object(raw).variations)) {
    const variations = array(object(raw).variations).map(object);
    const accepted = variations.filter((v) => v.accepted === true);
    if (!accepted.length && variations.every((v) => v.accepted === false))
      throw new TripoError('STUDIO_REJECTED', 'No model variation was accepted.', 'not_submitted');
    raw = accepted;
  }
  if (Array.isArray(raw) && raw.length !== 1)
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Expected one model receipt; reconcile the account assets.',
      'unknown',
    );
  return object(Array.isArray(raw) ? raw[0] : raw);
}

/** 处理应仍属于原项目，copy 则产生新项目；POST 后身份冲突只能保留未知，不能重提。 */
function verifySubmissionProject(job: Job, receipt: Record<string, unknown>): void {
  if (
    job.operation !== 'copy' &&
    text(job.input.project_id) &&
    receipt.project_id !== undefined &&
    receipt.project_id !== job.input.project_id
  )
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Submission returned a different project identity; reconcile the original request before retrying.',
      'unknown',
    );
}

/** 只校验接口实际回显的身份；URL-only 响应仍不能独立证明其来源。 */
function verifyArtifactIdentity(job: Job, result: Record<string, unknown>, kind: string): void {
  if (
    (result.operator_id !== undefined && result.operator_id !== job.remote_ids.operator_id) ||
    (result.project_id !== undefined && result.project_id !== job.remote_ids.project_id)
  )
    throw new TripoError('CONTRACT_CHANGED', `Studio returned a different ${kind} identity.`);
}

/** UV 应用回执确认期望的版本转换，不把候选生成当作已经替换模型。 */
function uvCommitReceipt(
  job: Job,
  receipt: Record<string, unknown>,
): { remote_ids: RemoteIds; status: RemoteStatus } {
  if (
    receipt.project_id !== job.input.project_id ||
    receipt.previous_operator_id !== job.input.current_operator_id ||
    receipt.current_operator_id !== job.input.candidate_operator_id
  )
    throw new TripoError(
      'CONTRACT_CHANGED',
      'UV application receipt does not match the expected transition; inspect the project before retrying.',
      'unknown',
    );
  return {
    remote_ids: { project_id: text(receipt.project_id), operator_id: text(receipt.current_operator_id) },
    status: { state: 'succeeded', progress: 100, artifacts: [modelArtifact()] },
  };
}

export class StudioGateway implements Gateway {
  client: StudioClient;
  private roots: string[];
  private links: ArtifactLinks;
  constructor(client: StudioClient, roots: string[], links: ArtifactLinks) {
    this.client = client;
    this.roots = roots;
    this.links = links;
  }
  async prepareInput(operation: Operation, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await prepareInput(this.client, operation, input);
  }
  async segmentEntitySource(
    accountRef: string,
    input: Record<string, unknown>,
  ): Promise<SegmentEntitySnapshot> {
    return await segmentEntitySnapshot(this.client, accountRef, input);
  }
  async account(): Promise<Record<string, unknown>> {
    const payment = object(await this.client.request('GET', '/v2/studio/user/profile/payment'));
    const session = this.client.credentials.load()!;
    return {
      authenticated: true,
      account_ref: session.accountRef,
      renewable: Boolean(session.cookie),
      expires_at: session.expiresAt,
      balance: number(object(payment.wallet).total_credit),
      member_type: text(object(payment.member).type),
      observed_at: new Date().toISOString(),
    };
  }
  async submit(
    job: Job,
    beforeSubmit: () => void = () => undefined,
    options?: SubmissionOptions,
  ): Promise<{ remote_ids: RemoteIds; status?: RemoteStatus }> {
    beforeSubmit();
    if (['export_lite', 'refine_submit'].includes(job.operation))
      return await submitServiceAction(this.client.forAccount(job.account_ref), job);
    const client = this.client.forAccount(job.account_ref);
    if (job.operation === 'uv_commit') return await this.commitUv(client, job, beforeSubmit);
    if (job.operation === 'export_batch') return await submitExportBatch(client, this.roots, job);
    if (creativeCanvasOperations.has(job.operation))
      return await submitCreativeTask(client, job, beforeSubmit);
    if (job.operation === 'canvas_run') return await submitCanvasRun(client, job, beforeSubmit);
    const submission = await new Operations(client, this.roots).build(job, options);
    // build 包含网页前置读取；真实发送前重验本机冻结链，不能跨 await 沿用旧身份。
    beforeSubmit();
    const raw = await client.request('POST', submission.route, submission.body, {
      paid: true,
      timeoutMs: 90000,
      beforeSend: beforeSubmit,
    });
    if (hasModelResults(job))
      return {
        remote_ids: modelResults(raw, expectedModelCount(job)),
      };
    const receipt = acceptedReceipt(raw);
    verifySubmissionProject(job, receipt);
    if (['image', 'image_process'].includes(job.operation) && text(receipt.asset_id))
      return { remote_ids: { asset_id: text(receipt.asset_id) } };
    if (job.operation === 'copy' && text(receipt.project_id))
      return {
        remote_ids: {
          project_id: text(receipt.project_id),
          ...(text(receipt.operator_id) ? { operator_id: text(receipt.operator_id) } : {}),
        },
      };
    if (job.operation === 'motion' && text(receipt.task_id))
      return { remote_ids: { task_id: text(receipt.task_id) } };
    if (job.operation === 'export' && text(receipt.model_url)) {
      this.links.set(job.job_id, text(receipt.model_url));
      return {
        remote_ids: {
          project_id: text(job.input.project_id),
          ...(text(receipt.operator_id) ? { operator_id: text(receipt.operator_id) } : {}),
        },
        status: { state: 'succeeded', progress: 100, artifacts: [modelArtifact(exportFormat(job))] },
      };
    }
    if (text(receipt.operator_id))
      return {
        remote_ids: {
          operator_id: text(receipt.operator_id),
          project_id: text(receipt.project_id) || text(job.input.project_id),
        },
      };
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Submission returned no usable remote ID; do not repeat it.',
      'unknown',
    );
  }
  /** 已经应用的候选只读确认成功；回执丢失时也不会再次生成或盲目覆盖更新的模型。 */
  private async commitUv(
    client: StudioClient,
    job: Job,
    beforeSubmit?: () => void,
  ): Promise<{ remote_ids: RemoteIds; status: RemoteStatus }> {
    const detail = object(
      await client.request(
        'GET',
        `/v2/studio/project/detail/v3/${encodeURIComponent(text(job.input.project_id))}`,
      ),
    );
    if (
      detail.id !== job.input.project_id ||
      (detail.is_owner !== true && object(detail.operator).is_owner !== true)
    )
      throw new TripoError('OWNERSHIP_REQUIRED', 'Only your own expected project can be changed.');
    if (object(detail.operator).operator_id === job.input.candidate_operator_id)
      return uvCommitReceipt(job, {
        project_id: job.input.project_id,
        previous_operator_id: job.input.current_operator_id,
        current_operator_id: job.input.candidate_operator_id,
      });
    const submission = await new Operations(client, this.roots).build(job);
    beforeSubmit?.();
    const receipt = object(
      await client.request('POST', submission.route, submission.body, {
        paid: true,
        beforeSend: beforeSubmit,
      }),
    );
    return uvCommitReceipt(job, receipt);
  }
  private async imageAsset(job: Job): Promise<Record<string, unknown>> {
    const asset = object(
      await this.client
        .forAccount(job.account_ref)
        .request('POST', '/v2/studio/image/get_image_asset', { asset_id: job.remote_ids.asset_id }),
    );
    if (asset.asset_id !== job.remote_ids.asset_id)
      throw new TripoError('CONTRACT_CHANGED', 'Studio returned a different image asset.');
    return asset;
  }
  private async project(job: Job): Promise<Record<string, unknown>> {
    if (!job.remote_ids.project_id)
      throw new TripoError('REMOTE_ID_MISSING', 'Project ID is missing; inspect the original task receipt.');
    const query = job.remote_ids.operator_id
      ? `?operator_id=${encodeURIComponent(job.remote_ids.operator_id)}`
      : '';
    const detail = object(
      await this.client
        .forAccount(job.account_ref)
        .request(
          'GET',
          `/v2/studio/project/detail/v3/${encodeURIComponent(job.remote_ids.project_id)}${query}`,
        ),
    );
    // 普通模型历史不能退回项目当前版本；动画详情返回父模型，动作身份由 retarget 列表另行核验。
    if (
      detail.id !== job.remote_ids.project_id ||
      (job.operation !== 'animate' &&
        job.remote_ids.operator_id &&
        object(detail.operator).operator_id !== job.remote_ids.operator_id)
    )
      throw new TripoError('CONTRACT_CHANGED', 'Studio returned a different project or model version.');
    return detail;
  }
  async modelVersion(job: Job): Promise<string> {
    return text(object((await this.project(job)).operator).model_version);
  }
  /** 导出前按冻结 operator 读原模型；导入来源可保留 FBX 等格式，编码预检必须检查实际字节。 */
  async jpegSource(
    accountRef: string,
    input: Record<string, unknown>,
  ): Promise<{ url: string; operator_id: string }> {
    const projectId = text(input.project_id),
      expected = text(input.expected_operator_id);
    const detail = object(
      await this.client
        .forAccount(accountRef)
        .request('GET', `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}`),
    );
    const operator = object(detail.operator),
      operatorId = text(operator.operator_id);
    if (detail.id !== projectId || !operatorId || (expected && expected !== operatorId))
      throw new TripoError('PROJECT_CHANGED', 'The exact source model changed.', 'not_submitted');
    if (detail.is_owner !== true && operator.is_owner !== true)
      throw new TripoError('OWNERSHIP_REQUIRED', 'Source inspection requires your own model.');
    if (operator.status !== 'success' || !text(detail.model_url))
      throw new TripoError('ARTIFACT_NOT_READY', 'The source has no completed original model.', 'read');
    return { url: text(detail.model_url), operator_id: operatorId };
  }
  async uvSource(
    accountRef: string,
    input: Record<string, unknown>,
  ): Promise<{ url: string; operator_id: string }> {
    return await this.jpegSource(accountRef, { ...input, expected_operator_id: input.current_operator_id });
  }
  /** bake=false 另需冻结基础材质与未修改几何，不能借 JPEG 预检放宽该契约。 */
  async materialSource(job: Job): Promise<{ url: string; material_factors: Record<string, unknown> }> {
    if (job.operation !== 'export' || !text(job.input.expected_operator_id))
      throw new TripoError(
        'UNBAKED_SOURCE_UNVERIFIED',
        'bake=false requires an exact source operator.',
        'not_submitted',
      );
    const detail = await this.project({
      ...job,
      remote_ids: {
        project_id: text(job.input.project_id),
        operator_id: text(job.input.expected_operator_id),
      },
    });
    const operator = object(detail.operator);
    if (
      operator.status !== 'success' ||
      !(detail.is_owner === true || operator.is_owner === true) ||
      !text(detail.model_url)
    )
      throw new TripoError(
        'UNBAKED_SOURCE_UNVERIFIED',
        'bake=false requires a completed source model owned by the current account.',
        'not_submitted',
      );
    const metadata = object(operator.metadata);
    // 网页默认的顶层 [] 表示未变换；子部件矩阵和任何非空矩阵仍须逐项验证。
    const sourceTransform = metadata.transform_matrix;
    const transforms = [
      ...(sourceTransform === undefined || (Array.isArray(sourceTransform) && sourceTransform.length === 0)
        ? []
        : [sourceTransform]),
      ...Object.values(object(metadata.children_transform_matrix)),
    ];
    if (
      array(metadata.children_deleted).length ||
      transforms.some(
        (value) =>
          !Array.isArray(value) ||
          value.length !== 16 ||
          Array.from(value).some(
            (v, i) =>
              typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v - (i % 5 === 0 ? 1 : 0)) > 1e-7,
          ),
      )
    )
      throw new TripoError(
        'UNBAKED_MATERIAL_UNSUPPORTED',
        'bake=false cannot verify geometry-changing Studio metadata edits; export a source with unchanged transforms and parts.',
        'not_submitted',
      );
    return {
      url: text(detail.model_url),
      material_factors: operator.is_pbr === true ? object(metadata.material_factor) : {},
    };
  }
  async status(job: Job): Promise<RemoteStatus> {
    if (hasModelResults(job)) return await modelResultsStatus(job, (child) => this.modelStatus(child));
    if (job.operation === 'export_batch')
      return await exportBatchStatus(job, (child) => this.modelStatus(child));
    if (creativeCanvasOperations.has(job.operation))
      return await creativeStatus(this.client.forAccount(job.account_ref), job, this.links);
    if (job.operation === 'canvas_run')
      return await canvasRunStatus(this.client.forAccount(job.account_ref), job, this.links);
    if (['image', 'image_process'].includes(job.operation)) return await this.imageStatus(job);
    return await this.modelStatus(job);
  }
  private async imageStatus(job: Job): Promise<RemoteStatus> {
    const asset = await this.imageAsset(job);
    const current = state(text(asset.status));
    const outputs = array(object(asset.output).data).map(object);
    // 成功状态可能先于输出就绪；空结果一旦落成终态就不会再读网页，须保留原任务继续查询。
    if (current === 'succeeded' && (!outputs.length || outputs.some((output) => !text(output.url))))
      throw new TripoError('ARTIFACT_NOT_READY', 'Studio image outputs are not ready yet.', 'read');
    const artifacts: Artifact[] =
      current === 'succeeded'
        ? outputs.map((output, index) => ({
            artifact_id: `image-${index}`,
            kind: 'image',
            format: artifactFormat(text(output.url), 'image'),
            index,
          }))
        : [];
    return {
      state: current,
      progress: current === 'succeeded' ? 100 : 0,
      artifacts,
      ...(current === 'failed' ? { error: { code: 'REMOTE_TASK_FAILED', remote_status: asset.status } } : {}),
    };
  }
  private async modelStatus(job: Job): Promise<RemoteStatus> {
    if (job.operation === 'copy') return await this.copyStatus(job);
    if (job.operation === 'motion') return await this.motionStatus(job);
    if (!job.remote_ids.operator_id) {
      if (job.operation === 'export' && this.links.get(job.job_id))
        return { state: 'succeeded', progress: 100, artifacts: [modelArtifact(exportFormat(job))] };
      throw new TripoError('REMOTE_ID_MISSING', 'No operator ID is available for this job.');
    }
    const rows = array(
      await this.client
        .forAccount(job.account_ref)
        .request('POST', '/v2/studio/progress', { ids: [job.remote_ids.operator_id] }),
    );
    const progress = rows
      .map(object)
      .find((row) => (row.operator_id ?? row.id) === job.remote_ids.operator_id);
    if (!progress)
      throw new TripoError('CONTRACT_CHANGED', 'Studio omitted the requested operator progress.');
    const current = state(text(progress.status));
    const artifacts = await this.modelArtifacts(job, current);
    return {
      state: current,
      progress: current === 'succeeded' ? 100 : (number(progress.progress) ?? 0),
      ...(current === 'failed'
        ? {
            error: {
              code: 'REMOTE_TASK_FAILED',
              remote_status: progress.status,
              remote_reason: sanitize(progress.reason),
            },
          }
        : {}),
      artifacts,
    };
  }
  private async modelArtifacts(job: Job, current: RemoteStatus['state']): Promise<Artifact[]> {
    const kind =
      job.operation === 'animate' ? 'animation' : job.operation === 'retexture' ? 'image' : 'model';
    const artifact = modelArtifact(
      job.operation === 'export' ? text(job.input.format) : kind === 'image' ? 'image' : 'glb',
      kind,
    );
    if (current === 'succeeded')
      artifact.format = artifactFormat(await this.artifactUrl(job, artifact), artifact.format);
    if (job.operation === 'export' && needsExportTransform(job.input))
      artifact.format = transformedExportFormat(job.input);
    const artifacts: Artifact[] = current === 'succeeded' ? [artifact] : [];
    if (current === 'succeeded' && requiresSemanticMask(job)) {
      const mask = semanticMaskUrl(job, await this.project(job));
      artifacts.push({
        artifact_id: 'semantic-mask',
        kind: 'image',
        format: artifactFormat(mask, 'image'),
        index: 1,
      });
    }
    if (job.operation === 'uv_generate' && current === 'succeeded') {
      const candidate = await uvCandidate(
        this.client.forAccount(job.account_ref),
        text(job.remote_ids.project_id),
        text(job.input.current_operator_id),
        text(job.remote_ids.operator_id),
      );
      const layout = text(object(candidate.uv_layout).url);
      if (layout)
        artifacts.push({
          artifact_id: 'uv-layout',
          kind: 'image',
          format: artifactFormat(layout, 'image'),
          index: 1,
        });
    }
    return artifacts;
  }
  /** 另存接口可能只返回 project_id；先持久化该 ID，再通过只读详情取得 operator。 */
  private async copyStatus(job: Job): Promise<RemoteStatus> {
    const detail = await this.project(job);
    if (detail.id !== job.remote_ids.project_id)
      throw new TripoError('CONTRACT_CHANGED', 'Copied project identity mismatch.');
    const operator = object(detail.operator);
    if (!text(operator.operator_id))
      throw new TripoError('CONTRACT_CHANGED', 'Copied project operator is missing.');
    const current = state(text(operator.status));
    return {
      state: current,
      progress: current === 'succeeded' ? 100 : 0,
      remote_ids: { project_id: job.remote_ids.project_id, operator_id: text(operator.operator_id) },
      artifacts: current === 'succeeded' ? [modelArtifact()] : [],
    };
  }
  private async motionStatus(job: Job): Promise<RemoteStatus> {
    const task = object(
      await this.client
        .forAccount(job.account_ref)
        .request('POST', '/v2/studio/motion/get_task', { task_id: job.remote_ids.task_id }),
    );
    if (task.task_id !== job.remote_ids.task_id)
      throw new TripoError('CONTRACT_CHANGED', 'Motion task identity mismatch.');
    const current = state(text(task.status));
    return {
      state: current,
      progress: current === 'succeeded' ? 100 : 0,
      remote_ids: {
        ...job.remote_ids,
        ...(text(task.asset_id) ? { asset_id: text(task.asset_id) } : {}),
      },
      artifacts: current === 'succeeded' ? [modelArtifact('glb', 'animation')] : [],
      ...(current === 'failed' ? { error: { code: 'REMOTE_TASK_FAILED' } } : {}),
    };
  }
  async artifactUrl(job: Job, artifact: Artifact): Promise<string> {
    if (hasModelResults(job))
      return await this.artifactUrl(modelResultChild(job, artifact.index), {
        ...artifact,
        artifact_id: artifact.artifact_id.startsWith('semantic-mask-') ? 'semantic-mask' : 'model',
        index: 0,
      });
    if (job.operation === 'export_batch')
      return await this.artifactUrl(batchChild(job, artifact.index), {
        ...artifact,
        artifact_id: 'model-0',
        index: 0,
      });
    if (creativeCanvasOperations.has(job.operation))
      return await creativeArtifactUrl(this.client.forAccount(job.account_ref), job, artifact, this.links);
    if (job.operation === 'canvas_run')
      return await canvasArtifactUrl(this.client.forAccount(job.account_ref), job, artifact, this.links);
    let url: string;
    if (artifact.artifact_id === 'semantic-mask') url = semanticMaskUrl(job, await this.project(job));
    else if (['image', 'image_process'].includes(job.operation))
      url = text(object(array(object((await this.imageAsset(job)).output).data)[artifact.index]).url);
    else if (job.operation === 'motion') url = await this.motionUrl(job);
    else if (job.operation === 'retexture') {
      const result = object(
        await this.client
          .forAccount(job.account_ref)
          .request('POST', '/v2/studio/operation/get_retexture', { operator_id: job.remote_ids.operator_id }),
      );
      verifyArtifactIdentity(job, result, 'texture preview');
      url = text(object(result.image).url) || text(result.url);
    } else if (job.operation === 'uv_generate') {
      url = await this.uvArtifactUrl(job, artifact);
    } else if (job.operation === 'export') {
      if (job.remote_ids.operator_id) url = await this.exportUrl(job);
      else url = this.links.get(job.job_id) ?? '';
    } else {
      const project = await this.project(job);
      if (job.operation === 'animate') {
        const operators = object(project.operator);
        const retargets = array(operators.Retarget ?? operators.retarget ?? operators.retarget_model).map(
          object,
        );
        url = text(retargets.find((item) => item.operator_id === job.remote_ids.operator_id)?.model_url);
      } else url = text(project.model_url);
    }
    if (!url) throw new TripoError('ARTIFACT_NOT_READY', 'Studio has not returned this artifact URL yet.');
    return url;
  }
  /** 当前导出接口通常只回 model_url；请求绑定原 operator，只有回显身份时才能额外核验。 */
  private async exportUrl(job: Job): Promise<string> {
    const result = object(
      await this.client
        .forAccount(job.account_ref)
        .request('POST', '/v2/studio/operation/download_with_name', {
          operator_id: job.remote_ids.operator_id,
          file_name: job.input.name,
        }),
    );
    verifyArtifactIdentity(job, result, 'export');
    return text(result.model_url);
  }
  private async uvArtifactUrl(job: Job, artifact: Artifact): Promise<string> {
    try {
      const candidate = await uvCandidate(
        this.client.forAccount(job.account_ref),
        text(job.remote_ids.project_id),
        text(job.input.current_operator_id),
        text(job.remote_ids.operator_id),
      );
      return text(object(artifact.artifact_id === 'uv-layout' ? candidate.uv_layout : candidate.model).url);
    } catch (error) {
      // 应用后2043只关闭候选列表；原模型仍可按精确operator读取，布局由CLI应用前缓存恢复。
      if (
        artifact.artifact_id !== 'model' ||
        !(error instanceof TripoError) ||
        error.details.remote_code !== 2043
      )
        throw error;
      const project = await this.project(job);
      if (
        project.id !== job.remote_ids.project_id ||
        object(project.operator).operator_id !== job.remote_ids.operator_id
      )
        throw new TripoError('CONTRACT_CHANGED', 'Studio returned another UV model version.');
      return text(project.model_url);
    }
  }
  private async motionUrl(job: Job): Promise<string> {
    const client = this.client.forAccount(job.account_ref);
    const task = object(
      await client.request('POST', '/v2/studio/motion/get_task', { task_id: job.remote_ids.task_id }),
    );
    const asset = object(
      await client.request('POST', '/v2/studio/motion/get_asset', { asset_id: task.asset_id }),
    );
    if (
      task.task_id !== job.remote_ids.task_id ||
      asset.task_id !== task.task_id ||
      asset.asset_id !== task.asset_id
    )
      throw new TripoError('CONTRACT_CHANGED', 'Motion artifact identity mismatch.');
    return text(asset.model_url) || text(asset.motion_url);
  }
  async assets(kind: 'model' | 'image', offset: number, limit: number): Promise<Record<string, unknown>> {
    if (kind === 'image') return await imageAssets(this.client, offset, limit);
    const data = object(
      await this.client.request(
        'GET',
        `/v2/studio/assets/v2?asset_type=mine&offset=${offset}&size=${limit}&type=all`,
      ),
    );
    return {
      assets: array(data.projects).map(modelAssetSummary),
      total: data.total,
      next_offset:
        number(data.total) !== undefined && offset + limit < Number(data.total) ? offset + limit : null,
    };
  }
  /** 仅匹配原任务的已履行扣费记录；没有账单不能直接推断费用为零。 */
  async cost(job: Job): Promise<ObservedCost | undefined> {
    if (creativeCanvasOperations.has(job.operation))
      return await creativeCost(this.client.forAccount(job.account_ref), job);
    if (job.operation === 'uv_commit') return undefined;
    const ids = await this.billingIds(job);
    if (!ids.length) return undefined;
    const history = await transactionHistory(this.client.forAccount(job.account_ref));
    const records = history.filter(
      (row) =>
        ids.includes(text(row.operator_id)) &&
        row.txn_type === 'charge' &&
        row.direction === 'sub' &&
        row.status === 'fulfilled' &&
        number(row.amount) !== undefined,
    );
    if (!records.length) return undefined;
    return {
      credits: records.reduce((sum, row) => sum + Number(row.amount), 0),
      source: 'studio_transaction',
      status:
        (['canvas_run', 'export_batch'].includes(job.operation) || hasModelResults(job)) &&
        ids.some((id) => !records.some((row) => row.operator_id === id))
          ? 'partial'
          : 'fulfilled',
      observed_at: new Date().toISOString(),
    };
  }
  private async billingIds(job: Job): Promise<string[]> {
    if (['export_lite', 'refine_submit'].includes(job.operation)) return [];
    if (hasModelResults(job))
      return job.remote_ids.models?.flatMap((r) => (r.operator_id ? [r.operator_id] : [])) ?? [];
    if (job.operation === 'export_batch')
      return job.remote_ids.batch?.flatMap((row) => (row.operator_id ? [row.operator_id] : [])) ?? [];
    if (job.operation === 'canvas_run') {
      const run = await readCanvasRun(this.client.forAccount(job.account_ref), job);
      return [
        ...new Set(
          array(run.steps)
            .map(object)
            .map((step) => text(step.taskId))
            .filter(Boolean),
        ),
      ];
    }
    // 文生动作账单使用 task_id，生成图片通常使用 asset_id；两者不能互相替代。
    return [job.remote_ids.operator_id, job.remote_ids.asset_id, job.remote_ids.task_id].filter(
      (id): id is string => Boolean(id),
    );
  }
}
