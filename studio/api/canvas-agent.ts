/** 画布创作任务使用与普通生成相同的持久状态；本地幂等不冒充不带幂等键的 Turn 接口保证。 */
import { CanvasClient } from './canvas-client.ts';
import { isAvailableCanvasOutput } from './canvas-turn-assets.ts';
import type { StudioClient } from './client.ts';
import type { ArtifactLinks } from '../auth/artifact-links.ts';
import type { Job, RemoteStatus, Artifact, ObservedCost } from '../contracts/types.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
const method = (service: string, action: string) => `/tripo.canvas.api.agent.${service}Service/${action}`;

/** 网页按附件顺序保留同素材在不同节点的引用；不能按 assetId 去重而丢失来源。 */
function attachmentRefs(input: Record<string, unknown>): Record<string, unknown>[] {
  return array(input.refs).map((value) => {
    const ref = object(value);
    const kind = text(ref.kind).trim();
    return {
      assetId: ref.asset_id,
      ...(ref.filename ? { filename: ref.filename } : {}),
      ...(kind
        ? {
            kind:
              kind.length <= 32
                ? kind
                : kind.startsWith('image/')
                  ? 'image'
                  : kind.startsWith('model/')
                    ? 'model'
                    : 'file',
          }
        : {}),
      ...(ref.node_id ? { nodeId: ref.node_id } : {}),
    };
  });
}

/** 网页在提交前拒绝已离开当前画布的引用；上传附件没有 nodeId，仍可独立使用。 */
async function checkReferenceNodes(
  canvas: CanvasClient,
  sessionId: unknown,
  refs: Record<string, unknown>[],
): Promise<void> {
  const nodeIds = refs.map((ref) => text(ref.nodeId)).filter(Boolean);
  if (!nodeIds.length) return;
  const detail = object(await canvas.call(method('Session', 'GetSession'), { sessionId }));
  const session = object(detail.session);
  const canvasId = text(session.canvasId);
  if (session.sessionId !== sessionId || !canvasId)
    throw new TripoError('CONTRACT_CHANGED', 'Attachment session identity is unavailable.', 'not_submitted');
  const graph = object(await canvas.call(method('Canvas', 'GetCanvas'), { canvasId }));
  if (object(graph.canvas).canvasId !== canvasId)
    throw new TripoError('CONTRACT_CHANGED', 'Attachment canvas identity mismatch.', 'not_submitted');
  const nodes = new Map(
    array(graph.nodes)
      .map(object)
      .map((node) => [text(node.id), node]),
  );
  if (nodeIds.some((nodeId) => !nodes.has(nodeId)))
    throw new TripoError(
      'CANVAS_CHANGED',
      'An attachment source node is no longer in the session canvas. Read the canvas and update refs.',
      'not_submitted',
    );
  const uploads = new Set<string>();
  const generated: Record<string, unknown>[] = [];
  for (const ref of refs) {
    if (!ref.nodeId) continue;
    const node = nodes.get(text(ref.nodeId))!;
    if (node.type !== 'NODE_TYPE_UPLOAD_CARD') {
      generated.push(ref);
      continue;
    }
    if (!array(node.inputMount).some((asset) => object(asset).assetId === ref.assetId))
      throw new TripoError(
        'CANVAS_CHANGED',
        'The referenced upload is no longer attached to this node.',
        'not_submitted',
      );
    uploads.add(text(ref.assetId));
  }
  await checkUploadedReferences(canvas, text(object(graph.canvas).projectId), [...uploads]);
  await checkGeneratedReferences(canvas, generated);
}

/** SaveCanvas 能回显其他项目的素材，但 CreateTurn 会拒绝；必须核验当前项目内真实可见且已就绪。 */
async function checkUploadedReferences(
  canvas: CanvasClient,
  projectId: string,
  assetIds: string[],
): Promise<void> {
  if (!assetIds.length) return;
  if (!projectId)
    throw new TripoError('CONTRACT_CHANGED', 'Attachment canvas has no project identity.', 'not_submitted');
  const result = object(await canvas.call(method('Asset', 'BatchGetInputAssets'), { projectId, assetIds }));
  const ready = new Set(
    array(result.assets)
      .map(object)
      .filter((asset) => asset.status === 'INPUT_ASSET_STATUS_READY')
      .map((asset) => text(asset.assetId)),
  );
  if (assetIds.some((assetId) => !ready.has(assetId)))
    throw new TripoError(
      'INPUT_NOT_READY',
      'Upload references must be ready input assets in the current Canvas project.',
      'not_submitted',
    );
}

