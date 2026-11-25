/** Import a saved Canvas response without inventing its identity, revision or graph contents. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canvasSaveSchema } from '../../studio/api/canvas.ts';
import { canvasGraphIssues } from '../../studio/api/canvas-graph.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

const snapshotSchema = z
  .object({ nodes: canvasSaveSchema.shape.nodes, edges: canvasSaveSchema.shape.edges })
  .strict()
  .superRefine((snapshot, ctx) => {
    for (const message of canvasGraphIssues(snapshot.nodes, snapshot.edges, false))
      ctx.addIssue({ code: 'custom', message });
  });
export type CanvasEditSnapshot = z.infer<typeof snapshotSchema>;
const stateSchema = z
  .object({
    kind: z.literal('ai-modeling.canvas.graph'),
    version: z.literal(1),
    source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    graph: canvasSaveSchema,
    undo: z.array(snapshotSchema).max(100),
    redo: z.array(snapshotSchema).max(100),
  })
  .strict()
  .refine((state) => state.undo.length + state.redo.length <= 100, {
    message: 'Canvas edit history must contain at most 100 total undo and redo snapshots.',
  });
export type CanvasEditState = z.infer<typeof stateSchema>;

/** Zod records deliberately omit __proto__; reject it before parsing rather than silently changing saved JSON. */
export function hasReservedCanvasKey(value: unknown): boolean {
  const pending: unknown[] = [value],
    seen = new WeakSet<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Object.hasOwn(current, '__proto__')) return true;
    for (const child of Object.values(current)) if (child && typeof child === 'object') pending.push(child);
  }
  return false;
}
export const reservedCanvasKeyMessage = 'Canvas JSON cannot contain the reserved __proto__ object key.';

export const canvasEditExpected = {
  expected_canvas_id: canvasSaveSchema.shape.canvasId
    .optional()
    .describe('Require this exact Canvas identity in the input file; does not replace it.'),
  expected_project_id: canvasSaveSchema.shape.projectId.describe(
    'Require this exact project identity in the input file; does not replace it.',
  ),
  expected_revision: canvasSaveSchema.shape.revision
    .optional()
    .describe(
      'Require this exact saved revision in the input file; does not fetch or overwrite a newer one.',
    ),
};
const expectedSchema = z.object(canvasEditExpected).strict();
const responseSchema = z
  .object({
    canvas: z
      .object({
        canvasId: canvasSaveSchema.shape.canvasId,
        projectId: canvasSaveSchema.shape.projectId.unwrap(),
        revision: canvasSaveSchema.shape.revision,
      })
      .passthrough(),
    nodes: canvasSaveSchema.shape.nodes,
    edges: canvasSaveSchema.shape.edges,
  })
  .passthrough();
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TripoError('INVALID_INPUT', 'Canvas graph input must be a JSON object.');
  return value as Record<string, unknown>;
};

/** Only the CLI's documented {result: ...} wrapper is unwrapped; errors and ambiguous mixtures fail. */
export function readCanvasEditState(
  value: unknown,
  sourceSha256: string,
  expected: z.infer<typeof expectedSchema> = {},
) {
  if (hasReservedCanvasKey(value)) throw new TripoError('INVALID_INPUT', reservedCanvasKeyMessage);
  let input = record(value);
  const envelope = Object.hasOwn(input, 'result');
  if (envelope) {
    input = record(z.object({ result: z.unknown() }).strict().parse(input).result);
  }
  if (Object.hasOwn(input, 'error') || input.isError === true)
    throw new TripoError('INVALID_INPUT', 'An error response is not a saved Canvas graph.');
  let state: CanvasEditState;
  let sourceFormat: 'edit_state' | 'save_input' | 'canvas_response';
  if (Object.hasOwn(input, 'kind')) {
    state = stateSchema.parse(input);
    sourceFormat = 'edit_state';
  } else {
    sourceFormat = Object.hasOwn(input, 'canvas') ? 'canvas_response' : 'save_input';
    let graph;
    if (sourceFormat === 'canvas_response') {
      const response = responseSchema.parse(input);
      for (const key of ['canvasId', 'projectId', 'revision', 'clientId'])
        if (Object.hasOwn(input, key))
          throw new TripoError(
            'INVALID_INPUT',
            'Canvas response and SaveCanvas input fields cannot be combined.',
          );
      graph = canvasSaveSchema.parse({
        canvasId: response.canvas.canvasId,
        projectId: response.canvas.projectId,
        revision: response.canvas.revision,
        clientId: randomUUID(),
        nodes: response.nodes,
        edges: response.edges,
      });
    } else graph = canvasSaveSchema.parse(input);
    state = stateSchema.parse({
      kind: 'ai-modeling.canvas.graph',
      version: 1,
      source_sha256: sourceSha256,
      graph,
      undo: [],
      redo: [],
    });
  }
  const checks = expectedSchema.parse(expected);
  for (const [expectedKey, graphKey] of [
    ['expected_canvas_id', 'canvasId'],
    ['expected_project_id', 'projectId'],
    ['expected_revision', 'revision'],
  ] as const) {
    if (checks[expectedKey] !== undefined && checks[expectedKey] !== state.graph[graphKey])
      throw new TripoError(
        'CANVAS_CHANGED',
        `Canvas graph input does not match ${expectedKey}. Read and select the intended saved graph.`,
      );
  }
  return { state, source_format: sourceFormat, input_envelope: envelope ? 'cli_result' : 'none' };
}
