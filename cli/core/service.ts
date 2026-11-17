import { labModelSourceSummary, assertLabModelSourceSubmission } from '../compat/lab-model-source.ts';
/** 业务层只依赖稳定接口；重连、MCP 和 CLI 共享同一任务身份与恢复规则。 */
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.ts';
import { errorResult, text, TripoError, object, sanitize } from '../../studio/contracts/errors.ts';
import { fingerprint } from './fingerprint.ts';
import { prepareEntitySegmentInput } from './segment-entity-prepare.ts';
import {
  assertSegmentEntityJob,
  assertSegmentEntitySnapshot,
  segmentEntityMarker,
  segmentEntityFailureView,
  segmentEntitySubmissionOptions,
} from './segment-entity-policy.ts';
import { normalize } from '../../studio/contracts/schemas.ts';
import type { Artifact, Job, Operation, Quote, RemoteStatus } from '../../studio/contracts/types.ts';
import { assertCanvasArtifact, canvasResultView } from '../../studio/contracts/canvas-result.ts';
import { assertCanvasSnapshot, assertCanvasBytes } from './canvas-output.ts';
import { JobStore } from '../storage/jobs.ts';
import type { CredentialStore } from '../../studio/auth/credentials.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { Pricing } from '../../studio/api/pricing.ts';
import { readInput, readModelInput } from '../../studio/files.ts';
import { segmentationInput } from '../../studio/segmentation.ts';
import { requiresSemanticMask } from '../../studio/api/semantic-mask.ts';
import {
  canDiscoverSemanticMasks,
  semanticMaskRefreshIncomplete,
  semanticMaskSummary,
} from './semantic-mask-output.ts';
import { download } from '../artifacts/download.ts';
import { downloadTransformedExport } from '../artifacts/export-transform.ts';
import {
  assertLocalExportProduced,
  assertLocalExportSnapshot,
  localExportTask,
  rejectUnregisteredLocalExportRecovery,
  reusedLocalExportDelivery,
} from '../artifacts/local-export-delivery.ts';
import { recoverDownload } from '../artifacts/recover-download.ts';
import { verifiedArtifactBytes } from '../artifacts/recover-download.ts';
import { recoverVerifiedArtifact } from '../artifacts/verified-output-cache.ts';
import {
  verifyNativeJobOutput,
  hasNativeOutputProof,
  assertNativeOutputIdentity,
  assertNativeOutputSnapshot,
  verifyNativeArtifactBytes,
} from '../artifacts/native-output.ts';
import { nativeMeshoptRequested } from './native-output-policy.ts';
import { reusedUnbakedDelivery } from '../artifacts/unbaked-delivery.ts';
import {
  freezeUnbakedSource,
  verifyUnbakedOutput,
  verifyUnbakedBytes,
} from '../artifacts/unbaked-material.ts';
import {
  unbakedRequested,
  unbakedProofKey,
  hasUnbakedProof,
  assertUnbakedIdentity,
  assertUnbakedSnapshot,
} from './unbaked-material-policy.ts';
import { readTextureModel, hasTextureModelProof } from './texture-version-policy.ts';
import { verifyTextureModel } from '../artifacts/texture-engine.ts';
import { readImageOutputFormat } from './image-output-policy.ts';
import { readImageSize } from './image-size-policy.ts';
import { readImageBackground } from './image-background-policy.ts';
import {
  ensureImageBackground,
  downloadImageBackground,
  imageBackgroundSummary,
} from '../artifacts/image-background-output.ts';
import { ensureImageSize, downloadImageSize, imageSizeSummary } from '../artifacts/image-size-output.ts';
import { ensureImageOutput, hasImageOutputProof, downloadImageOutput } from '../artifacts/image-output.ts';
import {
  assertExportJpegIntent,
  exportJpegRequested,
  nativeExportEncodingReason,
} from './export-jpeg-policy.ts';
import { ensureExportJpeg, downloadExportJpeg, exportJpegSummary } from '../artifacts/export-jpeg-output.ts';
import { assertUvImportIntent, assertUvInputIntent, uvImportPolicy } from './uv-import-policy.ts';
import { assertSmartSegmentTransformStep } from './smartsegment-transform-policy.ts';
import {
  affineFinalParent,
  assertAffineStep,
  assertAffineDelivery,
  freezeAffineSubmissionMarker,
  affineSubmissionOptions,
} from './smartsegment-affine-policy.ts';
import {
  ensureSmartSegmentAffineOutput,
  assertAffineOutputBytes,
  smartSegmentAffineSummary,
} from '../artifacts/smartsegment-affine-output.ts';
import {
  transferFinalParent,
  assertTransferStep,
  freezeTransferSubmissionMarker,
  transferSubmissionOptions,
  assertTransferSnapshot,
  assertTransferDelivery,
} from './smartsegment-affine-transfer-policy.ts';
import {
  ensureSmartSegmentTransferOutput,
  downloadSmartSegmentTransferArtifact,
  assertTransferOutputBytes,
  smartSegmentTransferSummary,
} from '../artifacts/smartsegment-affine-transfer-output.ts';
import { assertScaleMaskSnapshot } from './smartsegment-scale-mask-policy.ts';
import { assertScaleMaskBytes, downloadSmartSegmentScaleMask } from '../artifacts/smartsegment-scale-mask.ts';
import {
  assertSmartSegmentScaleStep,
  assertScaleOutputSnapshot,
  scaleOutputProof,
  smartSegmentScaleRequested,
  scaleSubmissionOptions,
} from './smartsegment-scale-policy.ts';
import {
  ensureSmartSegmentScaleOutput,
  assertScaleOutputBytes,
  smartSegmentScaleSummary,
  reusedSmartSegmentScaleDelivery,
} from '../artifacts/smartsegment-scale-output.ts';
import { ensureUvImport, downloadUvImport, uvImportSummary } from '../artifacts/uv-import-output.ts';
import {
  isMultiviewBundle,
  refreshMultiviewBundle,
  multiviewArtifactSource,
  multiviewSummary,
} from './multiview-bundle.ts';
import { preserveUvLayout } from '../artifacts/uv-cache.ts';
import {
  freezeImportNormalization,
  ensureImportNormalization,
} from '../artifacts/import-normalization-output.ts';
import {
  importNormalizationSummary,
  importNormalizationDeliveryProof,
  assertImportNormalizationSnapshot,
  assertImportNormalizationBytes,
} from './import-normalization-policy.ts';
import { needsExportTransform } from '../../studio/contracts/export-options.ts';
import { resolveDestination } from '../artifacts/destination.ts';
import { variableCanvasOperations } from '../../studio/contracts/canvas-agent.ts';
import { taskType } from '../../studio/contracts/task-type.ts';
import { hasModelResults, reconcileModelResults } from '../../studio/api/model-results.ts';
import { reconcileExportBatch } from '../../studio/api/export-batch.ts';
import {
  frontendOutputRequested,
  frontendOutputView,
  frontendOutputSummary,
  downloadFrontendOutput,
} from './frontend-output.ts';
import {
  assertLabReferenceSubmission,
  assertLabReferenceSnapshot,
  assertLabReferenceBytes,
  labReferenceEditPolicy,
  labReferenceOutputProof,
  labReferenceFailure,
} from '../compat/lab-reference-edit-policy.ts';
import {
  ensureLabReferenceEditOutput,
  labReferenceEditSummary,
  downloadLabReferenceEditArtifact,
} from '../compat/lab-reference-edit-output.ts';

