/** Lab 说明状态来自网页读取协议；Copy/Reuse 不代表存在独立的手工保存写接口。 */
import { object, TripoError } from '../contracts/errors.ts';

const statuses = ['IDLE', 'SAVING', 'SAVED', 'FAILED'] as const;
type SaveStatus = (typeof statuses)[number];
interface Issue {
  field: string;
  reason: 'object_required' | 'string_required' | 'boolean_required' | 'unknown_status' | 'invalid_version';
}
interface SavedInstructions {
  nodeId: string | null;
  version: string | null;
  instructions: string | null;
}
export interface LabTaskInstructions {
  state: Record<string, unknown>;
  saved: SavedInstructions | null;
  saveStatus: SaveStatus | null;
  saving: boolean | null;
  canSave: boolean | null;
  hasUpdates: boolean | null;
  valid: boolean;
  issues: Issue[];
  reuseBlockers: string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function status(rawStatus: unknown, issues: Issue[]): SaveStatus | null {
  let saveStatus: SaveStatus | null = null;
  if (typeof rawStatus !== 'string')
    issues.push({ field: 'taskInstructions.saveStatus', reason: 'string_required' });
  else {
    const candidate = rawStatus.replace(/^LAB_TASK_INSTRUCTIONS_SAVE_STATUS_/, '');
    if (statuses.includes(candidate as SaveStatus)) saveStatus = candidate as SaveStatus;
    else issues.push({ field: 'taskInstructions.saveStatus', reason: 'unknown_status' });
  }
  return saveStatus;
}

function boolean(state: Record<string, unknown>, field: string, issues: Issue[]): boolean | null {
  const current = state[field];
  if (current === undefined) return false;
  if (typeof current === 'boolean') return current;
  issues.push({ field: `taskInstructions.${field}`, reason: 'boolean_required' });
  return null;
}

function savedInstructions(raw: unknown, nodeId: string, issues: Issue[]): SavedInstructions | null {
  if (raw === undefined || raw === null) return null;
  if (!record(raw)) {
    issues.push({ field: 'taskInstructions.saved', reason: 'object_required' });
    return null;
  }
  const savedNodeId = typeof raw.nodeId === 'string' && raw.nodeId.trim() ? raw.nodeId : null;
  if (savedNodeId === null)
    issues.push({ field: 'taskInstructions.saved.nodeId', reason: 'string_required' });
  else if (savedNodeId !== nodeId)
    throw new TripoError('CONTRACT_CHANGED', 'Saved Lab instructions belong to another node.');
  const version = raw.version === undefined ? '0' : raw.version;
  const validVersion = typeof version === 'string' && /^\d+$/.test(version);
  if (!validVersion) issues.push({ field: 'taskInstructions.saved.version', reason: 'invalid_version' });
  const instructions = raw.instructions === undefined ? '' : raw.instructions;
  if (typeof instructions !== 'string')
    issues.push({ field: 'taskInstructions.saved.instructions', reason: 'string_required' });
  return {
    nodeId: savedNodeId,
    version: validVersion ? version : null,
    instructions: typeof instructions === 'string' ? instructions : null,
  };
}

function blockers(
  saved: SavedInstructions | null,
  saveStatus: SaveStatus | null,
  saving: boolean | null,
  issues: Issue[],
) {
  const reuseBlockers: string[] = [];
  if (issues.length) reuseBlockers.push('instructions_state_invalid');
  if (!saved?.instructions?.trim()) reuseBlockers.push('saved_instructions_empty');
  if (saved && (saved.nodeId === null || saved.version === null))
    reuseBlockers.push('saved_instructions_identity_missing');
  if (saving === true || saveStatus === 'SAVING') reuseBlockers.push('instructions_saving');
  if (saveStatus === 'FAILED') reuseBlockers.push('instructions_save_failed');
  return reuseBlockers;
}

/**
 * Match the webpage's required fields and omitted defaults without hiding new or malformed states.
 * Read-only inspection reports invalid fields; callers must not prepare an execution from them.
 */
export function parseLabTaskInstructions(value: unknown, nodeId: string): LabTaskInstructions {
  const issues: Issue[] = [];
  const response = object(value),
    state = object(response.taskInstructions);
  if (!record(value)) issues.push({ field: 'response', reason: 'object_required' });
  if (!record(response.taskInstructions))
    issues.push({ field: 'taskInstructions', reason: 'object_required' });
  const saveStatus = status(state.saveStatus, issues),
    saving = boolean(state, 'saving', issues),
    canSave = boolean(state, 'canSave', issues),
    hasUpdates = boolean(state, 'hasUpdates', issues),
    saved = savedInstructions(state.saved, nodeId, issues);
  for (const field of ['saveErrorCode', 'saveErrorMessage'])
    if (state[field] !== undefined && typeof state[field] !== 'string')
      issues.push({ field: `taskInstructions.${field}`, reason: 'string_required' });
  return {
    state,
    saved,
    saveStatus,
    saving,
    canSave,
    hasUpdates,
    valid: !issues.length,
    issues,
    reuseBlockers: blockers(saved, saveStatus, saving, issues),
  };
}

/** Preserve the service payload while making validation and the supported local workflow explicit. */
export function inspectLabTaskInstructions(value: unknown, nodeId: string): Record<string, unknown> {
  const parsed = parseLabTaskInstructions(value, nodeId);
  return {
    ...object(value),
    validation: {
      scope: 'lab_instructions_response',
      valid: parsed.valid,
      save_status: parsed.saveStatus,
      saving: parsed.saving,
      can_save: parsed.canSave,
      has_updates: parsed.hasUpdates,
      saved_node_id: parsed.saved?.nodeId ?? null,
      saved_version: parsed.saved?.version ?? null,
      has_saved_instructions: !!parsed.saved?.instructions?.trim(),
      reuse_blockers: parsed.reuseBlockers,
      issues: parsed.issues,
    },
    cli_support: {
      state_source: 'GetLabTaskInstructions',
      save_control: 'server_managed',
      manual_save: false,
      manual_save_observation: 'No separate manual Save action in the current web client.',
      copy: 'Read taskInstructions.saved.instructions from this response.',
      reuse: 'Prepare canvas lab-plan --mode reuse_instructions before submitting a new Lab job.',
      validation_scope: 'instruction_state_only; graph inputs and active jobs require lab-plan',
    },
  };
}
