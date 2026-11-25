/** Canvas 项目、图节点和运行查询均提供独立功能；不包含站内通知或账号管理。 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { id } from '../contracts/primitives.ts';
import { CanvasClient, bindCanvasAccount } from './canvas-client.ts';
import type { StudioClient } from './client.ts';
import { sanitize, object, array, TripoError } from '../contracts/errors.ts';
import { extraCanvasResources } from './canvas-extra.ts';
import { canvasGraphIssues } from './canvas-graph.ts';
import { eventSchema, readCanvasEvents } from './canvas-events.ts';
import { readSavedAssetRebindings } from './canvas-rebind.ts';
import { resolveLabInputs } from './canvas-lab-inputs.ts';
import { resolveCanvasLabPlan } from './canvas-lab-plan.ts';
import { resolveCanvasTextureReference } from './canvas-texture-reference.ts';
import { resolveCanvasExtractionPlan } from './canvas-extraction-plan.ts';
import type { ExtractionMemory } from './canvas-extraction-memory.ts';
import { resolveCanvasAnswerPlan } from './canvas-answer-plan.ts';
import { resolveCanvasTurnPlan } from './canvas-turn-plan.ts';
import { resolveCanvasTurnStopPlan } from './canvas-turn-stop-plan.ts';
import { canvasAuditSchema, auditCanvas } from './canvas-audit.ts';
import { canvasHistorySchema, inspectCanvasSessionHistory } from './canvas-history.ts';
import { canvasToolCoverage } from './canvas-capabilities.ts';
import { inspectLabTaskInstructions } from './canvas-lab-instructions.ts';

const empty = z.object({}).strict();
const project = z.object({ projectId: id }).strict();
const canvas = z.object({ canvasId: id }).strict();
const node = z.object({ nodeId: id }).strict();
const nodeAssets = z.array(z.record(z.string(), z.json())).max(500);
const nodeTypes = [
  'ASSET',
  'GENERATE_IMAGE',
  'GENERATE_HD_MODEL',
  'GENERATE_SM_MODEL',
  'IMAGE_PROMPT',
  'IMAGE_SPLIT',
  'MULTIVIEW',
  'MULTIVIEW_RESULT',
  'PARTS_DETECT',
  'PBR',
  'RETOPOLOGY',
  'REVIEW',
  'RIGGING',
  'SECTION',
  'SEGMENTATION',
  'SEMANTIC_SPLIT',
  'SMART_UV',
  'SPLIT_RESULT',
  'TEXTURE',
  'UPLOAD_CARD',
  'ANIMATION',
  'AI_3D_LAB',
  'HOLY_MOLLY',
] as const;
export const canvasNode = z
  .object({
    id,
    type: z.enum(nodeTypes.map((t) => `NODE_TYPE_${t}`) as [string, ...string[]]),
    name: z.string().max(500).optional(),
    pid: z.string().max(200).optional(),
    // GetCanvas 对分组/上传等空参数节点返回 null；读回后仍需能通过保存与执行预检。
    params: z.record(z.string(), z.json()).nullable().default({}),
    inputMount: nodeAssets.optional(),
    nodeAssets: nodeAssets.optional(),
    displayNo: z.string().max(100).optional(),
    batchId: z.string().max(200).optional(),
    extraction: z.json().optional(),
    taskInstructions: z.json().optional(),
    ui: z
      .object({
        position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
        // protobuf 将未测量的宽高回读为 0，网页此时按内容自动布局。
        size: z
          .object({ width: z.number().nonnegative(), height: z.number().nonnegative() })
          .strict()
          .nullish(),
      })
      .strict()
      .optional(),
  })
  .strict();
// 拆图生成的系统结果关联使用空端口，由图校验限定允许的节点对。
const port = z.object({ nodeId: id, port: z.string().max(100).default('') }).strict();
const edge = z.object({ id, source: port, target: port }).strict();
export const canvasSaveSchema = canvas
  .extend({
    projectId: id.optional(),
    clientId: id,
    revision: z.string().regex(/^\d+$/),
    nodes: z.array(canvasNode).max(1000),
    edges: z.array(edge).max(4000),
  })
  .superRefine((x, ctx) => {
    for (const message of canvasGraphIssues(x.nodes, x.edges, false))
      ctx.addIssue({ code: 'custom', message });
  });
export interface CanvasSpec {
  name: string;
  description: string;
  schema: z.ZodType;
  method: string;
  readOnly: boolean;
  destructive?: boolean;
}
const spec = (
  name: string,
  service: string,
  method: string,
  schema: z.ZodType,
  description: string,
  readOnly = true,
): CanvasSpec => ({
  name,
  method: `/tripo.canvas.api.agent.${service}Service/${method}`,
  schema,
  description,
  readOnly,
});
export const canvasResources: CanvasSpec[] = [
  spec(
    'session_history',
    'Session',
    'GetSession',
    canvasHistorySchema,
    'Cross-check returned session history against the turn inventory and exact turn details in two stable read snapshots. Reports missing, changed or reordered messages and local limits; does not claim complete server history, invent pagination, answer cards or submit work. Read full messages with session-get.',
  ),
  spec(
    'audit',
    'Canvas',
    'GetCanvas',
    canvasAuditSchema,
    'Audit a saved Canvas after an Agent conversation: verify exact turn/session ownership, node state, expected assets and a stable read snapshot. Read-only; does not approve REVIEW nodes, download files or accept visual quality. Inspect original artifacts before delivery.',
  ),
  spec(
    'events',
    'Canvas',
    'SubscribeAgentEvents',
    eventSchema,
    'Read bounded real-time Agent or 3D Lab events, returning a resume cursor. Does not start a task.',
  ),
  ...extraCanvasResources,
  spec(
    'review',
    'Canvas',
    'SaveCanvas',
    canvas.extend({ nodeId: id, revision: z.string().regex(/^\d+$/), approved: z.boolean() }),
    'Approve or revoke an image review checkpoint at an expected revision. Returns downstream node IDs; run those separately to continue.',
    false,
  ),
  spec(
    'projects',
    'Project',
    'ListProjects',
    empty.extend({
      offset: z.number().int().min(0).default(0),
      pageSize: z.number().int().min(1).max(100).default(20),
    }),
    'List your Canvas projects.',
  ),
  spec(
    'create',
    'Project',
    'CreateProject',
    empty.extend({ name: z.string().min(1).max(200).optional() }),
    'Create an empty Canvas project.',
    false,
  ),
  spec('get_project', 'Project', 'GetProject', project, 'Inspect a Canvas project and its canvas ID.'),
  spec(
    'rename',
    'Project',
    'UpdateProject',
    project.extend({ name: z.string().min(1).max(200) }),
    'Rename a Canvas project.',
    false,
  ),
  spec(
    'visibility',
    'Project',
    'UpdateProject',
    project.extend({
      visibility: z.enum(['VISIBILITY_PRIVATE', 'VISIBILITY_PUBLIC', 'VISIBILITY_SHAREABLE']),
    }),
    'Change Canvas project visibility.',
    false,
  ),
  {
    ...spec(
      'delete',
      'Project',
      'DeleteProject',
      project,
      'Delete an explicitly selected Canvas project.',
      false,
    ),
    destructive: true,
  },
  spec(
    'from_template',
    'Project',
    'CreateProjectFromTemplate',
    empty.extend({ templateId: id, name: z.string().min(1).max(200).optional() }),
    'Create a Canvas from a template.',
    false,
  ),
  spec(
    'append_template',
    'Project',
    'AppendTemplateToProject',
    project.extend({ templateId: id }),
    'Append a template to a Canvas project.',
    false,
  ),
  spec(
    'copy_shared',
    'Project',
    'CopySharedProject',
    project,
    'Copy an accessible shared Canvas project.',
    false,
  ),
  spec(
    'preview_share',
    'Project',
    'PreviewProjectShare',
    project,
    'Preview which Canvas content can be shared.',
  ),
  spec('get', 'Canvas', 'GetCanvas', canvas, 'Read nodes, edges, revision and node execution state.'),
  spec('get_shared', 'Canvas', 'GetSharedCanvas', project, 'Read an accessible shared Canvas.'),
  spec(
    'save',
    'Canvas',
    'SaveCanvas',
    canvasSaveSchema,
    'Save a complete Canvas graph against an expected revision; conflicts are never overwritten.',
    false,
  ),
  spec(
    'node_assets',
    'Node',
    'ListNodesAssets',
    empty.extend({ nodeIds: z.array(id).min(1).max(100) }),
    'List results for selected Canvas nodes.',
  ),
  spec(
    'asset_get',
    'Node',
    'GetNodeAssetDetail',
    empty.extend({ assetId: id }),
    'Inspect one Canvas result asset.',
  ),
  spec(
    'asset_select',
    'Node',
    'SelectNodeAsset',
    node.extend({ assetId: id }),
    'Select one generated result for downstream nodes.',
    false,
  ),
  spec('batches', 'Node', 'ListNodeBatches', node, 'List result batches for a Canvas node.'),
  spec(
    'batch_select',
    'Node',
    'SelectNodeBatch',
    node.extend({ batchId: id }),
    'Select a generated result batch.',
    false,
  ),
  spec(
    'save_to_studio',
    'Node',
    'SaveNodeAssetsToStudio',
    empty.extend({ assetIds: z.array(id).min(1).max(100) }),
    'Save Canvas results into the Studio asset library.',
    false,
  ),
  spec('run_get', 'Run', 'GetRun', empty.extend({ runId: id }), 'Inspect one Canvas execution.'),
  spec('runs', 'Run', 'ListCanvasRuns', canvas, 'List execution history for a Canvas.'),
  spec('run_stop', 'Run', 'StopRun', empty.extend({ runId: id }), 'Stop a selected Canvas execution.', false),
];
export async function callCanvas(
  studio: StudioClient,
  spec: CanvasSpec,
  input: unknown,
  memory?: ExtractionMemory,
): Promise<unknown> {
  if (spec.name === 'tools') {
    const result = await new CanvasClient(studio).call(spec.method, spec.schema.parse(input));
    return sanitize({
      ...object(result),
      cli_support: canvasToolCoverage(result, canvasNode.shape.type.options),
    });
  }
  if (spec.name === 'audit') return await auditCanvas(studio, input);
  if (spec.name === 'session_history') return await inspectCanvasSessionHistory(studio, input);
  if (spec.name === 'turn_plan') return await resolveCanvasTurnPlan(studio, input);
  if (spec.name === 'turn_stop_plan') return await resolveCanvasTurnStopPlan(studio, input);
  if (spec.name === 'answer_plan') return await resolveCanvasAnswerPlan(studio, input);
  if (spec.name === 'extraction_plan') return await resolveCanvasExtractionPlan(studio, input, memory);
  if (spec.name === 'texture_reference') return await resolveCanvasTextureReference(studio, input);
  if (spec.name === 'lab_inputs') return await resolveLabInputs(studio, input);
  if (spec.name === 'lab_plan') return await resolveCanvasLabPlan(studio, input);
  if (spec.name === 'lab_instructions') {
    const parameters = object(spec.schema.parse(input));
    const result = await new CanvasClient(studio).call(spec.method, parameters);
    return sanitize(inspectLabTaskInstructions(result, String(parameters.nodeId)));
  }
  if (spec.name === 'events') return await readCanvasEvents(studio, input);
  if (spec.name === 'review') return await reviewCanvas(studio, object(spec.schema.parse(input)));
  if (spec.name === 'template_create')
    return await createTemplate(studio, spec, object(spec.schema.parse(input)));
  if (spec.name === 'save') {
    studio = bindCanvasAccount(studio);
    const graph = canvasSaveSchema.parse(input);
    const saved = await new CanvasClient(studio).call(spec.method, canvasSaveBody(graph), true);
    return sanitize({ ...object(saved), ...(await readSavedAssetRebindings(studio, graph.nodes)) });
  }
  return sanitize(await new CanvasClient(studio).call(spec.method, spec.schema.parse(input), !spec.readOnly));
}

/** CreateTemplate 的 source 字段仅标注来源，不自动复制图；必须发送已核对的完整节点/连线快照。 */
async function createTemplate(studio: StudioClient, spec: CanvasSpec, input: Record<string, unknown>) {
  const client = new CanvasClient(studio);
  const source = object(
    await client.call('/tripo.canvas.api.agent.CanvasService/GetCanvas', {
      canvasId: input.sourceCanvasId,
    }),
  );
  const info = object(source.canvas);
  if (info.canvasId !== input.sourceCanvasId || info.projectId !== input.sourceProjectId)
    throw new TripoError('CONTRACT_CHANGED', 'Template source Canvas does not belong to this project.');
  if (input.revision !== undefined && String(info.revision) !== input.revision)
    throw new TripoError('CANVAS_CHANGED', 'Read the current Canvas before creating its template.');
  const graph = canvasSaveSchema.parse({
    canvasId: info.canvasId,
    projectId: info.projectId,
    revision: info.revision,
    clientId: randomUUID(),
    nodes: source.nodes,
    edges: source.edges,
  });
  const body = { ...input };
  delete body.revision;
  const result = await client.call(
    spec.method,
    {
      ...body,
      nodes: graph.nodes.map(canvasNodeBody),
      edges: graph.edges,
    },
    true,
  );
  return sanitize({ ...object(result), source_revision: graph.revision });
}