export function jobView(job: Job): Record<string, unknown> {
  return {
    job_id: job.job_id,
    request_id: job.request_id,
    account_ref: job.account_ref,
    operation: job.operation,
    task_type: taskType(job),
    state: job.state,
    remote_ids: job.remote_ids,
    progress: job.progress,
    quote: job.quote,
    observed_cost: job.observed_cost,
    artifacts: job.artifacts,
    error: sanitize(job.error),
    created_at: job.created_at,
    updated_at: job.updated_at,
    next_poll_seconds: ['submitted', 'running'].includes(job.state) ? 5 : null,
    ...(job.state === 'waiting_input'
      ? {
          next_action:
            'Read the Canvas turn/run details and supply the requested choice. This task has not finished.',
        }
      : {}),
    ...(job.state === 'prepared'
      ? {
          next_action:
            'Repeat the original submit call with the same request_id after the other submission finishes.',
        }
      : {}),
    ...semanticMaskSummary(job),
    ...canvasResultView(job),
  };
}

function shouldRefreshCompletedArtifacts(job: Job, refreshCanvas: boolean): boolean {
  return (
    canDiscoverSemanticMasks(job) ||
    (job.state === 'succeeded' &&
      ((job.operation === 'canvas_run' && refreshCanvas) ||
        (job.operation === 'motion' && !job.remote_ids.asset_id)))
  );
}
/** 远端派生的报价元数据不属于调用方意图；重查已提交任务时不应依赖仍可变化的画布。 */
function intentInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !['_canvas_quotes', '_canvas_action', '_image_source', segmentEntityMarker].includes(key),
    ),
  );
}
function sameIntent(existing: Job, operation: Operation, input: Record<string, unknown>): boolean {
  return (
    fingerprint({ operation: existing.operation, input: intentInput(existing.input) }) ===
    fingerprint({ operation, input })
  );
}
/** 没有受信额外策略时保留旧 Gateway 的 undefined 调用契约。 */
function submissionOptions(jobs: JobStore, job: Job) {
  const options = {
    ...segmentEntitySubmissionOptions(jobs, job),
    ...scaleSubmissionOptions(jobs, job),
    ...affineSubmissionOptions(jobs, job),
    ...transferSubmissionOptions(jobs, job),
  };
  return Object.keys(options).length ? options : undefined;
}
/** 部分结果可显示，但提交者提供的全部回执读验成功前不能绑定新的远端身份。 */
function requireVerifiedReceipts(status: RemoteStatus): void {
  if (Array.isArray(status.error?.poll_errors) && status.error.poll_errors.length)
    throw new TripoError(
      status.state === 'requires_login' ? 'AUTH_REQUIRED' : 'RECONCILE_NOT_VERIFIED',
      'Some receipts could not be verified. Keep the original job and retry verification with the same receipts.',
    );
}
export class TaskService {
  jobs: JobStore;
  gateway: Gateway;
  credentials: CredentialStore;
  pricing: Pricing;
  config: Config;
  constructor(deps: {
    jobs: JobStore;
    gateway: Gateway;
    credentials: CredentialStore;
    pricing: Pricing;
    config: Config;
  }) {
    this.jobs = deps.jobs;
    this.gateway = deps.gateway;
    this.credentials = deps.credentials;
    this.pricing = deps.pricing;
    this.config = deps.config;
  }
  /** 来源披露跟随持久子请求，submit/get/list及恢复使用同一份冻结证明。 */
  private view(job: Job): Record<string, unknown> {
    return { ...jobView(job), ...labModelSourceSummary(this.jobs, job) };
  }
  accountRef(): string {
    const ref = this.credentials.load()?.accountRef;
    if (!ref) throw new TripoError('AUTH_REQUIRED', 'Import and verify your Studio session with auth login.');
    return ref;
  }
  private own(job: Job): void {
    if (job.account_ref !== this.accountRef())
      throw new TripoError('ACCOUNT_MISMATCH', 'Restore the original account to access this job.');
  }
  private requireAccount(account: string): void {
    if (this.accountRef() !== account)
      throw new TripoError(
        'ACCOUNT_MISMATCH',
        'The active account changed while preparing the original request.',
        'not_submitted',
      );
  }
  async quote(operation: Operation, parameters: unknown): Promise<Quote> {
    const input = normalize(operation, parameters);
    return await this.pricing.quote(
      operation,
      (await this.gateway.prepareInput?.(operation, input)) ?? input,
    );
  }
  private async prepareInputs(operation: Operation, parameters: unknown): Promise<Record<string, unknown>> {
    const input = normalize(operation, parameters);
    const hashes: Record<string, string> = {};
    if (operation === 'modification' && input.indices_path) {
      const prepared = await segmentationInput(input, this.config.inputRoots);
      hashes[text(input.indices_path)] = prepared.sha256;
      input.expected_operator_id = prepared.operatorId;
    }
    const files = [
      ...(input.image_path ? [text(input.image_path)] : []),
      ...(input.style_image_path ? [text(input.style_image_path)] : []),
      ...(Array.isArray(input.image_paths) ? input.image_paths.filter(Boolean).map(text) : []),
      ...(Array.isArray(input.image_sources)
        ? input.image_sources.map((source) => text(object(source).image_path)).filter(Boolean)
        : []),
    ];
    for (const entry of Array.isArray(input.image_map) ? input.image_map : [])
      files.push(text(object(entry).image_path));
    if (input.model_path)
      hashes[text(input.model_path)] = (
        await readModelInput(text(input.model_path), this.config.inputRoots)
      ).sha256;
    for (const file of files) hashes[file] = (await readInput(file, this.config.inputRoots)).sha256;
    if (Object.keys(hashes).length) input._input_files = hashes;
    return input;
  }
  private async enrichInputs(
    operation: Operation,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return (await this.gateway.prepareInput?.(operation, input)) ?? input;
  }
  private async checkBudget(
    operation: Operation,
    input: Record<string, unknown>,
    quote: Quote,
    maximum: number,
  ): Promise<void> {
    const variable =
      (variableCanvasOperations.has(operation) || operation === 'refine_submit') &&
      input.accept_variable_cost === true &&
      quote.variable === true;
    if (!variable && (!Number.isFinite(maximum) || maximum < 0))
      throw new TripoError(
        'INVALID_INPUT',
        'max_estimated_credits must be a finite nonnegative number.',
        'not_submitted',
      );
    if ((!quote.known || quote.credits === undefined) && !variable)
      throw new TripoError('PRICE_UNKNOWN', quote.explanation, 'not_submitted');
    if (quote.credits !== undefined && quote.credits > maximum)
      throw new TripoError(
        'ESTIMATE_EXCEEDS_BUDGET',
        'Estimated credits exceed max_estimated_credits.',
        'not_submitted',
        { estimated_credits: quote.credits },
      );
    const status = await this.gateway.account();
    if (typeof status.balance === 'number' && quote.credits !== undefined && status.balance < quote.credits)
      throw new TripoError(
        'INSUFFICIENT_CREDITS',
        'Available credits are below the conservative estimate.',
        'not_submitted',
      );
  }
  async submit(
    operation: Operation,
    requestId: string,
    parameters: unknown,
    maximum: number,
  ): Promise<Record<string, unknown>> {
    this.jobs.recoverExpired();
    const account = this.accountRef();
    const original = await this.prepareInputs(operation, parameters);
    freezeAffineSubmissionMarker(this.jobs, account, requestId, operation, original);
    freezeTransferSubmissionMarker(this.jobs, account, requestId, operation, original);
    assertExportJpegIntent(this.jobs, account, requestId, operation, original);
    assertUvImportIntent(this.jobs, account, requestId, operation, original);
    assertUvInputIntent(this.jobs, account, requestId, operation, original);
    assertSmartSegmentTransformStep(this.jobs, account, requestId, operation, original);
    assertSmartSegmentScaleStep(this.jobs, account, requestId, operation, original);
    assertAffineStep(this.jobs, account, requestId, operation, original);
    assertTransferStep(this.jobs, account, requestId, operation, original);
    assertLabReferenceSubmission(this.jobs, account, requestId, operation, original);
    assertLabModelSourceSubmission(this.jobs, account, requestId, operation, original);
    const existing = this.jobs.find(account, requestId);
    if (existing) {
      if (!sameIntent(existing, operation, original))
        throw new TripoError('IDEMPOTENCY_CONFLICT', 'request_id already belongs to different inputs.');
      if (existing.state !== 'prepared') return await this.nativeOutputView(existing);
      assertSegmentEntityJob(this.jobs, existing, true);
    }
    if (!existing && operation === 'import_model')
      await freezeImportNormalization(
        {
          jobs: this.jobs,
          dataDir: this.config.dataDir,
          inputRoots: this.config.inputRoots,
          checkAccount: () => this.requireAccount(account),
        },
        account,
        requestId,
        original,
      );
    let input = await this.enrichInputs(operation, original);
    // 旧请求不回填新路线；首次准备和已有实体策略恢复核对同一原件及完整 metadata。
    if (!existing || existing.input[segmentEntityMarker] !== undefined)
      input = await prepareEntitySegmentInput({
        jobs: this.jobs,
        gateway: this.gateway,
        account,
        request: requestId,
        operation,
        input,
        dataDir: this.config.dataDir,
        checkAccount: () => this.requireAccount(account),
      });
    if (operation === 'uv_commit') {
      const candidate = this.jobs.uvCandidate(
        account,
        text(input.project_id),
        text(input.current_operator_id),
        text(input.candidate_operator_id),
      );
      if (candidate) await preserveUvLayout(candidate, this.config, this.jobs, this.gateway);
    }
    const quote = await this.pricing.quote(operation, input);
    await this.checkBudget(operation, input, quote, maximum);
    // 价格/余额读取期间来源可能被另一进程推进；持久化前再次核对完整矩阵义务。
    assertSmartSegmentTransformStep(this.jobs, account, requestId, operation, original);
    assertSmartSegmentScaleStep(this.jobs, account, requestId, operation, original);
    assertAffineStep(this.jobs, account, requestId, operation, original);
    assertTransferStep(this.jobs, account, requestId, operation, original);
    assertLabReferenceSubmission(this.jobs, account, requestId, operation, original);
    assertLabModelSourceSubmission(this.jobs, account, requestId, operation, original);
    this.requireAccount(account);
    assertSegmentEntityJob(
      this.jobs,
      {
        account_ref: account,
        request_id: requestId,
        operation,
        input,
        input_hash: fingerprint({ operation, input }),
      },
      true,
    );
    const job = this.jobs.prepare(account, requestId, operation, input, quote);
    assertSegmentEntityJob(this.jobs, job, true);
    if (!this.jobs.claim(job.job_id)) return await this.nativeOutputView(this.jobs.get(job.job_id));
    let sent = false;
    try {
      this.own(job);
      await freezeUnbakedSource(job, this.jobs, this.config.dataDir, this.gateway);
      this.own(job);
      assertSmartSegmentTransformStep(this.jobs, account, requestId, operation, original);
      assertSmartSegmentScaleStep(this.jobs, account, requestId, operation, original);
      assertAffineStep(this.jobs, account, requestId, operation, original);
      assertTransferStep(this.jobs, account, requestId, operation, original);
      assertLabReferenceSubmission(this.jobs, account, requestId, operation, original);
      assertLabModelSourceSubmission(this.jobs, account, requestId, operation, original);
      assertSegmentEntityJob(this.jobs, job, true);
      sent = true;
      const receipt = await this.gateway.submit(
        job,
        () => {
          this.own(job);
          const current = this.jobs.get(job.job_id);
          if (
            current.state !== 'submitting' ||
            current.account_ref !== job.account_ref ||
            current.operation !== job.operation ||
            fingerprint(current.input) !== fingerprint(job.input) ||
            fingerprint(current.remote_ids) !== fingerprint(job.remote_ids)
          )
            throw new TripoError(
              'SUBMISSION_IDENTITY_CHANGED',
              'The claimed task changed before the operation could be sent.',
              'not_submitted',
            );
          assertSmartSegmentTransformStep(this.jobs, account, requestId, operation, original);
          assertSmartSegmentScaleStep(this.jobs, account, requestId, operation, original);
          assertAffineStep(this.jobs, account, requestId, operation, original);
          assertTransferStep(this.jobs, account, requestId, operation, original);
          assertLabReferenceSubmission(this.jobs, account, requestId, operation, original);
          assertLabModelSourceSubmission(this.jobs, account, requestId, operation, original);
          assertSegmentEntityJob(this.jobs, current, true);
        },
        submissionOptions(this.jobs, job),
      );
      const next = receipt.status;
      return await this.nativeOutputView(
        this.jobs.update(job.job_id, next?.state ?? 'submitted', {
          remote_ids: receipt.remote_ids,
          progress: next?.progress,
          artifacts: next?.artifacts,
          error: next?.error,
        }),
      );
    } catch (error) {
      const failure =
        error instanceof TripoError
          ? error
          : new TripoError(
              'SUBMISSION_INTERRUPTED',
              'The submission did not finish with a persisted receipt.',
              sent ? 'unknown' : 'not_submitted',
            );
      // 预检的 read 错误由适配层保证发生在 POST 前；付费 POST 的异常必须携带 unknown。
      const state = failure.certainty === 'unknown' ? 'outcome_unknown' : 'failed';
      return this.view(this.jobs.update(job.job_id, state, { error: errorResult(failure) }));
    }
  }
  async get(jobId: string, waitSeconds = 0): Promise<Record<string, unknown>> {
    this.jobs.recoverExpired();
    let job = this.jobs.get(jobId);
    this.own(job);
    if (isMultiviewBundle(job)) return await this.getMultiview(job, waitSeconds);
    const deadline = Date.now() + Math.min(30, Math.max(0, waitSeconds)) * 1000;
    for (;;) {
      if (!['submitted', 'running', 'requires_login', 'waiting_input'].includes(job.state))
        return await this.completedView(job);
      try {
        const status = await this.gateway.status(job);
        job = this.jobs.update(jobId, status.state, {
          remote_ids: status.remote_ids,
          progress: status.progress,
          artifacts: status.artifacts,
          error: status.error,
        });
      } catch (error) {
        if (error instanceof TripoError && error.code === 'AUTH_REQUIRED')
          job = this.jobs.update(jobId, 'requires_login', { error: errorResult(error) });
        else return { ...this.view(job), poll_error: errorResult(error) };
      }
      if (Date.now() >= deadline || !['submitted', 'running'].includes(job.state))
        return await this.completedView(job, false);
      await delay(Math.min(5000, deadline - Date.now()));
    }
  }
  private async getMultiview(job: Job, waitSeconds: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + Math.min(30, Math.max(0, waitSeconds)) * 1000;
    for (;;) {
      const refreshed = await refreshMultiviewBundle(this.jobs, job, async (id) => this.get(id));
      job = refreshed.job;
      const view = { ...this.view(job), ...refreshed.summary };
      if (!['running', 'submitted'].includes(text(view.state)) || Date.now() >= deadline) return view;
      await delay(Math.min(5000, deadline - Date.now()));
    }
  }
  private async completedView(job: Job, refreshCanvas = true): Promise<Record<string, unknown>> {
    const frontend = await frontendOutputView(this.jobs, this.config.dataDir, job);
    if (frontend) return { ...this.view(this.jobs.get(job.job_id)), ...frontend };
    if (shouldRefreshCompletedArtifacts(job, refreshCanvas)) {
      try {
        const refreshed = await this.gateway.status(job);
        // 只读补全原运行/版本的迟到或新增产物；已下载文件及来源索引不改变。
        const artifacts = [...job.artifacts];
        for (const artifact of refreshed.artifacts)
          if (!artifacts.some((saved) => saved.artifact_id === artifact.artifact_id))
            artifacts.push({
              ...artifact,
              index: requiresSemanticMask(job) ? artifact.index : artifacts.length,
            });
        job = this.jobs.update(job.job_id, job.state, {
          remote_ids: refreshed.remote_ids,
          artifacts,
          error: job.error,
        });
        if (semanticMaskRefreshIncomplete(job, refreshed))
          return {
            ...this.view(job),
            ...(job.state === 'succeeded' ? { state: 'needs_attention', remote_state: 'succeeded' } : {}),
            poll_error: refreshed.error ?? {
              code: 'SEGMENTATION_PREVIEW_UNVERIFIED',
              message: 'The original model results could not all be refreshed.',
            },
          };
      } catch (error) {
        return { ...this.view(job), poll_error: errorResult(error) };
      }
    }
    if (
      !['succeeded', 'failed'].includes(job.state) ||
      job.observed_cost?.status === 'fulfilled' ||
      !this.gateway.cost
    )
      return await this.nativeOutputView(job);
    try {
      const cost = await this.gateway.cost(job);
      return await this.nativeOutputView(
        cost ? this.jobs.update(job.job_id, job.state, { observed_cost: cost }) : job,
      );
    } catch (error) {
      return { ...(await this.nativeOutputView(job)), cost_lookup_error: errorResult(error) };
    }
  }
  private async deliveryView(job: Job): Promise<Record<string, unknown> | undefined> {
    if (job.state !== 'succeeded') return;
    if (transferFinalParent(job)) return await this.smartSegmentTransferView(job);
    if (smartSegmentScaleRequested(this.jobs, job) || affineFinalParent(job))
      return await this.smartSegmentScaleView(job);
    if (uvImportPolicy(this.jobs, job)) return await this.uvImportView(job);
    if (
      readImageOutputFormat(this.jobs, job) ||
      readImageSize(this.jobs, job) ||
      readImageBackground(this.jobs, job)
    )
      return await this.imageOutputView(job);
    if (exportJpegRequested(this.jobs, job)) return await this.exportJpegView(job);
    const nativeEncodingReason = nativeExportEncodingReason(this.jobs, job);
    if (nativeEncodingReason)
      return {
        ...this.view(job),
        jpeg_output_validation: {
          status: 'native_preserved',
          texture_format: 'unverified_native',
          reason: nativeEncodingReason,
        },
      };
  }
  /** 新三步有独立原件及双几何义务，不能借用旧七步的成功证明。 */
  private async smartSegmentTransferView(job: Job): Promise<Record<string, unknown>> {
    try {
      if (
        !job.artifacts.some((a) => a.kind === 'model') ||
        !job.artifacts.some((a) => a.artifact_id === 'semantic-mask')
      ) {
        const status = await this.gateway.status(job);
        this.own(job);
        if (status.state === 'succeeded')
          job = this.jobs.update(job.job_id, job.state, { artifacts: status.artifacts });
      }
      await ensureSmartSegmentTransferOutput(this.jobs, job, this.config.dataDir, this.gateway, () =>
        this.own(job),
      );
      this.own(job);
      job = this.jobs.get(job.job_id);
      return { ...this.view(job), ...smartSegmentTransferSummary(this.jobs, job) };
    } catch (error) {
      return {
        ...this.view(job),
        state: 'needs_attention',
        remote_state: 'succeeded',
        error: errorResult(error),
        smartsegment_affine_transfer_validation: {
          status: 'unverified',
          mechanism: 'pure_rotation_import',
          native_step_count: 3,
        },
        next_action:
          'Verify the original affine transfer and its exact GLB/PNG again; do not repeat any native submission.',
      };
    }
  }
  private async smartSegmentScaleView(job: Job): Promise<Record<string, unknown>> {
    try {
      if (
        !job.artifacts.some((a) => a.kind === 'model') ||
        !job.artifacts.some((a) => a.artifact_id === 'semantic-mask')
      ) {
        const status = await this.gateway.status(job);
        if (status.state === 'succeeded')
          job = this.jobs.update(job.job_id, job.state, { artifacts: status.artifacts });
      }
      await ensureSmartSegmentScaleOutput(this.jobs, job, this.config.dataDir, this.gateway, () =>
        this.own(job),
      );
      await ensureSmartSegmentAffineOutput(this.jobs, job, this.config.dataDir, this.gateway, () =>
        this.own(job),
      );
      this.own(job);
      job = this.jobs.get(job.job_id);
      return {
        ...this.view(job),
        ...smartSegmentScaleSummary(this.jobs, job, this.config.dataDir),
        ...smartSegmentAffineSummary(this.jobs, job),
      };
    } catch (error) {
      return {
        ...this.view(job),
        state: 'needs_attention',
        remote_state: 'succeeded',
        error: errorResult(error),
        smartsegment_transform_validation: {
          status: 'unverified',
          mechanism: 'native_metadata_then_segmentation',
        },
        ...(affineFinalParent(job)
          ? {
              smartsegment_affine_validation: {
                status: 'unverified',
                mechanism: 'native_two_trs_and_merge',
                native_step_count: 7,
              },
            }
          : {}),
        next_action:
          'Verify the original scaled segmentation again; do not import, copy, edit or segment again.',
      };
    }
  }
  /** 本地约束失败不改远端 succeeded，防止被误认为可重提；兼容结果明确 needs_attention。 */
  private async nativeOutputView(job: Job): Promise<Record<string, unknown>> {
    const routeFailure = segmentEntityFailureView(this.jobs, job);
    if (routeFailure) return { ...this.view(job), ...routeFailure };
    const lab = await ensureLabReferenceEditOutput(this.jobs, this.gateway, this.config.dataDir, job, () =>
      this.own(job),
    );
    if (lab) return { ...this.view(this.jobs.get(job.job_id)), ...lab };
    const frontend = await frontendOutputView(this.jobs, this.config.dataDir, job);
    if (frontend) return { ...this.view(this.jobs.get(job.job_id)), ...frontend };
    const delivery = await this.deliveryView(job);
    if (delivery) return delivery;
    const meshopt = nativeMeshoptRequested(this.jobs, job),
      texture = readTextureModel(this.jobs, job),
      unbaked = unbakedRequested(job),
      hasRequirements = [meshopt, texture, unbaked].some(Boolean);
    if (job.operation === 'import_model' && !hasRequirements)
      return {
        ...this.view(job),
        ...(await ensureImportNormalization(
          {
            jobs: this.jobs,
            dataDir: this.config.dataDir,
            checkAccount: () => this.requireAccount(job.account_ref),
          },
          this.gateway,
          job,
        )),
      };
    if (job.state !== 'succeeded' || !hasRequirements) return this.view(job);
    const requirements = {
      ...(meshopt ? { geometry_compression: 'meshopt' } : {}),
      ...(texture ? { texture_model: texture } : {}),
      ...(unbaked ? { bake: false } : {}),
    };
    try {
      // 即时成功回执可能早于模型列表；只按原回执补查，不能永久卡在缺产物的本地终态。
      if ((meshopt || unbaked) && !job.artifacts.some((artifact) => artifact.kind === 'model')) {
        const status = await this.gateway.status(job);
        if (status.state === 'succeeded')
          job = this.jobs.update(job.job_id, job.state, { artifacts: status.artifacts });
      }
      await verifyTextureModel(job, this.jobs, this.gateway);
      await verifyUnbakedOutput(job, this.jobs, this.config.dataDir, this.gateway);
      const validation = meshopt
        ? await verifyNativeJobOutput(job, this.jobs, this.config.dataDir, this.gateway)
        : { status: 'verified' };
      const verifiedJob = this.checkedNativeJob(job.job_id, meshopt, unbaked);
      return {
        ...this.view(verifiedJob),
        native_output_validation: {
          ...validation,
          ...requirements,
          ...(unbaked ? { materials_preserved: true } : {}),
        },
      };
    } catch (error) {
      return {
        ...this.view(job),
        state: 'needs_attention',
        remote_state: 'succeeded',
        error: errorResult(error),
        native_output_validation: { status: 'unverified', ...requirements },
        next_action:
          'Retry reading this original task to verify its native output; do not regenerate or recompress it.',
      };
    }
  }
  /** 异步验收结束后再读一次当前记录；旧证明不能作为并发新回执的成功结果返回。 */
  private checkedNativeJob(jobId: string, meshopt: boolean, unbaked: boolean): Job {
    const job = this.jobs.get(jobId);
    if (unbaked && !hasUnbakedProof(this.jobs, job))
      throw new TripoError(
        'UNBAKED_OUTPUT_IDENTITY_CHANGED',
        'The export changed before its verified result was returned.',
        'read',
      );
    if (meshopt && !hasNativeOutputProof(job))
      throw new TripoError(
        'NATIVE_OUTPUT_IDENTITY_CHANGED',
        'The native artifact changed before its verified result was returned.',
        'read',
      );
    return job;
  }
  private async imageOutputView(job: Job): Promise<Record<string, unknown>> {
    const format = readImageOutputFormat(this.jobs, job);
    const size = readImageSize(this.jobs, job);
    const background = readImageBackground(this.jobs, job);
    try {
      // 图像列表可能晚于成功回执可读；仅补查原任务，不创建新的收费生成。
      if (
        !job.artifacts.some((artifact) => artifact.kind === 'image') ||
        ((size || background) &&
          job.artifacts.filter((a) => a.kind === 'image').length !== (job.input.amount ?? 1))
      ) {
        const status = await this.gateway.status(job);
        if (status.state === 'succeeded')
          job = this.jobs.update(job.job_id, job.state, { artifacts: status.artifacts });
      }
      if (!format) job = await ensureImageSize(job, this.jobs, this.config.dataDir, this.gateway);
      if (!format) job = await ensureImageBackground(job, this.jobs, this.config.dataDir, this.gateway);
      job = await ensureImageOutput(job, this.jobs, this.config.dataDir, this.gateway);
      return {
        ...this.view(job),
        ...(this.deliverySummary(job) ?? {}),
      };
    } catch (error) {
      job = this.jobs.get(job.job_id);
      return {
        ...this.view(job),
        ...(this.deliverySummary(job) ?? {}),
        state: 'needs_attention',
        remote_state: 'succeeded',
        error: errorResult(error),
        ...(format
          ? {
              image_output_validation: {
                status: 'unverified',
                format,
                processing: 'local_delivery_encoding',
              },
            }
          : {}),
        next_action:
          'Retry reading the original image task to verify its requested dimensions, background or format; do not regenerate.',
      };
    }
  }
  private async exportJpegView(job: Job): Promise<Record<string, unknown>> {
    try {
      if (!job.artifacts.some((artifact) => artifact.kind === 'model')) {
        const status = await this.gateway.status(job);
        if (status.state === 'succeeded')
          job = this.jobs.update(job.job_id, job.state, { artifacts: status.artifacts });
      }
      job = await ensureExportJpeg(job, this.jobs, this.config.dataDir, this.gateway);
      return {
        ...this.view(job),
        jpeg_output_validation: {
          status: 'verified',
          texture_format: 'JPEG',
          processing: 'local_texture_encoding_model_structures_retained',
        },
      };
    } catch (error) {
      return {
        ...this.view(job),
        state: 'needs_attention',
        remote_state: 'succeeded',
        error: errorResult(error),
        jpeg_output_validation: { status: 'unverified', texture_format: 'JPEG' },
        next_action:
          'Retry reading the original export to verify its JPEG delivery; do not create another export.',
      };
    }
  }
  private async uvImportView(job: Job): Promise<Record<string, unknown>> {
    try {
      if (!job.artifacts.some((artifact) => artifact.kind === 'model')) {
        const status = await this.gateway.status(job);
        if (status.state === 'succeeded')
          job = this.jobs.update(job.job_id, job.state, { artifacts: status.artifacts });
      }
      job = await ensureUvImport(job, this.jobs, this.config.dataDir, this.gateway);
      return { ...this.view(job), ...uvImportSummary(this.jobs, job) };
    } catch (error) {
      return {
        ...this.view(job),
        ...uvImportSummary(this.jobs, job),
        state: 'needs_attention',
        remote_state: 'succeeded',
        error: errorResult(error),
        next_action: 'Retry verification of the original UV import; do not generate UVs or import again.',
      };
    }
  }
  /** 自动图片后缀仅供兼容CLI自行命名；外部工具的显式destination_path保持严格。 */
  async download(
    jobId: string,
    artifactId: string,
    relative: string,
    inferImageExtension = false,
  ): Promise<Record<string, unknown>> {
    let job = this.jobs.get(jobId);
    this.own(job);
    assertSegmentEntityJob(this.jobs, job);
    if (frontendOutputRequested(this.jobs, job))
      return await downloadFrontendOutput(
        this.jobs,
        this.config.dataDir,
        job,
        artifactId,
        await resolveDestination(this.config.outputDir, relative),
      );
    if (!['succeeded', 'failed'].includes(job.state))
      throw new TripoError(
        'JOB_NOT_COMPLETE',
        'Wait for a terminal task with completed artifacts before downloading.',
      );
    const lab = await ensureLabReferenceEditOutput(this.jobs, this.gateway, this.config.dataDir, job, () =>
      this.own(job),
    );
    if (lab) {
      if (lab.state !== 'succeeded')
        return labReferenceFailure(
          'The original reference-edit model has not passed its preservation checks.',
        );
      job = this.jobs.get(jobId);
    }
    const artifact = job.artifacts.find((a) => a.artifact_id === artifactId);
    if (!artifact) throw new TripoError('ARTIFACT_NOT_FOUND', 'No artifact has that artifact_id.');
    assertCanvasArtifact(job, artifact);
    await verifyTextureModel(job, this.jobs, this.gateway);
    await verifyUnbakedOutput(job, this.jobs, this.config.dataDir, this.gateway);
    await ensureSmartSegmentScaleOutput(this.jobs, job, this.config.dataDir, this.gateway, () =>
      this.own(job),
    );
    await ensureSmartSegmentAffineOutput(this.jobs, job, this.config.dataDir, this.gateway, () =>
      this.own(job),
    );
    await ensureSmartSegmentTransferOutput(this.jobs, job, this.config.dataDir, this.gateway, () =>
      this.own(job),
    );
    this.own(job);
    const destination = await resolveDestination(this.config.outputDir, relative);
    this.own(job);
    const guards = this.artifactGuards(job, artifact);
    let saved = await this.downloadDelivery(job, artifact, destination, inferImageExtension);
    guards.snapshot();
    if (!saved)
      try {
        const original = isMultiviewBundle(job)
          ? multiviewArtifactSource(this.jobs, job, artifact)
          : { job, artifact };
        const url = await this.gateway.artifactUrl(original.job, original.artifact);
        guards.snapshot();
        saved =
          job.operation === 'export' && needsExportTransform(job.input)
            ? await downloadTransformedExport(
                url,
                destination.root,
                destination.relative,
                job.input,
                (result) => {
                  guards.snapshot();
                  assertLocalExportProduced(this.jobs, job, artifact, result);
                },
              )
            : await download(
                url,
                destination.root,
                destination.relative,
                artifact.kind === 'animation' ? 'animation' : artifact.format,
                undefined,
                inferImageExtension && artifact.kind === 'image',
                {
                  ...(guards.required ? { validateBytes: guards.bytes } : {}),
                  beforePublish: guards.snapshot,
                },
              );
      } catch (error) {
        // 恢复文件也必须先满足冻结的原生约束，再发布到用户路径。
        guards.snapshot();
        rejectUnregisteredLocalExportRecovery(job, artifact, error);
        const recovery = await guards.recovery();
        if (guards.required) {
          const bytes = await verifiedArtifactBytes(recovery);
          if (bytes) await guards.bytes(bytes, artifact.format);
        }
        saved = await recoverDownload(
          job,
          recovery,
          destination,
          error,
          inferImageExtension && artifact.kind === 'image',
          guards.snapshot,
        );
      }
    guards.snapshot();
    const current = this.jobs.get(jobId).artifacts.find((item) => item.artifact_id === artifactId)!;
    this.jobs.saveArtifact(
      jobId,
      { ...current, ...saved },
      exportJpegRequested(this.jobs, job) || uvImportPolicy(this.jobs, job)
        ? {
            account_ref: job.account_ref,
            operation: job.operation,
            remote_ids: job.remote_ids,
            input: job.input,
            kind: artifact.kind,
            format: artifact.format,
            index: artifact.index,
          }
        : guards.expected,
    );
    return { job_id: jobId, artifact_id: artifactId, ...saved };
  }
  private async downloadDelivery(
    job: Job,
    artifact: Artifact,
    destination: { root: string; relative: string },
    inferImageExtension: boolean,
  ): Promise<Record<string, unknown> | undefined> {
    if (labReferenceEditPolicy(this.jobs, job))
      return await downloadLabReferenceEditArtifact(
        this.jobs,
        this.gateway,
        this.config.dataDir,
        job,
        artifact,
        destination,
        () => this.own(job),
      );
    if (transferFinalParent(job))
      return await downloadSmartSegmentTransferArtifact(this.jobs, job, artifact, destination, () =>
        this.own(job),
      );
    if (artifact.kind === 'model' && smartSegmentScaleRequested(this.jobs, job))
      return await reusedSmartSegmentScaleDelivery(this.jobs, job, artifact, destination, () =>
        this.own(job),
      );
    if (artifact.artifact_id === 'semantic-mask' && smartSegmentScaleRequested(this.jobs, job))
      return await downloadSmartSegmentScaleMask(
        this.jobs,
        job,
        artifact,
        destination,
        this.config.dataDir,
        this.gateway,
        () => this.own(job),
      );
    const unbaked = await reusedUnbakedDelivery(this.jobs, job, artifact, destination, () => this.own(job));
    if (unbaked) return unbaked;
    if (artifact.kind === 'model' && uvImportPolicy(this.jobs, job))
      return await downloadUvImport(job, artifact, destination, this.jobs, this.config.dataDir, this.gateway);
    if (artifact.kind === 'model' && exportJpegRequested(this.jobs, job))
      return await downloadExportJpeg(
        job,
        artifact,
        destination,
        this.jobs,
        this.config.dataDir,
        this.gateway,
      );
    if (artifact.kind === 'image' && readImageOutputFormat(this.jobs, job))
      return await downloadImageOutput(
        job,
        artifact,
        destination,
        inferImageExtension,
        this.jobs,
        this.config.dataDir,
        this.gateway,
      );
    if (artifact.kind === 'image' && readImageSize(this.jobs, job))
      return await downloadImageSize(
        job,
        artifact,
        destination,
        inferImageExtension,
        this.jobs,
        this.config.dataDir,
        this.gateway,
      );
    if (artifact.kind === 'image' && readImageBackground(this.jobs, job))
      return await downloadImageBackground(
        job,
        artifact,
        destination,
        inferImageExtension,
        this.jobs,
        this.config.dataDir,
        this.gateway,
      );
    return await reusedLocalExportDelivery(this.jobs, job, artifact, destination, () => this.own(job));
  }
  /** 同一组身份/字节约束覆盖在线下载和本地恢复，最终仍由 SQLite CAS 核验。 */
  private artifactGuards(
    job: Job,
    artifact: Artifact,
  ): {
    required: boolean;
    snapshot: () => void;
    bytes: (bytes: Buffer, format: string) => Promise<void>;
    recovery: () => Promise<Artifact>;
    expected: Parameters<JobStore['saveArtifact']>[2];
  } {
    const meshopt = artifact.kind === 'model' && nativeMeshoptRequested(this.jobs, job);
    const unbaked = artifact.kind === 'model' && unbakedRequested(job);
    const scale = artifact.kind === 'model' && smartSegmentScaleRequested(this.jobs, job);
    const scaleMask = artifact.artifact_id === 'semantic-mask' && smartSegmentScaleRequested(this.jobs, job);
    const affine = Boolean(affineFinalParent(job));
    const transfer = Boolean(transferFinalParent(job));
    const entity = Boolean(assertSegmentEntityJob(this.jobs, job));
    const lab = Boolean(labReferenceEditPolicy(this.jobs, job));
    const localExport = localExportTask(job, artifact) && !unbaked && !exportJpegRequested(this.jobs, job);
    const guardedSegment = [scale, scaleMask, affine, entity, transfer].some(Boolean);
    const scaleProof = scale ? scaleOutputProof(this.jobs, job, artifact) : undefined;
    const materialProof = unbaked ? assertUnbakedIdentity(this.jobs, job, artifact) : undefined;
    const normalizationProof = importNormalizationDeliveryProof(this.jobs, job, artifact);
    const labProof = lab ? labReferenceOutputProof(this.jobs, job, artifact) : undefined;
    if (meshopt) assertNativeOutputIdentity(job, artifact);
    return {
      required: [meshopt, unbaked, guardedSegment, lab, artifact.canvas_result, normalizationProof].some(
        Boolean,
      ),
      recovery: async () => {
        this.own(job);
        const proof =
          materialProof ??
          (labProof ? { sha256: text(labProof.sha256), bytes: Number(labProof.bytes) } : undefined) ??
          normalizationProof ??
          (scaleProof ? { sha256: text(scaleProof.sha256), bytes: Number(scaleProof.bytes) } : undefined) ??
          (meshopt ? artifact.native_validation : undefined);
        const recovered = proof
          ? ((await recoverVerifiedArtifact(job, artifact, proof, this.jobs, this.config.dataDir)) ??
            artifact)
          : artifact;
        this.own(job);
        return recovered;
      },
      snapshot: () => {
        this.own(job);
        if (localExport) assertLocalExportSnapshot(this.jobs, job, artifact);
        assertSegmentEntitySnapshot(this.jobs, job);
        if (lab) assertLabReferenceSnapshot(this.jobs, job, artifact);
        if (artifact.canvas_result) assertCanvasSnapshot(job, artifact, this.jobs.get(job.job_id));
        if (normalizationProof) assertImportNormalizationSnapshot(this.jobs, job, artifact);
        if (meshopt) assertNativeOutputSnapshot(job, artifact, this.jobs.get(job.job_id));
        if (unbaked) assertUnbakedSnapshot(this.jobs, job, artifact);
        if (scale) assertScaleOutputSnapshot(this.jobs, job, artifact);
        if (scaleMask) assertScaleMaskSnapshot(this.jobs, job, artifact);
        if (affine) assertAffineDelivery(this.jobs, job);
        if (transfer) {
          assertTransferSnapshot(this.jobs, job);
          assertTransferDelivery(this.jobs, job, artifact);
        }
      },
      bytes: async (bytes, format) => {
        this.own(job);
        const current = this.jobs.get(job.job_id);
        if (lab) assertLabReferenceBytes(this.jobs, job, artifact, bytes);
        if (normalizationProof) assertImportNormalizationBytes(this.jobs, job, artifact, bytes);
        if (artifact.canvas_result) {
          assertCanvasBytes(assertCanvasSnapshot(job, artifact, current), bytes);
          this.jobs.freezeCanvasArtifactBytes(job, artifact, bytes);
        }
        if (meshopt) {
          const latest = assertNativeOutputSnapshot(job, artifact, current);
          await verifyNativeArtifactBytes(current, latest, bytes, format);
        }
        if (unbaked) {
          const latest = assertUnbakedSnapshot(this.jobs, job, artifact);
          await verifyUnbakedBytes(current, latest, bytes, this.jobs);
        }
        if (scale) assertScaleOutputBytes(this.jobs, job, artifact, bytes);
        if (scaleMask) assertScaleMaskBytes(this.jobs, job, artifact, bytes);
        if (affine) assertAffineOutputBytes(this.jobs, job, artifact, bytes);
        if (transfer) assertTransferOutputBytes(this.jobs, job, artifact, bytes);
        this.own(job);
      },
      expected: [
        meshopt,
        materialProof,
        guardedSegment,
        lab,
        artifact.canvas_result,
        normalizationProof,
        localExport,
      ].some(Boolean)
        ? {
            account_ref: job.account_ref,
            operation: job.operation,
            remote_ids: job.remote_ids,
            kind: artifact.kind,
            format: artifact.format,
            index: artifact.index,
            ...([guardedSegment, lab, normalizationProof, localExport].some(Boolean)
              ? { input: job.input }
              : {}),
            ...(materialProof
              ? {
                  input: job.input,
                  materialProof: {
                    key: unbakedProofKey(job, artifact),
                    identity: materialProof.identity,
                    sha256: materialProof.sha256,
                    bytes: materialProof.bytes,
                  },
                }
              : {}),
          }
        : undefined,
    };
  }
  list(limit: number, offset: number): Record<string, unknown> {
    this.jobs.recoverExpired();
    const jobs = this.jobs.list(this.accountRef(), limit, offset);
    return {
      jobs: jobs.map((job) => this.summary(job)),
      next_offset: jobs.length === limit ? offset + limit : null,
    };
  }
  /** 历史与流水线展示也不能绕过产物约束；纯列表不为每条任务额外下载。 */
  summary(job: Job): Record<string, unknown> {
    const view = this.view(job);
    const routeFailure = segmentEntityFailureView(this.jobs, job);
    if (routeFailure) return { ...view, ...routeFailure };
    const lab = labReferenceEditSummary(this.jobs, this.config.dataDir, job);
    if (lab) return { ...view, ...lab };
    const frontend = frontendOutputSummary(this.jobs, this.config.dataDir, job);
    if (frontend) return { ...view, ...frontend };
    if (isMultiviewBundle(job)) return { ...view, ...multiviewSummary(this.jobs, job) };
    const delivery = this.deliverySummary(job);
    if (delivery) return { ...view, ...delivery };
    if (job.operation === 'import_model') return { ...view, ...importNormalizationSummary(this.jobs, job) };
    const meshopt = nativeMeshoptRequested(this.jobs, job),
      texture = readTextureModel(this.jobs, job),
      unbaked = unbakedRequested(job),
      hasRequirements = [meshopt, texture, unbaked].some(Boolean);
    if (job.state !== 'succeeded' || !hasRequirements) return view;
    const verified =
      (!meshopt || hasNativeOutputProof(job)) &&
      (!texture || hasTextureModelProof(this.jobs, job)) &&
      (!unbaked || hasUnbakedProof(this.jobs, job));
    return {
      ...view,
      state: verified ? 'succeeded' : 'needs_attention',
      remote_state: 'succeeded',
      native_output_validation: {
        status: verified ? 'verified' : 'unverified',
        ...(meshopt ? { geometry_compression: 'meshopt' } : {}),
        ...(texture ? { texture_model: texture } : {}),
        ...(unbaked ? { bake: false, materials_preserved: verified } : {}),
      },
    };
  }
  private deliverySummary(job: Job): Record<string, unknown> | undefined {
    const transfer = smartSegmentTransferSummary(this.jobs, job);
    if (transfer) return transfer;
    const scaled = smartSegmentScaleSummary(this.jobs, job, this.config.dataDir);
    const affine = smartSegmentAffineSummary(this.jobs, job);
    if (affine) return { ...scaled, ...affine };
    if (scaled) return scaled;
    const delivery = exportJpegSummary(this.jobs, job) ?? uvImportSummary(this.jobs, job);
    if (delivery) return delivery;
    if (job.state !== 'succeeded') return;
    const size = imageSizeSummary(this.jobs, job, this.config.dataDir);
    const background = imageBackgroundSummary(this.jobs, job, this.config.dataDir);
    const failed = size?.state === 'needs_attention' || background?.state === 'needs_attention';
    const image =
      size || background
        ? { ...size, ...background, ...(failed ? { state: 'needs_attention' } : {}) }
        : undefined;
    if (!readImageOutputFormat(this.jobs, job)) return image;
    const verified = hasImageOutputProof(job, this.jobs, this.config.dataDir);
    return {
      state: verified ? 'succeeded' : 'needs_attention',
      remote_state: 'succeeded',
      image_output_validation: {
        status: verified ? 'verified' : 'unverified',
        format: readImageOutputFormat(this.jobs, job),
        processing: 'local_delivery_encoding',
      },
      ...(image ?? {}),
      ...(!verified ? { state: 'needs_attention' } : {}),
    };
  }
  /** 明确指定远端 ID 恢复未知回执；先读验证，再关联，不进行任何生成 POST。 */
  async reconcile(jobId: string, ids: unknown): Promise<Record<string, unknown>> {
    const job = this.jobs.get(jobId);
    this.own(job);
    if (isMultiviewBundle(job))
      throw new TripoError(
        'RECONCILE_CHILD_REQUIRED',
        'Reconcile the specific multiview child task using its original Studio receipt; the local composition has no remote receipt.',
      );
    if (job.state !== 'outcome_unknown' && job.error?.code !== 'PARTIAL_RECEIPT_UNKNOWN')
      throw new TripoError('RECONCILE_NOT_NEEDED', 'Only an outcome_unknown job can be reconciled.');
    const remote = object(ids);
    if (job.operation === 'export_batch') {
      const remote_ids = reconcileExportBatch(job, remote.batch);
      const status = await this.gateway.status({ ...job, remote_ids });
      // 批量查询可返回成功兄弟产物，但未读成功的手动回执仍未验证，不能持久绑定。
      requireVerifiedReceipts(status);
      return await this.nativeOutputView(
        this.jobs.update(
          jobId,
          status.state,
          {
            remote_ids,
            progress: status.progress,
            artifacts: status.artifacts,
            error: status.error,
          },
          { reconcileFrom: job.remote_ids },
        ),
      );
    }
    if (hasModelResults(job)) {
      const remote_ids = reconcileModelResults(job, remote.models);
      const status = await this.gateway.status({ ...job, remote_ids });
      requireVerifiedReceipts(status);
      return await this.nativeOutputView(
        this.jobs.update(
          jobId,
          status.state,
          {
            remote_ids,
            progress: status.progress,
            artifacts: status.artifacts,
            error: status.error,
          },
          { reconcileFrom: job.remote_ids },
        ),
      );
    }
    const remote_ids = {
      task_id: text(remote.task_id) || undefined,
      asset_id: text(remote.asset_id) || undefined,
      project_id: text(remote.project_id) || undefined,
      operator_id: text(remote.operator_id) || undefined,
    };
    const valid = ['image', 'image_process'].includes(job.operation)
      ? Boolean(remote_ids.asset_id)
      : ['motion', 'canvas_run', ...variableCanvasOperations].includes(job.operation)
        ? Boolean(remote_ids.task_id)
        : job.operation === 'copy'
          ? Boolean(remote_ids.project_id)
          : Boolean(remote_ids.operator_id && remote_ids.project_id);
    if (!valid)
      throw new TripoError('REMOTE_ID_MISSING', 'Supply the exact original remote IDs from Studio.');
    const status = await this.gateway.status({ ...job, remote_ids });
    return await this.nativeOutputView(
      this.jobs.update(
        jobId,
        status.state,
        {
          remote_ids: status.remote_ids ?? remote_ids,
          progress: status.progress,
          artifacts: status.artifacts,
          error: status.error,
        },
        { reconcileFrom: job.remote_ids },
      ),
    );
  }
}
