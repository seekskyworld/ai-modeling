/** SQLite 短事务使去重、提交领取和审计事件一致；网络调用永远位于事务之外。 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type {
  Artifact,
  Job,
  JobState,
  Operation,
  Quote,
  RemoteIds,
  ObservedCost,
} from '../../studio/contracts/types.ts';
import { object, TripoError } from '../../studio/contracts/errors.ts';
import {
  assertCanvasArtifact,
  canvasCapNodes,
  validCanvasResult,
} from '../../studio/contracts/canvas-result.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { assertSegmentEntityJob } from '../core/segment-entity-policy.ts';
import { retainFrontendDeliveries } from '../core/frontend-delivery.ts';
import { retainUnbakedDeliveries } from '../artifacts/unbaked-delivery.ts';
import { retainExportJpegDeliveries } from '../artifacts/export-jpeg-output.ts';
import { retainLocalExportDeliveries } from '../artifacts/local-export-delivery.ts';
import { scaleOutputProof, smartSegmentScaleRequested } from '../core/smartsegment-scale-policy.ts';
import { scaleMaskProof } from '../core/smartsegment-scale-mask-policy.ts';
import { assertAffineDelivery } from '../core/smartsegment-affine-policy.ts';
import {
  assertTransferDelivery,
  transferFinalParent,
  transferOutputProof,
} from '../core/smartsegment-affine-transfer-policy.ts';
import {
  readImageBackground,
  imageBackgroundIdentity,
  imageBackgroundPolicyKey,
  imageBackgroundProofKey,
  imageBackgroundFrozenProof,
  validImageBackgroundProof,
  assertImageBackgroundDelivery,
  type ImageBackground,
} from '../core/image-background-policy.ts';
import {
  readImageSize,
  imageSizeIdentity,
  imageSizePolicyKey,
  imageSizeProofKey,
  imageSizeFrozenProof,
  assertImageSizeDelivery,
  type ImageSizeRequirement,
} from '../core/image-size-policy.ts';
import {
  unbakedSourceIdentity,
  unbakedIdentity,
  unbakedSourceKey,
  unbakedProofKey,
  readUnbakedSource,
} from '../core/unbaked-material-policy.ts';
import { exportJpegIdentity, exportJpegProofKey } from '../core/export-jpeg-policy.ts';
import { uvArtifactIdentity, uvImportProofKey } from '../core/uv-import-policy.ts';
import {
  frontendOutputKey,
  frontendOutputIdentity,
  frontendOutputRequested,
  assertFrontendOutput,
  assertFrontendMetadata,
} from '../core/frontend-output.ts';
import {
  artifactMatchesDeliveryProof,
  validDeliveryProof,
  type DeliverySourcePrefix,
} from '../core/delivery-proof.ts';
import {
  labReferenceEditPolicy,
  labReferenceOutputProof,
  assertLabReferenceSnapshot,
  labReferenceFailure,
} from '../compat/lab-reference-edit-policy.ts';

type ArtifactSaveGuard = Pick<Job, 'account_ref' | 'operation' | 'remote_ids'> &
  Pick<Artifact, 'kind' | 'format' | 'index'> & {
    input?: Record<string, unknown>;
    materialProof?: { key: string; identity: string; sha256: string; bytes: number };
  };

type Row = Record<string, unknown>;
const encode = (value: unknown): string => JSON.stringify(value);
function deliveryPolicies(job: Job, artifact: Artifact) {
  return [
    {
      key: exportJpegProofKey(job, artifact),
      identity: exportJpegIdentity(job, artifact),
      source: 'source_',
    },
    {
      key: uvImportProofKey(job, artifact),
      identity: uvArtifactIdentity(job, artifact),
      source: 'imported_',
    },
  ] satisfies Array<{ key: string; identity: string; source: DeliverySourcePrefix }>;
}
function validateDeliveryMetadata(
  artifact: Artifact,
  policy: Record<string, unknown>,
  source: DeliverySourcePrefix,
  requireDelivery = false,
): void {
  if (
    !validDeliveryProof(policy, source) ||
    !artifactMatchesDeliveryProof(artifact, policy, source, requireDelivery)
  )
    throw new TripoError(
      'ARTIFACT_POLICY_CONTENT_CHANGED',
      'The model metadata or downloaded bytes differ from the frozen delivery proof.',
      'read',
    );
}
/** 泛型远端图片占位不能擦掉下载器已验明的真实格式；合并须在更新事务内完成。 */
function mergeArtifact(previous: Artifact | undefined, incoming: Artifact): Artifact {
  if (previous?.canvas_result) {
    if (incoming.canvas_result && fingerprint(incoming.canvas_result) !== fingerprint(previous.canvas_result))
      throw new TripoError(
        'CANVAS_RESULT_IDENTITY_CHANGED',
        'The frozen Canvas final result cannot be replaced.',
        'read',
      );
    // 迟到轮询不覆盖另一进程刚登记的下载位置/摘要；下载写入使用 saveArtifact。
    return { ...incoming, ...previous };
  }
  const merged = { ...previous, ...incoming };
  if (
    incoming.kind === 'image' &&
    incoming.format === 'image' &&
    previous?.kind === 'image' &&
    previous.local_path &&
    previous.sha256 &&
    previous.bytes &&
    ['png', 'jpeg', 'webp'].includes(previous.format)
  )
    merged.format = previous.format;
  return merged;
}
function validateCanvasSave(job: Job, current: Artifact | undefined, artifact: Artifact): void {
  assertCanvasArtifact(job, artifact);
  if (current?.canvas_result && !current.sha256)
    throw new TripoError(
      'CANVAS_RESULT_CONTENT_UNVERIFIED',
      'Freeze the original capped model bytes before publishing a download.',
      'read',
    );
  if (
    current?.canvas_result &&
    (fingerprint(current.canvas_result) !== fingerprint(artifact.canvas_result) ||
      (current.sha256 && (current.sha256 !== artifact.sha256 || current.bytes !== artifact.bytes)))
  )
    throw new TripoError(
      'CANVAS_RESULT_IDENTITY_CHANGED',
      'The final Canvas result identity or original bytes changed.',
      'read',
    );
}
/** 尺寸/alpha/编码共享同一原图事实，后绑定的证明不得换图或跨另一组像素。 */
function assertOriginalImageFacts(
  current: Artifact,
  metadata: Pick<
    NonNullable<Artifact['image_size']>,
    'source_sha256' | 'source_bytes' | 'source_format' | 'width' | 'height'
  >,
  code: string,
): void {
  const original = current.image_output
    ? { sha256: current.image_output.source_sha256, bytes: current.image_output.source_bytes }
    : !current.processing
      ? current
      : undefined;
  if (
    original?.sha256 &&
    (original.sha256 !== metadata.source_sha256 || original.bytes !== metadata.source_bytes)
  )
    throw new TripoError(
      code,
      'The image proof differs from the original bytes already stored for this task.',
      'read',
    );
  for (const proof of [current.image_size, current.image_background, current.image_output])
    if (
      proof &&
      (proof.source_sha256 !== metadata.source_sha256 ||
        proof.source_bytes !== metadata.source_bytes ||
        proof.source_format !== metadata.source_format ||
        proof.width !== metadata.width ||
        proof.height !== metadata.height)
    )
      throw new TripoError(code, 'The image proof differs from a frozen original pixel source.', 'read');
}
function decode(row: Row): Job {
  return {
    ...row,
    input: JSON.parse(String(row.input)),
    remote_ids: JSON.parse(String(row.remote_ids)),
    quote: JSON.parse(String(row.quote)),
    artifacts: JSON.parse(String(row.artifacts)),
    error: row.error ? JSON.parse(String(row.error)) : undefined,
    observed_cost: row.observed_cost ? JSON.parse(String(row.observed_cost)) : undefined,
  } as unknown as Job;
}

