/** 画布模板、输入资产及创作会话的明确契约；创作会话不包含站内消息或账号设置。 */
import { z } from 'zod';
import { id } from '../contracts/primitives.ts';
import type { CanvasSpec } from './canvas.ts';
import { labInputsSchema } from './canvas-lab-inputs.ts';
import { labPlanSchema } from './canvas-lab-plan.ts';
import { textureReferenceSchema } from './canvas-texture-reference.ts';
import { extractionPlanSchema } from './canvas-extraction-plan.ts';
import { answerPlanSchema } from './canvas-answer-plan.ts';
import { turnPlanSchema } from './canvas-turn-plan.ts';
import { turnStopPlanSchema } from './canvas-turn-stop-plan.ts';
const empty = z.object({}).strict();
const node = empty.extend({ nodeId: id });
const session = empty.extend({ sessionId: id });
const turn = empty.extend({ turnId: id });
const template = empty.extend({ id });
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
export const extraCanvasResources: CanvasSpec[] = [
  spec(
    'turn_plan',
    'Session',
    'GetSession',
    turnPlanSchema,
    'Prepare a new Canvas composer message or an exact failed-user-message retry. Preserves attachment markers/order, verifies saved node assets and READY inputs, applies proven saved-copy bindings and checks Unicode/new-composer limits. Does not upload, save, submit or accept variable billing.',
  ),
  spec(
    'turn_stop_plan',
    'Turn',
    'GetTurnDetail',
    turnStopPlanSchema,
    'Prepare the webpage Agent stop sequence for an exact Canvas turn. Read-only: cancel an active turn first, then re-read after CANCELLED before stopping its proven active runs. Reports incomplete discovery and snapshot changes; never treats an empty run list or an accepted stop request as completed cancellation.',
  ),
  spec(
    'answer_plan',
    'Turn',
    'GetTurnDetail',
    answerPlanSchema,
    'Prepare an exact Canvas selection or confirmation card answer, including grouped questions, Other, skip and confirmed parts. Checks turn/session/Canvas and selected node assets; does not submit or accept variable billing. Any answer, including Skip, may continue paid creation; use turn-cancel to cancel.',
  ),
  spec(
    'lab_plan',
    'Lab',
    'ListLabJobs',
    labPlanSchema,
    'Prepare Lab reuse_instructions with all current upstream assets or run_again with an exact historical prompt and original inputs. Does not submit or accept variable billing; pass ready parameters to canvas-lab separately.',
  ),
  spec(
    'extraction_plan',
    'Canvas',
    'GetCanvas',
    extractionPlanSchema,
    'Prepare SemanticSplit detection, auto/manual parts and per-result prompt edits from the saved webpage state. Returns graph-edit actions and separate run parameters; does not save or start a paid run.',
  ),
  spec(
    'texture_reference',
    'Node',
    'GetNodeAssetDetail',
    textureReferenceSchema,
    'Prepare the webpage Texture reference inheritance for a saved node. Returns guarded canvas-edit actions from upstream images or the exact model version; save and run separately.',
  ),
  spec(
    'run_check',
    'Run',
    'CheckRunPreconditions',
    empty.extend({ canvasId: id, nodeIds: z.array(id).min(1).max(100) }),
    'Check the native Canvas run preconditions for selected nodes without creating a run.',
  ),
  spec('access', 'Access', 'GetAccess', empty, 'Check whether the current Studio account has Canvas access.'),
  spec(
    'templates',
    'Template',
    'ListTemplates',
    empty.extend({
      offset: z.number().int().min(0).default(0),
      pageSize: z.number().int().min(1).max(100).default(20),
      scenarioId: id.optional(),
      placement: z.enum(['TEMPLATE_PLACEMENT_HOME', 'TEMPLATE_PLACEMENT_PROJECT']).optional(),
    }),
    'List Canvas templates and their reusable graphs.',
  ),
  spec('template_get', 'Template', 'GetTemplate', template, 'Read one Canvas template graph.'),
  spec(
    'template_create',
    'Template',
    'CreateTemplate',
    empty.extend({
      sourceProjectId: id,
      sourceCanvasId: id,
      scenarioId: id,
      name: z.string().min(1).max(200).optional(),
      revision: z.string().regex(/^\d+$/).optional(),
    }),
    'Snapshot the saved Canvas graph into a reusable template, optionally guarding its revision. On an unknown response, query template-source before retrying; the template may be visible in the catalogue.',
    false,
  ),
  {
    ...spec(
      'template_delete',
      'Template',
      'DeleteTemplate',
      template,
      'Delete an explicitly selected template you own; source projects remain separate.',
      false,
    ),
    destructive: true,
  },
  spec(
    'template_source',
    'Template',
    'GetSourceTemplate',
    empty.extend({ sourceProjectId: id }),
    'Find the template authored from a source Canvas project; template is null when none exists.',
  ),
  spec(
    'template_asset_get',
    'Template',
    'GetTemplateAssetDetail',
    empty.extend({ templateId: id, assetId: id }),
    'Read a model asset embedded in a Canvas template. Image assets may be unavailable through this endpoint.',
  ),
  spec(
    'tools',
    'Tool',
    'ListTools',
    empty,
    'Read live Canvas tools, parameters, ports and capacity, with CLI graph/execution mappings and explicit unmapped or retired nodes. Mapping is not a live execution or output-quality guarantee.',
  ),
  spec(
    'input_assets',
    'Asset',
    'BatchGetInputAssets',
    empty.extend({ projectId: id, assetIds: z.array(id).min(1).max(100) }),
    'Inspect imported Canvas input assets and their readiness.',
  ),
  spec(
    'sessions',
    'Session',
    'ListSessions',
    empty.extend({ canvasId: id }),
    'List creative planning sessions for a Canvas.',
  ),
  spec(
    'session_create',
    'Session',
    'CreateSession',
    empty.extend({ canvasId: id }),
    'Create a new ACTIVE creative session as the project default, archiving the previous session while preserving its history. Reload the project webpage to display it.',
    false,
  ),
  spec('session_get', 'Session', 'GetSession', session, 'Read a creative planning session.'),
  spec(
    'session_mode',
    'Session',
    'UpdateSession',
    session.extend({ mode: z.enum(['MODE_AUTO', 'MODE_CONTROL']) }),
    'Set the creative session mode.',
    false,
  ),
  spec(
    'bind_lab',
    'Session',
    'BindAstraCard',
    empty.extend({ labNodeId: id, messageId: id }),
    'Attach a real Agent Astra/Lab request card to an existing Lab node. Use the card message ID, not an ordinary chat message.',
    false,
  ),
  spec(
    'turns',
    'Session',
    'ListTurns',
    session.extend({
      statuses: z
        .array(
          z.enum([
            'TURN_STATUS_QUEUED',
            'TURN_STATUS_RUNNING',
            'TURN_STATUS_WAITING_FOR_USER',
            'TURN_STATUS_DONE',
            'TURN_STATUS_FAILED',
            'TURN_STATUS_CANCELLED',
          ]),
        )
        .default([
          'TURN_STATUS_QUEUED',
          'TURN_STATUS_RUNNING',
          'TURN_STATUS_WAITING_FOR_USER',
          'TURN_STATUS_DONE',
          'TURN_STATUS_FAILED',
          'TURN_STATUS_CANCELLED',
        ]),
    }),
    'List creative agent turns.',
  ),
  spec('turn_get', 'Turn', 'GetTurnDetail', turn, 'Read the creative agent result or required user choice.'),
  spec(
    'turn_cancel',
    'Turn',
    'CancelTurn',
    turn,
    'Request cancellation of an explicitly selected creative turn. This command sends CancelTurn only; use turn-stop-plan before and after cancellation to identify any still-active owned runs and verify exact final states before sending StopRun.',
    false,
  ),
  spec(
    'lab_inputs',
    'Lab',
    'ListLabJobs',
    labInputsSchema,
    'Resolve a Lab node’s new upstream assets plus explicit attachments, excluding inputs already used in observed Lab history. Returns missing inputs without starting a job.',
  ),
  spec(
    'lab_jobs',
    'Lab',
    'ListLabJobs',
    node.extend({ limit: z.number().int().min(1).max(100).default(20) }),
    'List 3D Lab creative jobs for a node.',
  ),
  spec(
    'lab_job_get',
    'Lab',
    'GetLabJob',
    empty.extend({ jobId: id }),
    'Read a 3D Lab job, artifacts and observed charged credits.',
  ),
  spec(
    'lab_job_cancel',
    'Lab',
    'CancelLabJob',
    empty.extend({ jobId: id }),
    'Cancel an explicitly selected 3D Lab creative job.',
    false,
  ),
  spec(
    'lab_instructions',
    'Lab',
    'GetLabTaskInstructions',
    node,
    'Read server-managed Lab instructions with save-state validation and Copy/Reuse guidance. Does not save or execute instructions.',
  ),
];