/** 网页重建普通节点的 ui；读回的 size:null 不能再提交，有效尺寸及业务参数里的 null 必须保留。 */
function canvasNodeBody(node: z.infer<typeof canvasNode>): Record<string, unknown> {
  const value: Record<string, unknown> = { ...node, params: node.params ?? {} };
  if (node.ui)
    value.ui = {
      position: node.ui.position,
      ...(node.ui.size ? { size: node.ui.size } : {}),
    };
  return value;
}

/**
 * SaveCanvas 必须保留 nodeAssets：网页复制生成节点时服务据此创建副本资产，随后另读新 ID。
 * pending 草稿的瘦身序列化会移除此字段，但它不是网络保存契约；候选选择仍用独立接口。
 */
export function canvasSaveBody(input: unknown): Record<string, unknown> {
  const graph = canvasSaveSchema.parse(input);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const value = canvasNodeBody(node);
      delete value.displayNo;
      if (node.inputMount) value.inputMount = node.inputMount.map((asset) => ({ assetId: asset.assetId }));
      return value;
    }),
  };
}

/** 网页审核按钮保存 approved 后才运行下游；这里分开两步，避免一次批准隐式创建付费任务。 */
async function reviewCanvas(studio: StudioClient, input: Record<string, unknown>): Promise<unknown> {
  const client = new CanvasClient(studio);
  const result = object(
    await client.call('/tripo.canvas.api.agent.CanvasService/GetCanvas', { canvasId: input.canvasId }),
  );
  if (String(object(result.canvas).revision) !== input.revision)
    throw new TripoError('CANVAS_CHANGED', 'Read the current Canvas revision before reviewing.');
  const nodes = array(result.nodes).map((n) => canvasNode.parse(n));
  const target = nodes.find((n) => n.id === input.nodeId);
  if (!target || target.type !== 'NODE_TYPE_REVIEW')
    throw new TripoError('INVALID_INPUT', 'Select an existing REVIEW node.');
  target.params = { ...target.params, approved: input.approved as boolean };
  const graph = canvasSaveSchema.parse({
    canvasId: input.canvasId,
    clientId: randomUUID(),
    revision: input.revision,
    nodes,
    edges: array(result.edges),
  });
  const saved = await client.call(
    '/tripo.canvas.api.agent.CanvasService/SaveCanvas',
    canvasSaveBody(graph),
    true,
  );
  return sanitize({
    ...object(saved),
    node_id: input.nodeId,
    approved: input.approved,
    downstream_node_ids: graph.edges
      .filter((e) => e.source.nodeId === input.nodeId)
      .map((e) => e.target.nodeId),
    execution_started: false,
  });
}