/** 生成结果不是 InputAsset；按节点输出的双重身份核验，不能用同名或最新素材替代。 */
async function checkGeneratedReferences(
  canvas: CanvasClient,
  refs: Record<string, unknown>[],
): Promise<void> {
  if (!refs.length) return;
  const nodeIds = [...new Set(refs.map((ref) => text(ref.nodeId)))];
  const result = object(await canvas.call(method('Node', 'ListNodesAssets'), { nodeIds }));
  const outputs = array(result.nodes).map(object);
  for (const ref of refs) {
    const nodes = outputs.filter((value) => value.nodeId === ref.nodeId),
      matching =
        nodes.length === 1
          ? array(nodes[0]!.assets)
              .map(object)
              .filter((asset) => asset.nodeId === ref.nodeId && asset.assetId === ref.assetId)
          : [];
    // 准备工具不是执行锁；这里刚读到的生成状态及身份仍须独立核验，URL 存在并不代表可用。
    if (matching.length !== 1 || !isAvailableCanvasOutput(matching[0]!))
      throw new TripoError(
        'INPUT_NOT_READY',
        'Generated reference is unavailable or ambiguous on the specified node and asset ID.',
        'not_submitted',
      );
  }
}

export async function submitCreativeTask(
  client: StudioClient,
  job: Job,
): Promise<{ remote_ids: { task_id: string } }> {
  const canvas = new CanvasClient(client);
  const x = job.input;
  if (job.operation === 'canvas_lab') {
    const result = object(
      await canvas.call(
        method('Lab', 'CreateLabJob'),
        {
          nodeId: x.node_id,
          prompt: x.prompt,
          idempotencyKey: job.job_id,
          ...(x.asset_ids ? { assetIds: x.asset_ids } : {}),
        },
        true,
      ),
    );
    if (!text(result.jobId))
      throw new TripoError('CONTRACT_CHANGED', 'Lab receipt has no job ID.', 'unknown');
    return { remote_ids: { task_id: text(result.jobId) } };
  }
  if (job.operation === 'canvas_continue') {
    // 网页为每次答案生成新的幂等键；复制创建 Turn 的 requestId 会被服务端当作旧请求而静默忽略。
    const detail = object(await canvas.call(method('Turn', 'GetTurnDetail'), { turnId: x.turn_id }));
    if (object(detail.turn).turnId !== x.turn_id)
      throw new TripoError('CONTRACT_CHANGED', 'Continuation target identity mismatch.', 'not_submitted');
    if (x.request_id && x.request_id === object(detail.turn).requestId)
      throw new TripoError(
        'INVALID_INPUT',
        'Do not reuse turn.requestId for an answer; omit the remote request ID to use the persisted job UUID.',
        'not_submitted',
      );
    await canvas.call(
      method('Turn', 'ContinueTurn'),
      {
        turnId: x.turn_id,
        requestId: x.request_id ?? job.job_id,
        selectedOptionIds: x.selected_option_ids,
        ...(x.confirmed_parts ? { confirmedParts: x.confirmed_parts } : {}),
        ...(x.other_text !== undefined ? { otherText: x.other_text } : {}),
        ...(x.other_texts ? { otherTexts: x.other_texts } : {}),
        ...(x.text !== undefined ? { text: x.text } : {}),
        ...(x.attachment_ids ? { attachmentIds: x.attachment_ids } : {}),
      },
      true,
    );
    return { remote_ids: { task_id: text(x.turn_id) } };
  }
  const refs = attachmentRefs(x);
  await checkReferenceNodes(canvas, x.session_id, refs);
  const result = object(
    await canvas.call(
      method('Session', 'CreateTurn'),
      {
        sessionId: x.session_id,
        text: x.text,
        mode: x.mode === 'auto' ? 'MODE_AUTO' : 'MODE_CONTROL',
        nodeId: x.node_id ?? '',
        attachmentIds: refs.length ? refs.map((ref) => ref.assetId) : x.attachment_ids,
        ...(refs.length ? { refs } : {}),
      },
      true,
    ),
  );
  const id = text(result.id) || text(result.turnId);
  if (!id)
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Turn receipt has no ID; reconcile before any further submission.',
      'unknown',
    );
  return { remote_ids: { task_id: id } };
}
export async function creativeDetail(client: StudioClient, job: Job): Promise<Record<string, unknown>> {
  const lab = job.operation === 'canvas_lab';
  const result = object(
    await new CanvasClient(client).call(
      method(lab ? 'Lab' : 'Turn', lab ? 'GetLabJob' : 'GetTurnDetail'),
      lab ? { jobId: job.remote_ids.task_id } : { turnId: job.remote_ids.task_id },
    ),
  );
  const detail = lab ? result : Object.keys(object(result.turn)).length ? object(result.turn) : result;
  const id = lab ? detail.jobId : (detail.id ?? detail.turnId);
  if (id !== job.remote_ids.task_id)
    throw new TripoError('CONTRACT_CHANGED', 'Creative task identity mismatch.');
  if (!lab && detail.sessionId && job.input.session_id && detail.sessionId !== job.input.session_id)
    throw new TripoError('CONTRACT_CHANGED', 'Turn belongs to a different session.');
  return detail;
}
export async function creativeStatus(
  client: StudioClient,
  job: Job,
  links: ArtifactLinks,
): Promise<RemoteStatus> {
  const detail = await creativeDetail(client, job);
  const status = text(detail.status)
    .replace(/^TURN_STATUS_/, '')
    .toLowerCase();
  if (['failed', 'cancelled'].includes(status))
    return {
      state: 'failed',
      progress: 0,
      artifacts: [],
      error: { code: 'REMOTE_TASK_FAILED', remote_status: status },
    };
  if (status === 'waiting_for_user') return { state: 'waiting_input', progress: 0, artifacts: [] };
  if (['queued', 'running'].includes(status)) return { state: 'running', progress: 0, artifacts: [] };
  if (!['completed', 'done'].includes(status))
    throw new TripoError('CONTRACT_CHANGED', 'Unknown creative task status.');
  return { state: 'succeeded', progress: 100, artifacts: labArtifacts(job, detail, links) };
}
function labArtifacts(job: Job, detail: Record<string, unknown>, links: ArtifactLinks): Artifact[] {
  if (job.operation !== 'canvas_lab') return [];
  const artifacts: Artifact[] = [];
  for (const item of array(detail.artifacts).map(object)) {
    const url = text(item.downloadUrl);
    const id = text(item.artifactId);
    if (!url || !id) continue;
    let format: string;
    try {
      format = new URL(url).pathname.split('.').at(-1)?.toLowerCase() ?? '';
    } catch {
      continue;
    }
    if (!['png', 'jpg', 'jpeg', 'webp', 'glb', 'fbx', 'obj', 'stl', 'usdz', '3mf', 'zip'].includes(format))
      continue;
    const kind = ['png', 'jpg', 'jpeg', 'webp'].includes(format) ? 'image' : 'model';
    links.set(`${job.job_id}:${id}`, url);
    artifacts.push({
      artifact_id: id,
      kind,
      format: format === 'jpg' ? 'jpeg' : format,
      index: artifacts.length,
    });
  }
  return artifacts;
}
export async function creativeArtifactUrl(
  client: StudioClient,
  job: Job,
  artifact: Artifact,
  links: ArtifactLinks,
): Promise<string> {
  // Lab 下载链接可过期，按原 jobId/artifactId 只读刷新，不触发另一次创作。
  const detail = await creativeDetail(client, job);
  const artifacts = labArtifacts(job, detail, links);
  const url =
    artifacts.some((x) => x.artifact_id === artifact.artifact_id) &&
    links.get(`${job.job_id}:${artifact.artifact_id}`);
  if (!url) throw new TripoError('ARTIFACT_NOT_READY', 'Original Lab artifact is unavailable.');
  return url;
}
export async function creativeCost(client: StudioClient, job: Job): Promise<ObservedCost | undefined> {
  if (job.operation !== 'canvas_lab') return undefined;
  const detail = await creativeDetail(client, job);
  const value = object(detail.billing).chargedCredits;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    return undefined;
  return {
    credits: Number(value),
    source: 'studio_lab',
    status: 'fulfilled',
    observed_at: new Date().toISOString(),
  };
}
