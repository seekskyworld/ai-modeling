/** Keep source runs, current selections and proved generated objects as separate evidence. */
import type { CanvasClient } from './canvas-client.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
import { id } from '../contracts/primitives.ts';
import { stableCanvasResource } from './canvas-state.ts';
import { isAvailableCanvasOutput } from './canvas-turn-assets.ts';
import { taskUrlMatches } from './canvas-result-identity.ts';

type RecordValue = Record<string, unknown>;
const uuidPathSegment = '[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}';
interface Node {
  id: string;
  type: string;
  nodeAssets?: unknown[];
}
export interface AuditRunRead {
  requested_run_id: string;
  response: RecordValue;
}
interface Attribution {
  status: 'verified' | 'unknown';
  scope: string;
  source: string;
  reason: string | null;
  turn_id?: string;
  run_id?: string;
  step_id?: string;
  task_id?: string;
  asset_id?: string;
}
export interface AuditRunAttribution extends Attribution {
  scope: 'node_run';
  source: 'canvas_run_step';
}
export interface AuditSelectionAssociation extends Attribution {
  scope: 'current_selection';
  source: 'canvas_run_step_selection';
}
export interface AuditTurnAttribution extends Attribution {
  scope: 'selected_generated_output';
  source: 'studio_execution_object';
  evidence?:
    | 'generate_image_task_path'
    | 'holy_molly_step_path'
    | 'generate_hd_model_task_path'
    | 'texture_task_path'
    | 'generate_sm_model_task_path'
    | 'retopology_task_path'
    | 'rigging_task_path'
    | 'pbr_task_path'
    | 'smart_uv_task_path';
}
function mismatch(message: string): never {
  throw new TripoError('CONTRACT_CHANGED', message);
}
function validIdentity(value: unknown): value is string {
  return id.safeParse(value).success;
}
/** The selected node scope is already bounded at 100; deduplicate run reads and limit in-flight requests. */
export async function readAuditRuns(
  client: CanvasClient,
  canvasId: string,
  turnId: string | undefined,
  nodes: Node[],
  nodeRuns: RecordValue[],
): Promise<AuditRunRead[]> {
  if (!turnId) return [];
  const selected = new Set(
    nodes
      .filter((node) => !['NODE_TYPE_UPLOAD_CARD', 'NODE_TYPE_SECTION'].includes(node.type))
      .map((node) => node.id),
  );
  const runIds = [
    ...new Set(
      nodeRuns
        .filter((run) => selected.has(text(run.nodeId)) && validIdentity(run.runId))
        .map((run) => text(run.runId)),
    ),
  ];
  const reads: AuditRunRead[] = [];
  for (let offset = 0; offset < runIds.length; offset += 4)
    reads.push(
      ...(await Promise.all(
        runIds.slice(offset, offset + 4).map(async (runId) => {
          const response = object(await client.call('/tripo.canvas.api.agent.RunService/GetRun', { runId }));
          const run = object(response.run);
          if (
            (validIdentity(run.runId) && run.runId !== runId) ||
            (validIdentity(run.canvasId) && run.canvasId !== canvasId)
          )
            mismatch('Audit run identity does not match its exact requested run and Canvas.');
          return { requested_run_id: runId, response };
        }),
      )),
    );
  return reads;
}
function uniqueRunSteps(run: RecordValue, nodeIds: string[]): { steps?: RecordValue[]; reason?: string } {
  if (!Array.isArray(run.steps) || !run.steps.length) return { reason: 'run_steps_incomplete' };
  const steps = run.steps.map(object);
  if (steps.some((step) => ![step.stepId, step.nodeId, step.taskId].every(validIdentity)))
    return { reason: 'step_identity_incomplete' };
  if (
    new Set(steps.map((step) => step.stepId)).size !== steps.length ||
    new Set(steps.map((step) => step.nodeId)).size !== steps.length
  )
    return { reason: 'run_steps_ambiguous' };
  if (new Set(steps.map((step) => step.taskId)).size !== steps.length)
    return { reason: 'run_tasks_ambiguous' };
  if (steps.some((step) => !nodeIds.includes(text(step.nodeId))))
    mismatch('Audit run step belongs to a node outside its exact source run.');
  if (steps.length !== nodeIds.length) return { reason: 'run_steps_incomplete' };
  return { steps };
}
function identifiedRunStep(
  run: RecordValue,
  current: RecordValue,
  nodeId: string,
): { step?: RecordValue; reason?: string } {
  if (!validIdentity(run.runId) || !validIdentity(run.canvasId) || !validIdentity(run.turnId))
    return { reason: 'run_identity_incomplete' };
  if (!Array.isArray(run.nodeIds) || !run.nodeIds.every(validIdentity) || !run.nodeIds.length)
    return { reason: 'run_nodes_incomplete' };
  if (new Set(run.nodeIds).size !== run.nodeIds.length) return { reason: 'run_nodes_ambiguous' };
  if (!run.nodeIds.includes(nodeId)) mismatch('Audit run does not belong to the selected node.');
  const identified = uniqueRunSteps(run, run.nodeIds);
  if (!identified.steps) return { reason: identified.reason };
  const step = identified.steps.find((step) => step.nodeId === nodeId)!;
  if (!validIdentity(current.currentStepId)) return { reason: 'step_identity_incomplete' };
  if (step.stepId !== current.currentStepId)
    mismatch('Audit current node step does not match its exact source run step.');
  return { step };
}
function executionCompleted(run: RecordValue, current: RecordValue, step: RecordValue): boolean {
  return (
    run.status === 'RUN_STATUS_SUCCEEDED' &&
    ['RUN_STEP_STATUS_DONE', 'RUN_STEP_STATUS_SUCCEEDED'].includes(text(step.status)) &&
    ['NODE_STATUS_DONE', 'NODE_STATUS_SUCCEEDED'].includes(text(current.status))
  );
}
function selectedOutputReason(node: Node, current: RecordValue, outputs: RecordValue[]): string | null {
  if (!validIdentity(current.selectedAssetId)) return 'selected_asset_identity_incomplete';
  const savedAssets = array(node.nodeAssets).map(object),
    matching = savedAssets.filter((asset) => asset.assetId === current.selectedAssetId),
    selected = savedAssets.filter((asset) => asset.selected === true),
    output = outputs.filter((asset) => asset.assetId === current.selectedAssetId),
    selectedOutputs = outputs.filter((asset) => asset.selected === true);
  if (matching.length !== 1 || output.length !== 1) return 'selected_asset_unavailable_or_ambiguous';
  if (
    selected.length !== 1 ||
    selectedOutputs.length !== 1 ||
    selected[0]?.assetId !== current.selectedAssetId ||
    selectedOutputs[0]?.assetId !== current.selectedAssetId
  )
    return 'selected_asset_not_unique';
  const saved = matching[0]!,
    asset = output[0]!;
  if (asset.nodeId !== node.id) mismatch('Audit selected asset belongs to another node.');
  if (!isAvailableCanvasOutput(saved) || !isAvailableCanvasOutput(asset))
    return 'selected_asset_not_available';
  if (stableCanvasResource(text(saved.url)) !== stableCanvasResource(text(asset.url)))
    mismatch('Audit selected asset resource differs between the saved graph and output list.');
  return null;
}
const modelObjectContracts: Record<
  string,
  { prefixes: readonly string[]; suffix: string; evidence: NonNullable<AuditTurnAttribution['evidence']> }