export class JobStore {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON;');
      this.enableWal();
      this.db.exec('PRAGMA busy_timeout=10000;');
      // Read the version after acquiring the writer lock. Other processes must see
      // either the complete previous schema or the complete migrated schema.
      this.transaction(() => this.initializeSchema());
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the original initialization failure.
      }
      throw error;
    }
  }
  private enableWal(): void {
    // Concurrent empty-database WAL upgrades can return SQLITE_BUSY immediately,
    // without invoking SQLite's busy handler. Retry only this idempotent setup.
    const deadline = performance.now() + 10000,
      pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        this.db.exec('PRAGMA journal_mode=WAL;');
        return;
      } catch (error) {
        const code = object(error).errcode,
          remaining = deadline - performance.now();
        if (typeof code !== 'number' || (code & 255) !== 5 || remaining <= 0) throw error;
        Atomics.wait(pause, 0, 0, Math.min(20, remaining));
      }
    }
  }
  private initializeSchema(): void {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > 18) throw new TripoError('DATABASE_VERSION', 'This database needs a newer ai-modeling.');
    if (!version)
      this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY, account_ref TEXT NOT NULL, request_id TEXT NOT NULL,
        input_hash TEXT NOT NULL, operation TEXT NOT NULL, input TEXT NOT NULL,
        contract_version TEXT NOT NULL, state TEXT NOT NULL, remote_ids TEXT NOT NULL DEFAULT '{}',
        quote TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, error TEXT,
        artifacts TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        lease_until INTEGER NOT NULL DEFAULT 0, UNIQUE(account_ref, request_id));
        CREATE INDEX IF NOT EXISTS jobs_account_state ON jobs(account_ref,state,created_at);
        CREATE TABLE IF NOT EXISTS job_events (event_id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id), state TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS account_leases (account_ref TEXT PRIMARY KEY, job_id TEXT NOT NULL, until_ms INTEGER NOT NULL);
        PRAGMA user_version=1;`);
    if (version < 2) {
      const columns = this.db.prepare('PRAGMA table_info(jobs)').all();
      if (!columns.some((column) => column.name === 'observed_cost'))
        this.db.exec('ALTER TABLE jobs ADD COLUMN observed_cost TEXT');
      this.db.exec('PRAGMA user_version=2');
    }
    if (version < 3)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS job_aliases (account_ref TEXT NOT NULL, name TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(job_id), PRIMARY KEY(account_ref,name)); PRAGMA user_version=3;`,
      );
    if (version < 4)
      this.db.exec(`CREATE TABLE IF NOT EXISTS pipeline_steps (
      account_ref TEXT NOT NULL, run_id TEXT NOT NULL, position INTEGER NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(job_id), PRIMARY KEY(account_ref,run_id,position));
      CREATE INDEX IF NOT EXISTS pipeline_job ON pipeline_steps(job_id); PRAGMA user_version=4;`);
    if (version < 5)
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_names (account_ref TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(job_id), name TEXT NOT NULL, PRIMARY KEY(account_ref,job_id));
      INSERT OR IGNORE INTO job_names SELECT account_ref,job_id,name FROM job_aliases;
      CREATE INDEX IF NOT EXISTS job_names_lookup ON job_names(account_ref,name);
      PRAGMA user_version=5;`);
    if (version < 6)
      this.db.exec(`CREATE TABLE IF NOT EXISTS request_policies (
        account_ref TEXT NOT NULL, request_id TEXT NOT NULL, policy TEXT NOT NULL,
        legacy INTEGER NOT NULL, PRIMARY KEY(account_ref,request_id)); PRAGMA user_version=6;`);
    this.migrateCompatibilityVersions(version);
  }
  private migrateCompatibilityVersions(version: number): void {
    // v7 的自动骨架策略可以改变后续步骤数；旧版不能忽略该策略后按旧索引继续付费。
    if (version < 7) this.db.exec('PRAGMA user_version=7');
    // v8 增加原生产物约束与本地四视图组合；旧版本会忽略约束或把组合错误当成远端任务。
    if (version < 8) this.db.exec('PRAGMA user_version=8');
    // v9 的不烘焙导出必须保留源材料快照和效果证明；旧客户端不能绕过这些约束报告成功。
    if (version < 9) this.db.exec('PRAGMA user_version=9');
    // v10 的缺省 JPEG 使用保结构交付及内容证明，旧客户端不得改走会重建骨架的转换路径。
    if (version < 10) this.db.exec('PRAGMA user_version=10');
    // v11 的export-lite模型只能来自已验前端缓存；旧客户端会错误下载project.model_url原件。
    if (version < 11) this.db.exec('PRAGMA user_version=11');
    // v12 的明确WxH是持久交付义务；旧客户端会忽略原图尺寸证明并把错像素报告成功。
    if (version < 12) this.db.exec('PRAGMA user_version=12');
    // v13 的opaque必须验证原始alpha；旧客户端不能忽略背景义务或用不透明编码掩盖透明原图。
    if (version < 13) this.db.exec('PRAGMA user_version=13');
    // v14 保护 Canvas 最终封口及兼容分割变换的产物义务；旧版不能忽略证明而交付原始结果。
    if (version < 14) this.db.exec('PRAGMA user_version=14');
    // v15 的七步剪切还必须证明原始 A(P)；旧版只验末段 M2 会绕过整链交付义务。
    if (version < 15) this.db.exec('PRAGMA user_version=15');
    // v16 的纯旋转导入组合须验证源 B1 与最终原 A(P)，旧版不能忽略新链义务直接交付。
    if (version < 16) this.db.exec('PRAGMA user_version=16');
    // v17 的参考图Lab必须验证原模型保护面；旧版会把裸Lab成功误当兼容编辑已通过。
    if (version < 17) this.db.exec('PRAGMA user_version=17');
    // 显式投影分区和新版兼容朝向映射不能由旧读者当作普通Lab编辑/旧轴向交付。
    if (version < 18) this.db.exec('PRAGMA user_version=18');
  }
  close(): void {
    this.db.close();
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private event(id: string, state: JobState, detail: unknown = {}): void {
    this.db
      .prepare('INSERT INTO job_events(job_id,state,at,detail) VALUES(?,?,?,?)')
      .run(id, state, new Date().toISOString(), encode(detail));
  }
  get(id: string): Job {
    const row = this.db.prepare('SELECT * FROM jobs WHERE job_id=?').get(id);
    if (!row) throw new TripoError('JOB_NOT_FOUND', 'No local job has that job_id.');
    return decode(row);
  }
  /** UV 应用后服务器删除候选上下文；用完整来源身份定位已保存产物，不能按最新任务猜测。 */
  uvCandidate(account: string, project: string, base: string, candidate: string): Job | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE account_ref=? AND operation='uv_generate'
      AND json_extract(input,'$.project_id')=? AND json_extract(input,'$.current_operator_id')=?
      AND json_extract(remote_ids,'$.operator_id')=? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(account, project, base, candidate);
    return row ? decode(row) : undefined;
  }
  find(account: string, request: string): Job | undefined {
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE account_ref=? AND request_id=?')
      .get(account, request);
    return row ? decode(row) : undefined;
  }
  /** 跨任务缓存只按同账号的原字节证明查找；调用者还必须重新读取文件验 SHA。 */
  cachedArtifacts(account: string, sha256: string, bytes: number): Artifact[] {
    return this.db
      .prepare(
        `SELECT a.value AS artifact FROM jobs j, json_each(j.artifacts) a
      WHERE j.account_ref=? AND json_extract(a.value,'$.sha256')=?
      AND json_extract(a.value,'$.bytes')=? AND json_extract(a.value,'$.kind')='model'
      AND json_extract(a.value,'$.format')='glb' AND json_extract(a.value,'$.local_path') IS NOT NULL
      ORDER BY j.created_at DESC LIMIT 100`,
      )
      .all(account, sha256, bytes)
      .map((row) => JSON.parse(String(row.artifact)) as Artifact);
  }
  /** CLI 的保贴图要求不是网页字段，单独持久化避免更改远端请求指纹；并发首次绑定也须原子。 */
  requestPolicy(account: string, request: string): Record<string, unknown> | undefined {
    const row = this.db
      .prepare('SELECT policy FROM request_policies WHERE account_ref=? AND request_id=?')
      .get(account, request);
    return row ? JSON.parse(String(row.policy)) : undefined;
  }
  /** 自动决策必须读取原策略，不能用变化后的预检建议重排已付费步骤。 */
  bindRequestPolicy(account: string, request: string, policy: Record<string, unknown>): boolean {
    return this.transaction(() => {
      const saved = this.db
        .prepare('SELECT policy,legacy FROM request_policies WHERE account_ref=? AND request_id=?')
        .get(account, request);
      if (saved) {
        if (fingerprint(JSON.parse(String(saved.policy))) !== fingerprint(policy))
          throw new TripoError(
            'IDEMPOTENCY_CONFLICT',
            'The existing request has a different execution policy.',
          );
        return Boolean(saved.legacy);
      }
      // 旧记录未保存 CLI 层策略，不能反推原意图或改写原任务；允许恢复但明确保留兼容性警告。
      const legacy = Boolean(this.find(account, request));
      this.db
        .prepare('INSERT INTO request_policies(account_ref,request_id,policy,legacy) VALUES(?,?,?,?)')
        .run(account, request, encode(policy), Number(legacy));
      return legacy;
    });
  }
  /** 原始回执、输入与产物身份在同一事务确认；并发读者只能复用第一次相同的字节证明。 */
  bindImageSizeIntent(account: string, request: string, size: ImageSizeRequirement | undefined): void {
    this.transaction(() => {
      const key = imageSizePolicyKey(request),
        policy = { version: 1, size: size ?? null };
      const saved = this.requestPolicy(account, key);
      if (saved) {
        if (fingerprint(saved) !== fingerprint(policy))
          throw new TripoError(
            'IDEMPOTENCY_CONFLICT',
            'The existing request has a different exact image size intent.',
            'not_submitted',
          );
        return;
      }
      // 旧任务检测和首次绑定在同一事务；另一进程刚创建任务也不能被后补WxH义务。
      if (this.find(account, request)) {
        if (!size) return;
        throw new TripoError(
          'IDEMPOTENCY_CONFLICT',
          'This legacy task did not save its explicit pixel-size intent. Native resolution/ratio cannot prove the original WxH; recover the original task without adding a size requirement.',
          'not_submitted',
        );
      }
      this.db
        .prepare('INSERT INTO request_policies(account_ref,request_id,policy,legacy) VALUES(?,?,?,0)')
        .run(account, key, encode(policy));
    });
  }
  /** 背景意图首次绑定与旧任务检查同事务；省略、opaque和未记载的历史请求不能混同。 */
  bindImageBackgroundIntent(account: string, request: string, background: ImageBackground | undefined): void {
    this.transaction(() => {
      const key = imageBackgroundPolicyKey(request),
        policy = { version: 1, background: background ?? null };
      const saved = this.requestPolicy(account, key);
      if (saved) {
        if (fingerprint(saved) !== fingerprint(policy))
          throw new TripoError(
            'IDEMPOTENCY_CONFLICT',
            'The existing request has a different image background intent.',
            'not_submitted',
          );
        return;
      }
      if (this.find(account, request)) {
        if (!background) return;
        throw new TripoError(
          'IDEMPOTENCY_CONFLICT',
          'This legacy task did not freeze a background intent. Recover its original task without adding an opaque requirement.',
          'not_submitted',
        );
      }
      this.db
        .prepare('INSERT INTO request_policies(account_ref,request_id,policy,legacy) VALUES(?,?,?,0)')
        .run(account, key, encode(policy));
    });
  }
  /** 原始回执、输入与产物身份在同一事务确认；并发读者只能复用第一次相同的字节证明。 */
  bindArtifactPolicy(expected: Job, artifact: Artifact, key: string, policy: Record<string, unknown>): void {
    this.transaction(() => {
      const job = this.get(expected.job_id),
        current = job.artifacts.find((item) => item.artifact_id === artifact.artifact_id);
      if (
        job.state !== 'succeeded' ||
        job.account_ref !== expected.account_ref ||
        job.operation !== expected.operation ||
        fingerprint(job.input) !== fingerprint(expected.input) ||
        fingerprint(job.remote_ids) !== fingerprint(expected.remote_ids) ||
        !current ||
        current.kind !== artifact.kind ||
        current.format !== artifact.format ||
        current.index !== artifact.index
      )
        throw new TripoError(
          'ARTIFACT_POLICY_IDENTITY_CHANGED',
          'The original export changed before its byte proof could be bound.',
          'read',
        );
      const delivery = deliveryPolicies(job, current).find((entry) => entry.key === key);
      if (delivery) {
        if (policy.identity !== delivery.identity)
          throw new TripoError(
            'ARTIFACT_POLICY_IDENTITY_CHANGED',
            'The delivery proof belongs to another artifact.',
            'read',
          );
        validateDeliveryMetadata(current, policy, delivery.source);
      }
      const saved = this.requestPolicy(job.account_ref, key);
      if (saved) {
        if (fingerprint(saved) !== fingerprint(policy))
          throw new TripoError(
            'ARTIFACT_POLICY_CONTENT_CHANGED',
            'Another reader froze different bytes; the original proof was retained.',
            'read',
          );
        return;
      }
      this.db
        .prepare('INSERT INTO request_policies(account_ref,request_id,policy,legacy) VALUES(?,?,?,0)')
        .run(job.account_ref, key, encode(policy));
      this.event(job.job_id, job.state, { artifact_policy: artifact.artifact_id, sha256: policy.sha256 });
    });
  }
  /** 前端产物与原授权、原转换证明同时绑定；崩溃重入只复用同一原件，不覆盖并发下载位置。 */
  bindFrontendArtifact(
    expected: Job,
    artifact: Artifact,
    sourceKey: string,
    sourceProof: Record<string, unknown>,
    policy: Record<string, unknown>,
  ): Job {
    return this.transaction(() => {
      const job = this.get(expected.job_id),
        key = frontendOutputKey(job);
      if (
        job.state !== 'succeeded' ||
        job.operation !== 'export_lite' ||
        frontendOutputIdentity(job) !== frontendOutputIdentity(expected) ||
        policy.identity !== frontendOutputIdentity(job) ||
        policy.source_key !== sourceKey ||
        policy.source_fingerprint !== fingerprint(sourceProof) ||
        fingerprint(this.requestPolicy(job.account_ref, sourceKey) ?? null) !== fingerprint(sourceProof)
      )
        throw new TripoError(
          'FRONTEND_OUTPUT_IDENTITY_CHANGED',
          'The original frontend authorization changed before its artifact could be bound.',
          'read',
        );
      const saved = this.requestPolicy(job.account_ref, key);
      if (saved && fingerprint(saved) !== fingerprint(policy))
        throw new TripoError(
          'FRONTEND_OUTPUT_IDENTITY_CHANGED',
          'The original frontend output proof cannot be replaced.',
          'read',
        );
      if (job.artifacts.length > 1)
        throw new TripoError(
          'FRONTEND_OUTPUT_CONTENT_CHANGED',
          'The frontend task must have exactly one model artifact.',
          'read',
        );
      const current = job.artifacts[0];
      if (current) assertFrontendMetadata(current, policy);
      assertFrontendMetadata(artifact, policy);
      if (!saved)
        this.db
          .prepare('INSERT INTO request_policies(account_ref,request_id,policy,legacy) VALUES(?,?,?,0)')
          .run(job.account_ref, key, encode(policy));
      assertFrontendOutput(this, job, artifact);
      if (saved && current) return job;
      this.db.prepare('UPDATE jobs SET artifacts=?,updated_at=? WHERE job_id=?').run(
        encode([
          {
            ...retainFrontendDeliveries(current, artifact, frontendOutputIdentity(job)),
            ...(current?.local_path ? { local_path: current.local_path } : {}),
          },
        ]),
        new Date().toISOString(),
        job.job_id,
      );
      this.event(job.job_id, job.state, { frontend_artifact: artifact.artifact_id, sha256: artifact.sha256 });
      return this.get(job.job_id);
    });
  }
  /** 来源只能在提交前冻结，结果只能绑定原回执；同事务确认身份并保留第一次证明。 */
  bindUnbakedPolicy(
    expected: Job,
    request: string,
    policy: Record<string, unknown>,
    artifact?: Artifact,
  ): void {
    this.transaction(() => {
      const job = this.get(expected.job_id);
      const current = artifact && job.artifacts.find((item) => item.artifact_id === artifact.artifact_id);
      if (
        unbakedSourceIdentity(job) !== unbakedSourceIdentity(expected) ||
        (artifact && (!current || unbakedIdentity(job, current) !== unbakedIdentity(expected, artifact)))
      )
        throw new TripoError(
          'UNBAKED_OUTPUT_IDENTITY_CHANGED',
          'The source or export identity changed while verifying materials.',
          'read',
        );
      if (
        !artifact &&
        (!['prepared', 'submitting'].includes(job.state) ||
          Object.keys(job.remote_ids).length ||
          request !== unbakedSourceKey(job) ||
          policy.identity !== unbakedSourceIdentity(job))
      )
        throw new TripoError(
          'UNBAKED_SOURCE_UNVERIFIED',
          'Material source proof must be frozen before the first submission.',
          'read',
        );
      this.validateUnbakedOutputPolicy(job, current, request, policy);
      const saved = this.requestPolicy(job.account_ref, request);
      if (saved) {
        if (fingerprint(saved) !== fingerprint(policy))
          throw new TripoError(
            'UNBAKED_OUTPUT_CONTENT_CHANGED',
            'Another reader froze different material bytes; the first proof was preserved.',
            'read',
          );
        return;
      }
      this.db
        .prepare('INSERT INTO request_policies(account_ref,request_id,policy,legacy) VALUES(?,?,?,0)')
        .run(job.account_ref, request, encode(policy));
      this.event(job.job_id, job.state, {
        material_validation: artifact?.artifact_id ?? 'source',
        sha256: policy.sha256,
      });
    });
  }
  private validateUnbakedOutputPolicy(
    job: Job,
    current: Artifact | undefined,
    request: string,
    policy: Record<string, unknown>,
  ): void {
    if (current) {
      const source = readUnbakedSource(this, job);
      if (
        request !== unbakedProofKey(job, current) ||
        policy.source_identity !== source.identity ||
        policy.source_sha256 !== source.sha256 ||
        policy.identity !== unbakedIdentity(job, current)
      )
        throw new TripoError(
          'UNBAKED_OUTPUT_IDENTITY_CHANGED',
          'Material output proof does not belong to the frozen source.',
          'read',
        );
      if (
        (current.sha256 && current.sha256 !== policy.sha256) ||
        (current.bytes && current.bytes !== policy.bytes)
      )
        throw new TripoError(
          'UNBAKED_OUTPUT_CONTENT_CHANGED',
          'The cached artifact changed during material verification.',
          'read',
        );
    }
  }
  /** 步骤成员关系显式持久化，不能根据请求 ID 的相似前缀猜测流水线。 */
  linkStep(account: string, run: string, position: number, jobId: string): void {
    if (this.get(jobId).account_ref !== account)
      throw new TripoError('ACCOUNT_MISMATCH', 'Pipeline account mismatch.');
    this.db
      .prepare(
        'INSERT INTO pipeline_steps(account_ref,run_id,position,job_id) VALUES(?,?,?,?) ON CONFLICT(account_ref,run_id,position) DO NOTHING',
      )
      .run(account, run, position, jobId);
    const existing = this.db
      .prepare('SELECT job_id FROM pipeline_steps WHERE account_ref=? AND run_id=? AND position=?')
      .get(account, run, position);
    if (existing?.job_id !== jobId)
      throw new TripoError('IDEMPOTENCY_CONFLICT', 'Pipeline step already has another task.');
  }
  pipeline(account: string, jobId: string): Job[] {
    return this.db
      .prepare(
        `SELECT jobs.* FROM pipeline_steps AS p JOIN jobs ON jobs.job_id=p.job_id
      WHERE p.account_ref=? AND p.run_id IN (SELECT run_id FROM pipeline_steps WHERE account_ref=? AND job_id=?) ORDER BY p.position`,
      )
      .all(account, account, jobId)
      .map(decode);
  }
  list(account: string, limit = 20, offset = 0, state?: JobState): Job[] {
    // 同毫秒任务按 SQLite 插入顺序决定先后；随机 UUID 不能代表创建顺序。
    const query = state
      ? this.db
          .prepare(
            'SELECT * FROM jobs WHERE account_ref=? AND state=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?',
          )
          .all(account, state, limit, offset)
      : this.db
          .prepare(
            'SELECT * FROM jobs WHERE account_ref=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?',
          )
          .all(account, limit, offset);
    return query.map(decode);
  }
  /** 官方 @last/@n 以完整组合为一项，避免最后一个被编辑视图冒充整套四视图结果。 */
  listOutputs(account: string, limit = 20, offset = 0, state?: JobState): Job[] {
    const query = `SELECT j.* FROM jobs j WHERE j.account_ref=? ${state ? 'AND j.state=?' : ''}
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_steps child JOIN pipeline_steps parent
          ON parent.account_ref=child.account_ref AND parent.run_id=child.run_id AND parent.position=0
        JOIN jobs root ON root.job_id=parent.job_id
        WHERE child.job_id=j.job_id AND child.account_ref=j.account_ref AND child.position>0
          AND json_extract(root.input,'$._multiview_edit.version')=1
      ) ORDER BY j.created_at DESC,j.rowid DESC LIMIT ? OFFSET ?`;
    return this.db
      .prepare(query)
      .all(...(state ? [account, state, limit, offset] : [account, limit, offset]))
      .map(decode);
  }
  /** 官方名称可以重复；保留每个任务的名称，解析时报告歧义而不静默选最新任务。 */
  setAlias(account: string, name: string, jobId: string): void {
    const job = this.get(jobId);
    if (job.account_ref !== account)
      throw new TripoError('ACCOUNT_MISMATCH', 'Cannot name another account’s task.');
    this.db
      .prepare(
        'INSERT INTO job_names(account_ref,name,job_id) VALUES(?,?,?) ON CONFLICT(account_ref,job_id) DO UPDATE SET name=excluded.name',
      )
      .run(account, name, jobId);
  }
  alias(account: string, name: string): string | undefined {
    const exact = this.db
      .prepare('SELECT job_id,name FROM job_names WHERE account_ref=? AND name=?')
      .all(account, name);
    // instr 使用字面子串，避免 SQL LIKE 把调用方的百分号和下划线当通配符。
    const matches = exact.length
      ? exact
      : this.db
          .prepare('SELECT job_id,name FROM job_names WHERE account_ref=? AND instr(name,?)>0')
          .all(account, name);
    if (matches.length > 1)
      throw new TripoError(
        'AMBIGUOUS_REFERENCE',
        'Task name matches multiple tasks; use an explicit task ID.',
        'read',
        { matches },
      );
    return matches[0] ? String(matches[0].job_id) : undefined;
  }
  name(account: string, jobId: string): string | undefined {
    const row = this.db
      .prepare('SELECT name FROM job_names WHERE account_ref=? AND job_id=?')
      .get(account, jobId);
    return row ? String(row.name) : undefined;
  }
  /** 与官方 slug 和数字后缀一致；锁内命名保证多个 CLI 不抢占同名，重试保留原名称。 */
  assignName(account: string, value: string, jobId: string): string {
    return this.transaction(() => {
      const existing = this.name(account, jobId);
      if (existing) return existing;
      const base =
        value
          .toLowerCase()
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 32)
          .replace(/-+$/, '') || 'task';
      const names = new Set(
        this.db
          .prepare('SELECT name FROM job_names WHERE account_ref=?')
          .all(account)
          .map((row) => row.name),
      );
      let name = base;
      for (let suffix = 2; names.has(name); suffix++) name = `${base}-${suffix}`;
      this.setAlias(account, name, jobId);
      return name;
    });
  }
  /** 重复 request_id 只能读取原意图；失败也不会悄悄变成第二次付费操作。 */
  prepare(
    account: string,
    request: string,
    operation: Operation,
    input: Record<string, unknown>,
    quote: Quote,
  ): Job {
    return this.transaction(() => {
      const hash = fingerprint({ operation, input });
      const existing = this.find(account, request);
      if (existing) {
        if (existing.input_hash !== hash)
          throw new TripoError('IDEMPOTENCY_CONFLICT', 'request_id already belongs to different inputs.');
        if (existing.state === 'prepared')
          this.db.prepare('UPDATE jobs SET quote=? WHERE job_id=?').run(encode(quote), existing.job_id);
        return this.get(existing.job_id);
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          'INSERT INTO jobs(job_id,account_ref,request_id,input_hash,operation,input,contract_version,state,quote,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          account,
          request,
          hash,
          operation,
          encode(input),
          'studio-2026-11-12',
          'prepared',
          encode(quote),
          now,
          now,
        );
      this.event(id, 'prepared');
      return this.get(id);
    });
  }
  /** 租约只是本机并发控制；过期意味着结果未知，绝不重新领取一次已开始的提交。 */
  claim(id: string, leaseMs = 180000): boolean {
    return this.transaction(() => {
      const job = this.get(id);
      const now = Date.now();
      this.recoverExpiredInside(now);
      if (job.state !== 'prepared') return false;
      const lease = this.db.prepare('SELECT * FROM account_leases WHERE account_ref=?').get(job.account_ref);
      if (lease && Number(lease.until_ms) > now) return false;
      this.db
        .prepare(
          'INSERT INTO account_leases(account_ref,job_id,until_ms) VALUES(?,?,?) ON CONFLICT(account_ref) DO UPDATE SET job_id=excluded.job_id,until_ms=excluded.until_ms',
        )
        .run(job.account_ref, id, now + leaseMs);
      this.db
        .prepare('UPDATE jobs SET state=?,lease_until=?,updated_at=? WHERE job_id=? AND state=?')
        .run('submitting', now + leaseMs, new Date().toISOString(), id, 'prepared');
      this.event(id, 'submitting');
      return true;
    });
  }
  private recoverExpiredInside(now: number): void {
    const rows = this.db
      .prepare("SELECT job_id FROM jobs WHERE state='submitting' AND lease_until<=?")
      .all(now);
    for (const row of rows) {
      const id = String(row.job_id);
      this.db.prepare("UPDATE jobs SET state='outcome_unknown',error=?,updated_at=? WHERE job_id=?").run(
        encode({
          code: 'INTERRUPTED_SUBMISSION',
          message: 'The submitting process did not persist a receipt. Do not resubmit.',
        }),
        new Date().toISOString(),
        id,
      );
      this.event(id, 'outcome_unknown', { reason: 'submission_lease_expired' });
    }
    this.db.prepare('DELETE FROM account_leases WHERE until_ms<=?').run(now);
  }
  recoverExpired(): void {
    this.transaction(() => this.recoverExpiredInside(Date.now()));
  }
  /** 终态不可被较慢的轮询覆盖；回执即使晚于租约仍可消除结果未知。 */
  update(
    id: string,
    state: JobState,
    patch: {
      remote_ids?: RemoteIds;
      progress?: number;
      error?: Record<string, unknown>;
      artifacts?: Artifact[];
      observed_cost?: ObservedCost;
    } = {},
    options: { reconcileFrom?: RemoteIds } = {},
  ): Job {
    return this.transaction(() => {
      const job = this.get(id);
      if (!this.canUpdate(job, state, options.reconcileFrom)) return job;
      let artifacts =
        patch.artifacts?.map((a) =>
          mergeArtifact(
            job.artifacts.find((previous) => previous.artifact_id === a.artifact_id),
            a,
          ),
        ) ?? job.artifacts;
      if (canvasCapNodes(job).length) {
        // 原中间产物与首次 final 绑定都保留；不同读者不能给同一节点绑定另一版本。
        artifacts = [
          ...job.artifacts.filter((a) => !artifacts.some((next) => next.artifact_id === a.artifact_id)),
          ...artifacts,
        ];
        const finalNodes = new Set<string>();
        const snapshot = { ...job, remote_ids: patch.remote_ids ?? job.remote_ids };
        for (const artifact of artifacts) {
          if (!artifact.canvas_result) continue;
          if (!validCanvasResult(snapshot, artifact) || finalNodes.has(artifact.canvas_result.node_id))
            throw new TripoError(
              'CANVAS_RESULT_IDENTITY_CHANGED',
              'The Canvas result conflicts with a frozen original node result.',
              'read',
            );
          finalNodes.add(artifact.canvas_result.node_id);
        }
      }
      this.db
        .prepare(
          'UPDATE jobs SET state=?,remote_ids=?,progress=?,error=?,artifacts=?,updated_at=? WHERE job_id=?',
        )
        .run(
          state,
          encode(patch.remote_ids ?? job.remote_ids),
          patch.progress ?? job.progress,
          patch.error ? encode(patch.error) : null,
          encode(artifacts),
          new Date().toISOString(),
          id,
        );
      if (patch.observed_cost)
        this.db
          .prepare('UPDATE jobs SET observed_cost=? WHERE job_id=?')
          .run(encode(patch.observed_cost), id);
      if (state !== 'submitting') this.db.prepare('DELETE FROM account_leases WHERE job_id=?').run(id);
      if (job.state !== state || patch.error || patch.remote_ids)
        this.event(id, state, patch.error ?? patch.remote_ids ?? {});
      return this.get(id);
    });
  }
  private canUpdate(job: Job, state: JobState, original?: RemoteIds): boolean {
    if (original && fingerprint(original) !== fingerprint(job.remote_ids))
      throw new TripoError(
        'RECONCILE_CONFLICT',
        'Another process changed the receipts; reload before reconciling.',
      );
    if (original && job.state === 'failed' && job.error?.code === 'PARTIAL_RECEIPT_UNKNOWN') return true;
    return !['succeeded', 'failed'].includes(job.state) || state === job.state;
  }
  /** 首次字节证明在文件发布前原子冻结；并发读者拿到不同内容不能先发布再依靠保存失败兜底。 */
  freezeCanvasArtifactBytes(expected: Job, artifact: Artifact, bytes: Buffer): void {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.transaction(() => {
      const job = this.get(expected.job_id),
        current = job.artifacts.find((a) => a.artifact_id === artifact.artifact_id);
      if (
        !current ||
        !validCanvasResult(job, current) ||
        job.account_ref !== expected.account_ref ||
        job.input_hash !== expected.input_hash ||
        fingerprint(job.remote_ids) !== fingerprint(expected.remote_ids) ||
        fingerprint(current.canvas_result) !== fingerprint(artifact.canvas_result)
      )
        throw new TripoError(
          'CANVAS_RESULT_IDENTITY_CHANGED',
          'The original Canvas result changed before its bytes were frozen.',
          'read',
        );
      if (current.sha256) {
        if (current.sha256 !== sha256 || current.bytes !== bytes.length)
          throw new TripoError(
            'CANVAS_RESULT_CONTENT_CHANGED',
            'Another reader froze different original Canvas bytes; no file was published.',
            'read',
          );
        return;
      }
      const artifacts = job.artifacts.map((a) =>
        a.artifact_id === current.artifact_id ? { ...a, sha256, bytes: bytes.length } : a,
      );
      this.db
        .prepare('UPDATE jobs SET artifacts=?,updated_at=? WHERE job_id=?')
        .run(encode(artifacts), new Date().toISOString(), job.job_id);
      this.event(job.job_id, job.state, { canvas_result_verified: current.artifact_id, sha256 });
    });
  }
  saveArtifact(id: string, artifact: Artifact, expectedNative?: ArtifactSaveGuard): Job {
    return this.transaction(() => {
      const job = this.get(id);
      assertSegmentEntityJob(this, job);
      const current = job.artifacts.find((item) => item.artifact_id === artifact.artifact_id);
      validateCanvasSave(job, current, artifact);
      this.validateMaterialSave(job, current, artifact, expectedNative);
      // 网络/缓存恢复包含 await；在写入下载位置的同一事务内重新确认原回执，不能只验调用开始时的快照。
      if (
        expectedNative &&
        (job.account_ref !== expectedNative.account_ref ||
          job.operation !== expectedNative.operation ||
          (expectedNative.input !== undefined &&
            fingerprint(job.input) !== fingerprint(expectedNative.input)) ||
          fingerprint(job.remote_ids) !== fingerprint(expectedNative.remote_ids) ||
          current?.kind !== expectedNative.kind ||
          current?.format !== expectedNative.format ||
          current?.index !== expectedNative.index)
      )
        throw new TripoError(
          'NATIVE_OUTPUT_IDENTITY_CHANGED',
          'The original task identity changed while downloading; the file was not bound to another task.',
          'read',
        );
      if (
        expectedNative &&
        current?.native_validation &&
        (artifact.native_validation?.identity !== current.native_validation.identity ||
          artifact.sha256 !== current.native_validation.sha256 ||
          artifact.bytes !== current.native_validation.bytes)
      )
        throw new TripoError(
          'NATIVE_OUTPUT_CONTENT_CHANGED',
          'Downloaded bytes differ from the frozen native artifact proof.',
          'read',
        );
      this.validateDeliverySave(job, current, artifact);
      const saved = this.withDeliveryLocations(job, current, artifact);
      const artifacts = job.artifacts.map((a) => (a.artifact_id === artifact.artifact_id ? saved : a));
      this.db
        .prepare('UPDATE jobs SET artifacts=?,updated_at=? WHERE job_id=?')
        .run(encode(artifacts), new Date().toISOString(), id);
      this.event(id, job.state, { downloaded: artifact.artifact_id, sha256: artifact.sha256 });
      return this.get(id);
    });
  }
  private withDeliveryLocations(job: Job, current: Artifact | undefined, next: Artifact): Artifact {
    if (labReferenceEditPolicy(this, job)) {
      if (!current) return labReferenceFailure('The verified Lab artifact disappeared before delivery.');
      const proof = labReferenceOutputProof(this, job, current);
      if (next.processing || next.sha256 !== proof.sha256 || next.bytes !== proof.bytes)
        return labReferenceFailure('Downloaded bytes differ from the original verified Lab model.');
      return retainFrontendDeliveries(current, next, String(proof.identity));
    }
    if (frontendOutputRequested(this, job))
      return retainFrontendDeliveries(current, next, frontendOutputIdentity(job));
    if (transferFinalParent(job)) return this.withTransferDeliveryLocations(job, current, next);
    if (
      (next.kind === 'model' || next.artifact_id === 'semantic-mask') &&
      smartSegmentScaleRequested(this, job)
    )
      return this.withScaleDeliveryLocations(job, current, next);
    return (
      retainUnbakedDeliveries(this, job, current, next) ??
      retainExportJpegDeliveries(this, job, current, next) ??
      retainLocalExportDeliveries(this, job, current, next) ??
      next
    );
  }
  private withTransferDeliveryLocations(job: Job, current: Artifact | undefined, next: Artifact): Artifact {
    const complete = transferOutputProof(this, job),
      proof = next.kind === 'model' ? complete : object(complete?.mask);
    if (!current || !proof || next.processing || next.sha256 !== proof.sha256 || next.bytes !== proof.bytes)
      throw new TripoError(
        'NATIVE_OUTPUT_CONTENT_CHANGED',
        'Downloaded bytes differ from the original verified affine transfer artifact.',
        'read',
      );
    return retainFrontendDeliveries(current, next, String(proof.identity));
  }
  private withScaleDeliveryLocations(job: Job, current: Artifact | undefined, next: Artifact): Artifact {
    const proof =
      current &&
      (current.kind === 'model' ? scaleOutputProof(this, job, current) : scaleMaskProof(this, job, current));
    if (!proof || next.processing || next.sha256 !== proof.sha256 || next.bytes !== proof.bytes)
      throw new TripoError(
        'SMARTSEGMENT_SCALE_OUTPUT_CHANGED',
        'Downloaded bytes differ from the verified original metadata segmentation.',
        'read',
      );
    return retainFrontendDeliveries(current, next, String(proof.identity));
  }
  /** 固定证明键自动参与最终事务；调用方遗漏可选guard也不能绕过交付摘要约束。 */
  private validateDeliverySave(job: Job, current: Artifact | undefined, artifact: Artifact): void {
    if (labReferenceEditPolicy(this, job)) {
      if (!current) return labReferenceFailure('The original Lab artifact is missing.');
      assertLabReferenceSnapshot(this, job, current);
      labReferenceOutputProof(this, job, artifact);
    }
    assertAffineDelivery(this, job, artifact);
    assertTransferDelivery(this, job, artifact);
    assertImageSizeDelivery(this, job, artifact);
    assertImageBackgroundDelivery(this, job, artifact);
    if (frontendOutputRequested(this, job)) {
      if (!current)
        throw new TripoError(
          'FRONTEND_OUTPUT_IDENTITY_CHANGED',
          'The original frontend model artifact is missing.',
          'read',
        );
      assertFrontendOutput(this, job, current);
      assertFrontendOutput(this, job, artifact);
    }
    for (const delivery of deliveryPolicies(job, current ?? artifact)) {
      const proof = this.requestPolicy(job.account_ref, delivery.key);
      if (!proof) continue;
      const incoming = deliveryPolicies(job, artifact).find((entry) => entry.key === delivery.key)!;
      if (
        !current ||
        job.state !== 'succeeded' ||
        proof.identity !== delivery.identity ||
        proof.identity !== incoming.identity
      )
        throw new TripoError(
          'ARTIFACT_POLICY_IDENTITY_CHANGED',
          'The original model identity changed before its delivery could be saved.',
          'read',
        );
      validateDeliveryMetadata(current, proof, delivery.source);
      validateDeliveryMetadata(artifact, proof, delivery.source, true);
    }
  }
  private validateMaterialSave(
    job: Job,
    current: Artifact | undefined,
    artifact: Artifact,
    expectedNative?: ArtifactSaveGuard,
  ): void {
    if (expectedNative?.materialProof) {
      const proof = this.requestPolicy(job.account_ref, expectedNative.materialProof.key);
      if (
        !current ||
        fingerprint(expectedNative.input) !== fingerprint(job.input) ||
        !proof ||
        proof.identity !== unbakedIdentity(job, current) ||
        proof.identity !== expectedNative.materialProof.identity
      )
        throw new TripoError(
          'UNBAKED_OUTPUT_IDENTITY_CHANGED',
          'The verified material export changed before its download was saved.',
          'read',
        );
      if (
        proof.sha256 !== artifact.sha256 ||
        proof.bytes !== artifact.bytes ||
        proof.sha256 !== expectedNative.materialProof.sha256 ||
        proof.bytes !== expectedNative.materialProof.bytes
      )
        throw new TripoError(
          'UNBAKED_OUTPUT_CONTENT_CHANGED',
          'Downloaded bytes differ from the first material proof.',
          'read',
        );
    }
  }
  /** 验收证明和下载位置可由不同进程补充，原子合并当前记录，避免覆盖并发下载元数据。 */
  saveNativeValidation(
    id: string,
    artifactId: string,
    validation: NonNullable<Artifact['native_validation']>,
    expected?: Pick<Job, 'account_ref' | 'operation' | 'remote_ids'> & Pick<Artifact, 'format' | 'index'>,
  ): void {
    this.transaction(() => {
      const job = this.get(id);
      const current = job.artifacts.find((artifact) => artifact.artifact_id === artifactId);
      if (!current)
        throw new TripoError('ARTIFACT_NOT_FOUND', 'Native validation artifact no longer exists.');
      // 读取原字节期间另一进程可能改变回执/产物；旧证明不能写到新身份上。
      if (
        expected &&
        (job.account_ref !== expected.account_ref ||
          job.operation !== expected.operation ||
          fingerprint(job.remote_ids) !== fingerprint(expected.remote_ids) ||
          current.format !== expected.format ||
          current.index !== expected.index)
      )
        throw new TripoError(
          'NATIVE_OUTPUT_IDENTITY_CHANGED',
          'The original task identity changed during native verification.',
          'read',
        );
      if (
        (current.sha256 && current.sha256 !== validation.sha256) ||
        (current.bytes && current.bytes !== validation.bytes) ||
        (current.native_validation &&
          (current.native_validation.identity !== validation.identity ||
            current.native_validation.sha256 !== validation.sha256 ||
            current.native_validation.bytes !== validation.bytes))
      )
        throw new TripoError(
          'NATIVE_OUTPUT_CONTENT_CHANGED',
          'Another reader already froze different native bytes; the original proof was preserved.',
          'read',
        );
      if (current.native_validation) return;
      const artifacts = job.artifacts.map((artifact) =>
        artifact.artifact_id === artifactId ? { ...artifact, native_validation: validation } : artifact,
      );
      this.db
        .prepare('UPDATE jobs SET artifacts=?,updated_at=? WHERE job_id=?')
        .run(encode(artifacts), new Date().toISOString(), id);
      this.event(id, job.state, {
        native_validation: artifactId,
        geometry_compression: 'meshopt',
        sha256: validation.sha256,
      });
    });
  }
  /** 图片编码证明只覆盖自身字段，保留并发已交付路径；旧格式路径不能冒充新格式交付。 */
  saveImageOutput(id: string, artifactId: string, metadata: NonNullable<Artifact['image_output']>): void {
    this.transaction(() => {
      const job = this.get(id);
      if (!job.artifacts.some((item) => item.artifact_id === artifactId))
        throw new TripoError('ARTIFACT_NOT_FOUND', 'Image output artifact no longer exists.');
      const artifacts = job.artifacts.map((artifact) => {
        if (artifact.artifact_id !== artifactId) return artifact;
        const next = { ...artifact, image_output: metadata, format: metadata.target_format };
        if (artifact.format !== metadata.target_format) {
          delete next.local_path;
          delete next.sha256;
          delete next.bytes;
          delete next.processing;
          delete next.source_sha256;
        }
        assertImageSizeDelivery(this, job, next);
        assertImageBackgroundDelivery(this, job, next);
        return next;
      });
      this.db
        .prepare('UPDATE jobs SET artifacts=?,updated_at=? WHERE job_id=?')
        .run(encode(artifacts), new Date().toISOString(), id);
      this.event(id, job.state, {
        image_output: artifactId,
        target_format: metadata.target_format,
        source_sha256: metadata.source_sha256,
        sha256: metadata.sha256,
      });
    });
  }
  /** 原图证明与缓存位置原子绑定；尺寸失败同样保存事实，不能被后来的另一组像素替换。 */
  saveImageSize(expected: Job, artifact: Artifact, metadata: NonNullable<Artifact['image_size']>): void {
    this.transaction(() => {
      const job = this.get(expected.job_id),
        size = readImageSize(this, job);
      const current = job.artifacts.find((a) => a.artifact_id === artifact.artifact_id);
      if (
        !size ||
        job.state !== 'succeeded' ||
        job.operation !== 'image' ||
        !current ||
        current.kind !== 'image' ||
        imageSizeIdentity(job, current, size) !== imageSizeIdentity(expected, artifact, size) ||
        metadata.identity !== imageSizeIdentity(job, current, size) ||
        metadata.expected_width !== size.width ||
        metadata.expected_height !== size.height
      )
        throw new TripoError(
          'IMAGE_SIZE_IDENTITY_CHANGED',
          'The original image identity changed before its pixel proof could be saved.',
          'read',
        );
      const key = imageSizeProofKey(job, current),
        frozen = imageSizeFrozenProof(metadata);
      const previous = this.requestPolicy(job.account_ref, key);
      if (previous && fingerprint(previous) !== fingerprint(frozen))
        throw new TripoError(
          'IMAGE_SIZE_CONTENT_CHANGED',
          'Another reader already froze different original image bytes or dimensions.',
          'read',
        );
      assertOriginalImageFacts(current, metadata, 'IMAGE_SIZE_CONTENT_CHANGED');
      if (!previous)
        this.db
          .prepare('INSERT INTO request_policies(account_ref,request_id,policy,legacy) VALUES(?,?,?,0)')
          .run(job.account_ref, key, encode(frozen));
      const artifacts = job.artifacts.map((a) =>
        a.artifact_id === artifact.artifact_id ? { ...a, image_size: metadata } : a,
      );
      this.db
        .prepare('UPDATE jobs SET artifacts=?,updated_at=? WHERE job_id=?')
        .run(encode(artifacts), new Date().toISOString(), job.job_id);
      this.event(job.job_id, job.state, {
        image_size: artifact.artifact_id,
        sha256: metadata.source_sha256,
        width: metadata.width,
        height: metadata.height,
      });
    });
  }
  /** 即使alpha不符合也保存原图事实；并发恢复仅能更换缓存位置，不能更换原图或结果。 */
  saveImageBackground(
    expected: Job,
    artifact: Artifact,
    metadata: NonNullable<Artifact['image_background']>,
  ): void {
    this.transaction(() => {
      const job = this.get(expected.job_id),
        current = job.artifacts.find((a) => a.artifact_id === artifact.artifact_id);
      if (
        !readImageBackground(this, job) ||
        job.state !== 'succeeded' ||
        job.operation !== 'image' ||
        job.input.model_version !== 'gpt_image_2.5_sunburst' ||
        !current ||
        current.kind !== 'image' ||
        imageBackgroundIdentity(job, current) !== imageBackgroundIdentity(expected, artifact) ||
        metadata.identity !== imageBackgroundIdentity(job, current) ||
        !validImageBackgroundProof(metadata)
      )
        throw new TripoError(
          'IMAGE_BACKGROUND_IDENTITY_CHANGED',
          'The original image identity changed before its alpha proof could be saved.',
          'read',
        );
      const key = imageBackgroundProofKey(job, current),
        frozen = imageBackgroundFrozenProof(metadata),
        previous = this.requestPolicy(job.account_ref, key);
      if (previous && fingerprint(previous) !== fingerprint(frozen))
        throw new TripoError(
          'IMAGE_BACKGROUND_CONTENT_CHANGED',
          'Another reader already froze different original image bytes or alpha.',
          'read',
        );
      assertOriginalImageFacts(current, metadata, 'IMAGE_BACKGROUND_CONTENT_CHANGED');
      if (!previous)
        this.db
          .prepare('INSERT INTO request_policies(account_ref,request_id,policy,legacy) VALUES(?,?,?,0)')
          .run(job.account_ref, key, encode(frozen));
      const artifacts = job.artifacts.map((a) =>
        a.artifact_id === artifact.artifact_id ? { ...a, image_background: metadata } : a,
      );
      this.db
        .prepare('UPDATE jobs SET artifacts=?,updated_at=? WHERE job_id=?')
        .run(encode(artifacts), new Date().toISOString(), job.job_id);
      this.event(job.job_id, job.state, {
        image_background: artifact.artifact_id,
        sha256: metadata.source_sha256,
        nonopaque_pixels: metadata.nonopaque_pixels,
      });
    });
  }
}