> = {
  NODE_TYPE_GENERATE_HD_MODEL: {
    // Studio emits distinct exact original filenames for geometry-only and textured HD results.
    prefixes: ['tripo_base_model_', 'tripo_model_'],
    suffix: '_meshopt.glb',
    evidence: 'generate_hd_model_task_path',
  },
  NODE_TYPE_TEXTURE: {
    prefixes: ['tripo_texture_'],
    suffix: '_meshopt.glb',
    evidence: 'texture_task_path',
  },
  NODE_TYPE_GENERATE_SM_MODEL: {
    prefixes: ['output_mesh_'],
    suffix: '.fbx',
    evidence: 'generate_sm_model_task_path',
  },
  NODE_TYPE_RETOPOLOGY: {
    prefixes: ['tripo_poly_'],
    suffix: '_meshopt.glb',
    evidence: 'retopology_task_path',
  },
  NODE_TYPE_RIGGING: {
    prefixes: ['tripo_rigging_'],
    suffix: '_meshopt.glb',
    evidence: 'rigging_task_path',
  },
  NODE_TYPE_PBR: {
    prefixes: ['tripo_texture_'],
    suffix: '_meshopt.glb',
    evidence: 'pbr_task_path',
  },
  NODE_TYPE_SMART_UV: {
    prefixes: ['tripo_mesh_uv_'],
    suffix: '.glb',
    evidence: 'smart_uv_task_path',
  },
};
function modelObjectEvidence(
  node: Node,
  asset: RecordValue,
  url: URL,
  step: RecordValue,
): Pick<AuditTurnAttribution, 'evidence' | 'reason'> {
  const contract = modelObjectContracts[node.type];
  if (!contract || asset.kind !== 'ASSET_KIND_MODEL')
    return { reason: 'asset_generation_binding_unavailable' };
  if (asset.role !== 'ASSET_ROLE_CURRENT') return { reason: 'asset_generation_source_unverified' };
  const path = new RegExp(`^/tripo-studio/\\d{8}/(${uuidPathSegment})/([^/]+)$`).exec(url.pathname);
  return path &&
    path[1] === step.taskId &&
    contract.prefixes.some((prefix) => path[2] === `${prefix}${text(step.taskId)}${contract.suffix}`)
    ? {
        evidence: contract.evidence,
        reason: null,
      }
    : { reason: 'asset_task_identity_unverified' };
}
/** These are observed Studio object namespaces, not arbitrary URLs containing a task-like string. */
function generatedObjectEvidence(
  node: Node,
  asset: RecordValue,
  step: RecordValue,
): Pick<AuditTurnAttribution, 'evidence' | 'reason'> {
  if (
    asset.source !== 'ASSET_SOURCE_STUDIO' ||
    !['ASSET_ROLE_CURRENT', 'ASSET_ROLE_CANDIDATE'].includes(text(asset.role))
  )
    return { reason: 'asset_generation_source_unverified' };
  let url: URL;
  try {
    url = new URL(text(asset.url));
  } catch {
    return { reason: 'asset_generation_resource_unverified' };
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/^tripo-data\.[a-z0-9-]+\.data\.tripo3d\.com$/.test(url.hostname)
  )
    return { reason: 'asset_generation_resource_unverified' };
  if (node.type === 'NODE_TYPE_GENERATE_IMAGE' && asset.kind === 'ASSET_KIND_IMAGE') {
    const path = new RegExp(`^/generate-image/\\d{8}/(${uuidPathSegment})/image\\.(?:png|jpe?g|webp)$`).exec(
      url.pathname,
    );
    return path && path[1] === step.taskId && taskUrlMatches(url.href, text(step.taskId))
      ? { evidence: 'generate_image_task_path', reason: null }
      : { reason: 'asset_task_identity_unverified' };
  }
  if (node.type === 'NODE_TYPE_HOLY_MOLLY') {
    const path = new RegExp(`^/canvas/holymolly/\\d+/(${uuidPathSegment})/[a-f0-9]{64}/index\\.html$`).exec(
      url.pathname,
    );
    return path && path[1] === step.stepId && taskUrlMatches(url.href, text(step.stepId))
      ? { evidence: 'holy_molly_step_path', reason: null }
      : { reason: 'asset_step_identity_unverified' };
  }
  return modelObjectEvidence(node, asset, url, step);
}
/** A stable selection alone never proves that the selected asset was generated by the current run. */
export function auditNodeAttribution(
  turnId: string | undefined,
  node: Node,
  current: RecordValue | undefined,
  outputs: RecordValue[],
  reads: AuditRunRead[],
): {
  run: AuditRunAttribution;
  selection: AuditSelectionAssociation;
  generation: AuditTurnAttribution;
} {
  const runBase = { scope: 'node_run', source: 'canvas_run_step' } as const,
    selectionBase = { scope: 'current_selection', source: 'canvas_run_step_selection' } as const,
    generationBase = { scope: 'selected_generated_output', source: 'studio_execution_object' } as const;
  const unknown = (reason: string) => ({
    run: { ...runBase, status: 'unknown' as const, reason },
    selection: { ...selectionBase, status: 'unknown' as const, reason },
    generation: { ...generationBase, status: 'unknown' as const, reason },
  });
  if (!turnId) return unknown('turn_not_requested');
  if (['NODE_TYPE_UPLOAD_CARD', 'NODE_TYPE_SECTION'].includes(node.type))
    return unknown('not_a_generated_output');
  if (!current || !validIdentity(current.runId)) return unknown('current_run_identity_incomplete');
  const run = object(reads.find((read) => read.requested_run_id === current.runId)?.response.run);
  const result = identifiedRunStep(run, current, node.id);
  if (!result.step) return unknown(result.reason!);
  if (run.turnId !== turnId) return unknown('run_belongs_to_another_turn');
  const identity = {
    turn_id: turnId,
    run_id: text(run.runId),
    step_id: text(result.step.stepId),
    task_id: text(result.step.taskId),
  };
  const runAttribution: AuditRunAttribution = { ...runBase, ...identity, status: 'verified', reason: null };
  const reason = selectedOutputReason(node, current, outputs);
  if (reason) return { ...unknown(reason), run: runAttribution };
  const selection: AuditSelectionAssociation = {
    ...selectionBase,
    ...identity,
    status: 'verified',
    reason: null,
    asset_id: text(current.selectedAssetId),
  };
  // Ownership of an exact run record does not depend on execution success.
  // Only a successfully completed execution can prove generated output delivery.
  const evidence: Pick<AuditTurnAttribution, 'evidence' | 'reason'> = executionCompleted(
    run,
    current,
    result.step,
  )
    ? generatedObjectEvidence(
        node,
        outputs.find((asset) => asset.assetId === current.selectedAssetId)!,
        result.step,
      )
    : { reason: 'execution_not_completed' };
  return {
    run: runAttribution,
    selection,
    generation: evidence.evidence
      ? { ...selection, ...generationBase, ...evidence }
      : { ...generationBase, status: 'unknown', reason: evidence.reason },
  };
}
