/** Read a stable Canvas/Agent snapshot for acceptance; never submit, select or approve a result. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id } from '../contracts/primitives.ts';
import { array, object, sanitize, text, TripoError } from '../contracts/errors.ts';
import type { StudioClient } from './client.ts';
import { CanvasClient, bindCanvasAccount } from './canvas-client.ts';
import { canvasStateFingerprint } from './canvas-state.ts';
import { canvasGraphIssues } from './canvas-graph.ts';
import { isAvailableCanvasOutput } from './canvas-turn-assets.ts';
import { canvasArtifactSuffix } from './canvas-artifact.ts';
import {
  auditNodeAttribution,
  readAuditRuns,
  type AuditRunRead,
  type AuditRunAttribution,
} from './canvas-audit-attribution.ts';

const ids = z
  .array(id)
  .min(1)
  .max(100)
  .refine((x) => new Set(x).size === x.length, 'IDs must be unique.');
export const canvasAuditSchema = z
  .object({
    canvasId: id,
    sessionId: id.optional(),
    turnId: id.optional(),
    nodeIds: ids
      .optional()
      .describe('Exact nodes to inspect; omitted means the whole saved graph, up to 100 nodes.'),
    expect: z
      .array(
        z
          .object({
            nodeId: id,
            kind: z
              .enum(['image', 'model', 'animation', 'html'])
              .optional()
              .describe(
                'HTML identifies a current HolyMolly URL-path or filename candidate; it does not verify bytes or gameplay.',
              ),
            minAssets: z.number().int().min(1).max(100).default(1),
            assetIds: ids.optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
type Input = z.infer<typeof canvasAuditSchema>;
type RecordValue = Record<string, unknown>;
interface Issue {
  code: string;
  node_id?: string;
  message: string;
}
interface Node {
  id: string;
  type: string;
  pid?: string;
  params?: RecordValue | null;
  inputMount?: unknown[];
  nodeAssets?: unknown[];
}
interface Edge {
  id: string;
  source: { nodeId: string; port: string };
  target: { nodeId: string; port: string };
}
interface Graph {
  canvas: RecordValue;
  nodes: Node[];
  edges: Edge[];
  nodeRuns: RecordValue[];
}
interface Asset {
  asset_id: string;
  kind: string | null;
  status: string | null;
  studio_state: string | null;
  role: string | null;
  selected: boolean;
  available: boolean;
  ready: boolean | null;
  input_metadata_scope?: 'current_project' | 'not_in_current_project';
  source: 'canvas_input' | 'canvas_node';
  filename?: string | null;
  html_candidate?: boolean;
}
const holyMollyType = 'NODE_TYPE_HOLY_MOLLY';
const call = (client: CanvasClient, service: string, method: string, body: RecordValue) =>
  client.call(`/tripo.canvas.api.agent.${service}Service/${method}`, body).then(object);
function contract(message: string): never {
  throw new TripoError('CONTRACT_CHANGED', message);
}
function list(value: unknown, message: string): RecordValue[] {
  if (!Array.isArray(value) || value.some((x) => !x || typeof x !== 'object' || Array.isArray(x)))
    contract(message);
  return value as RecordValue[];
}
function unique(values: RecordValue[], field: string, label: string): void {
  const keys = values.map((x) => x[field]);
  if (keys.some((x) => !id.safeParse(x).success) || new Set(keys).size !== keys.length)
    contract(`${label} identities are missing or duplicated.`);
}
function graphContext(value: RecordValue, input: Input): Graph {
  const canvas = object(value.canvas);
  if (
    canvas.canvasId !== input.canvasId ||
    !id.safeParse(canvas.projectId).success ||
    !/^\d+$/.test(text(canvas.revision))
  )
    contract('Audit Canvas identity or revision is unavailable.');
  const nodes = list(value.nodes, 'Audit Canvas nodes are unavailable.'),
    edges = list(value.edges, 'Audit Canvas edges are unavailable.'),
    nodeRuns =
      value.nodeRuns === undefined ? [] : list(value.nodeRuns, 'Audit Canvas node runs are unavailable.');
  unique(nodes, 'id', 'Canvas node');
  unique(edges, 'id', 'Canvas edge');
  unique(nodeRuns, 'nodeId', 'Canvas node run');
  if (nodes.some((node) => !text(node.type) || (node.pid !== undefined && typeof node.pid !== 'string')))
    contract('Canvas node type or parent is invalid.');
  for (const edge of edges) {
    const source = object(edge.source),
      target = object(edge.target);
    if (
      !id.safeParse(source.nodeId).success ||
      !id.safeParse(target.nodeId).success ||
      (source.port !== undefined && typeof source.port !== 'string') ||
      (target.port !== undefined && typeof target.port !== 'string')
    )
      contract('Canvas edge endpoints are incomplete.');
    source.port ??= '';
    target.port ??= '';
  }
  const known = new Set(nodes.map((node) => node.id));
  if (nodeRuns.some((run) => !known.has(run.nodeId))) contract('Canvas returned a run for an unknown node.');
  return { canvas, nodes: nodes as unknown as Node[], edges: edges as unknown as Edge[], nodeRuns };
}
function selectedNodes(graph: Graph, input: Input): Node[] {
  if (!input.nodeIds && graph.nodes.length > 100)
    throw new TripoError(
      'AUDIT_SCOPE_REQUIRED',
      'Select at most 100 exact nodeIds to audit a larger Canvas.',
    );
  const requested = input.nodeIds ?? graph.nodes.map((node) => node.id);
  const selected = requested.map((nodeId) => {
    const node = graph.nodes.find((entry) => entry.id === nodeId);
    if (!node) throw new TripoError('CANVAS_CHANGED', 'An explicitly selected audit node is absent.');
    return node;
  });
  if (input.expect.some((expect) => !requested.includes(expect.nodeId)))
    throw new TripoError('INVALID_INPUT', 'Every expectation must name a node in the selected audit scope.');
  return selected;
}
function turnContext(value: RecordValue, turnId: string): RecordValue {
  const turn = object(value.turn);
  if (turn.turnId !== turnId || !id.safeParse(turn.sessionId).success || !Array.isArray(value.messages))
    contract('Audit turn identity or messages are unavailable.');
  const messages = list(value.messages, 'Audit turn messages are unavailable.');
  unique(messages, 'messageId', 'Turn message');
  if (messages.some((message) => message.turnId !== turnId))
    contract('Audit turn contains another turn’s messages.');
  return value;
}
function sessionContext(value: RecordValue, sessionId: string, canvasId: string): RecordValue {
  const session = object(value.session);
  if (session.sessionId !== sessionId || session.canvasId !== canvasId)
    contract('The audit session does not belong to the requested Canvas.');
  return { sessionId, canvasId, status: session.status, activeTurnId: session.activeTurnId ?? '' };
}
function mounts(node: Node): RecordValue[] {
  const values =
    node.inputMount === undefined ? [] : list(node.inputMount, 'Canvas input mounts are invalid.');
  unique(values, 'assetId', 'Canvas input mount');
  return values;
}
async function readAssets(client: CanvasClient, graph: Graph, nodes: Node[]) {
  const generated = nodes.filter(
    (node) => !['NODE_TYPE_UPLOAD_CARD', 'NODE_TYPE_SECTION'].includes(node.type),
  );
  const result = generated.length
    ? await call(client, 'Node', 'ListNodesAssets', { nodeIds: generated.map((node) => node.id) })
    : { nodes: [] };
  const outputs = list(result.nodes, 'Canvas output asset list is unavailable.');
  unique(outputs, 'nodeId', 'Canvas output node');
  let count = 0;
  for (const output of outputs) {
    if (!generated.some((node) => node.id === output.nodeId))
      contract('Canvas returned an unrequested output node.');
    const assets = list(output.assets, 'Canvas node assets are unavailable.');
    unique(assets, 'assetId', 'Canvas output asset');
    if (assets.some((asset) => asset.nodeId !== output.nodeId))
      contract('Canvas output asset belongs to another node.');
    count += assets.length;
  }
  const inputIds = [
    ...new Set(
      nodes
        .filter((node) => node.type === 'NODE_TYPE_UPLOAD_CARD')
        .flatMap((node) => mounts(node).map((mount) => text(mount.assetId))),
    ),
  ];
  if (count + inputIds.length > 1000)
    throw new TripoError(
      'AUDIT_SCOPE_REQUIRED',
      'Select fewer nodes; an audit reads at most 1000 asset identities.',
    );
  const inputs: RecordValue[] = [];
  for (let offset = 0; offset < inputIds.length; offset += 100) {
    const assetIds = inputIds.slice(offset, offset + 100);
    const response = await call(client, 'Asset', 'BatchGetInputAssets', {
      projectId: graph.canvas.projectId,
      assetIds,
    });
    const batch = list(response.assets, 'Canvas input asset metadata is unavailable.');
    unique(batch, 'assetId', 'Canvas input asset');
    if (batch.some((asset) => !assetIds.includes(text(asset.assetId))))
      contract('Canvas returned unrequested input metadata.');
    inputs.push(...batch);
  }
  return { inputs, outputs };
}
function kind(value: unknown): string | null {
  const name = text(value)
    .replace(/^ASSET_KIND_/, '')
    .toLowerCase();
  if (['image', 'model', 'animation', 'video'].includes(name)) return name;
  if (name.startsWith('image/')) return 'image';
  if (name.startsWith('model/')) return 'model';
  return null;
}
function publicAsset(asset: RecordValue, source: Asset['source'], selected: boolean): Asset {
  const ready =
    source === 'canvas_input'
      ? asset.status === null
        ? null
        : asset.status === 'INPUT_ASSET_STATUS_READY'
      : isAvailableCanvasOutput(asset);
  return {
    asset_id: text(asset.assetId),
    kind: kind(asset.kind),
    status: text(asset.status) || null,
    studio_state: text(asset.studioState) || null,
    role: text(asset.role) || null,
    source,
    selected,
    ready,
    available: Boolean(text(asset.url)) && ready !== false,
  };
}
function holyHtmlCandidate(asset: RecordValue): boolean {
  const url = text(asset.url);
  try {
    if (url && !['http:', 'https:'].includes(new URL(url).protocol)) return false;
    return ['html', 'htm'].includes(canvasArtifactSuffix(url || undefined, text(asset.filename)));
  } catch {
    return false;
  }
}
function holyHtmlCandidates(assets: RecordValue[]): Set<string> {
  // Follow the download classifier: CURRENT outputs, then URL path suffix before filename.
  const current = assets.filter((asset) => asset.role === 'ASSET_ROLE_CURRENT');
  return new Set(
    (current.length ? current : assets)
      .filter(
        (asset) =>
          [undefined, null, '', 'ASSET_ROLE_CURRENT', 'ASSET_ROLE_UNSPECIFIED'].some(
            (role) => role === asset.role,
          ) && holyHtmlCandidate(asset),
      )
      .map((asset) => text(asset.assetId)),
  );
}
function gameCredits(nodeId: string, run: RecordValue | undefined, attribution: AuditRunAttribution) {
  const credits = object(run?.credits);
  const status = text(credits.status);
  const points =
    typeof credits.points === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(credits.points)
      ? credits.points
      : null;
  const recognized = ['SETTLED', 'PENDING', 'REVERSED', 'UNKNOWN'].some(
    (value) => status === `NODE_CREDITS_STATUS_${value}`,
  );
  const valid = recognized && (status !== 'NODE_CREDITS_STATUS_SETTLED' || points !== null);
  return {
    source: 'canvas_node_run',
    node_id: nodeId,
    run_id: text(run?.runId) || null,
    status: valid ? status : null,
    points:
      valid && ['NODE_CREDITS_STATUS_SETTLED', 'NODE_CREDITS_STATUS_PENDING'].includes(status)
        ? points
        : null,
    contract_valid: run?.credits === undefined ? null : valid,
    turn_attribution: valid ? attribution.status : 'unknown',
    attribution_scope: 'node_run_record',
    ledger_attribution: 'not_checked',
  };
}
function diagnosticGameUrl(value: unknown): string | null {
  const candidate = text(value).trim();
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    // Canonicalize before redaction: WHATWG also accepts a single slash or backslashes.
    // These URLs are diagnostics, not usable navigation links.
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}
function gameReport(
  node: Node,
  values: Asset[],
  run: RecordValue | undefined,
  attribution: AuditRunAttribution,
) {
  const params = object(node.params),
    entry = diagnosticGameUrl(params.entry_url),
    cover = diagnosticGameUrl(params.cover_url),
    html = values.filter((asset) => asset.html_candidate),
    available = html.filter((asset) => asset.available),
    selected = html.filter((asset) => asset.selected);
  return {
    kind: 'holy_molly',
    phase: text(params.hm_phase) || null,
    phase_source: 'saved_node_params',
    retryable: typeof params.retryable === 'boolean' ? params.retryable : null,
    preview: {
      entry_url_present: Boolean(text(params.entry_url).trim()),
      entry_url: entry,
      entry_url_https: entry ? new URL(entry).protocol === 'https:' : false,
      cover_url_present: Boolean(text(params.cover_url).trim()),
      cover_url: cover,
      url_scope: 'diagnostic_only_incomplete_navigation',
      navigation_verified: false,
    },
    html: {
      candidate_asset_ids: html.map((asset) => asset.asset_id),
      available_asset_ids: available.map((asset) => asset.asset_id),
      selected_asset_id: selected.length === 1 ? selected[0]!.asset_id : null,
      selection:
        selected.length > 1
          ? 'ambiguous'
          : selected.length
            ? selected[0]!.available
              ? 'selected'
              : 'selected_unavailable'
            : available.length
              ? 'requires_selection'
              : 'unavailable',
      kind_evidence: 'url_path_extension_then_filename',
      bytes_verified: false,
      dependencies_verified: false,
    },
    credits: gameCredits(node.id, run, attribution),
    playability_verified: false,
  };
}
function artifactReadiness(assets: Asset[]): boolean | null {
  if (assets.some((asset) => asset.available && asset.ready === true)) return true;
  return assets.some((asset) => asset.available && asset.ready === null) ? null : false;
}
function nodeReport(
  node: Node,
  graph: Graph,
  assets: Awaited<ReturnType<typeof readAssets>>,
  issues: Issue[],
  turnId: string | undefined,
  runs: AuditRunRead[],
) {
  const run = graph.nodeRuns.find((entry) => entry.nodeId === node.id);
  const selectedId = text(run?.selectedAssetId);
  const outputs = array(assets.outputs.find((entry) => entry.nodeId === node.id)?.assets).map(object);
  const attribution = auditNodeAttribution(turnId, node, run, outputs, runs);
  let values: Asset[];
  if (node.type === 'NODE_TYPE_UPLOAD_CARD') {
    values = mounts(node).map((mount) => {
      const metadata = assets.inputs.find((asset) => asset.assetId === mount.assetId);
      return {
        ...publicAsset(
          { ...mount, ...metadata, status: metadata?.status ?? null, url: mount.url },
          'canvas_input',
          true,
        ),
        input_metadata_scope: metadata ? ('current_project' as const) : ('not_in_current_project' as const),
      };
    });
  } else {
    const html = node.type === holyMollyType ? holyHtmlCandidates(outputs) : null;
    values = outputs.map((asset) => {
      const report = publicAsset(
        asset,
        'canvas_node',
        selectedId ? asset.assetId === selectedId : asset.selected === true,
      );
      return html
        ? {
            ...report,
            kind: html.has(text(asset.assetId)) ? 'html' : report.kind,
            filename: text(asset.filename) || null,
            html_candidate: html.has(text(asset.assetId)),
          }
        : report;
    });
    const selectedFlags = array(assets.outputs.find((entry) => entry.nodeId === node.id)?.assets)
      .map(object)
      .filter((asset) => asset.selected === true);
    if (
      selectedFlags.length > 1 ||
      (selectedId && selectedFlags.some((asset) => asset.assetId !== selectedId))
    )
      issues.push({
        code: 'ambiguous_selected_asset',
        node_id: node.id,
        message: 'Selected asset identities disagree; no latest-result substitution is allowed.',
      });
    if (selectedId && !values.some((asset) => asset.asset_id === selectedId))
      issues.push({
        code: 'selected_asset_missing',
        node_id: node.id,
        message: 'The exact selected asset is absent from this node.',
      });
  }
  const status = text(run?.status) || null;
  addNodeIssues(status, node, values, issues);
  const artifacts = node.type === holyMollyType ? values.filter((asset) => asset.html_candidate) : values;
  return {
    node_id: node.id,
    type: node.type,
    status,
    run_id: text(run?.runId) || null,
    step_id: text(run?.currentStepId) || null,
    selected_asset_id: selectedId || null,
    run_attribution: attribution.run,
    current_selection_association: attribution.selection,
    turn_attribution: attribution.generation,
    assets: values,
    ...(node.type === holyMollyType ? { game: gameReport(node, values, run, attribution.run) } : {}),
    artifact_ready: artifactReadiness(artifacts),
    bytes_verified: false,
  };
}
function addNodeIssues(status: string | null, node: Node, values: Asset[], issues: Issue[]) {
  if (status && /(?:FAILED|CANCELLED|CANCELED|ERROR|STOPPED)$/.test(status))
    issues.push({
      code: 'node_failed',
      node_id: node.id,
      message: 'The node has a failed, cancelled or stopped execution.',
    });
  if (
    status &&
    !done(status) &&
    !running(status) &&
    !/(?:FAILED|CANCELLED|CANCELED|ERROR|STOPPED)$/.test(status)
  )
    issues.push({
      code: 'unknown_node_status',
      node_id: node.id,
      message: 'The node execution status is unrecognized; completion cannot be confirmed.',
    });
  if (values.some((asset) => asset.selected && !asset.available))
    issues.push({
      code: 'selected_asset_unavailable',
      node_id: node.id,
      message: 'The exact selected/input asset is not ready for original-file retrieval.',
    });
}
const running = (status: unknown) => /(?:QUEUED|RUNNING|PENDING|PROCESSING)$/.test(text(status));
const done = (status: unknown) => ['NODE_STATUS_DONE', 'NODE_STATUS_SUCCEEDED'].includes(text(status));

export async function auditCanvas(studio: StudioClient, requested: unknown): Promise<unknown> {
  const input = canvasAuditSchema.parse(requested);
  studio = bindCanvasAccount(studio);
  const client = new CanvasClient(studio);
  const readTurn = () =>
    input.turnId
      ? call(client, 'Turn', 'GetTurnDetail', { turnId: input.turnId }).then((value) =>
          turnContext(value, input.turnId!),
        )
      : Promise.resolve(null);
  const firstTurn = await readTurn();
  const turn = object(firstTurn?.turn),
    sessionId = input.sessionId ?? text(turn.sessionId);
  if (input.sessionId && input.turnId && turn.sessionId !== input.sessionId)
    contract('The requested turn belongs to a different session.');
  const readSession = () =>
    sessionId
      ? call(client, 'Session', 'GetSession', { sessionId }).then((value) =>
          sessionContext(value, sessionId, input.canvasId),
        )
      : Promise.resolve(null);
  const readGraph = () =>
    call(client, 'Canvas', 'GetCanvas', { canvasId: input.canvasId }).then((value) =>
      graphContext(value, input),
    );
  const session = await readSession(),
    graph = await readGraph(),
    nodes = selectedNodes(graph, input);
  const assets = await readAssets(client, graph, nodes);
  const runs = await readAuditRuns(client, input.canvasId, input.turnId, nodes, graph.nodeRuns);
  const initial = canvasStateFingerprint({ graph, assets, runs, session, turn: firstTurn });
  const finalGraph = await readGraph(),
    finalNodes = selectedNodes(finalGraph, input);
  const finalAssets = await readAssets(client, finalGraph, finalNodes);
  const finalRuns = await readAuditRuns(
    client,
    input.canvasId,
    input.turnId,
    finalNodes,
    finalGraph.nodeRuns,
  );
  const finalSession = await readSession(),
    finalTurn = await readTurn();
  if (
    initial !==
    canvasStateFingerprint({
      graph: finalGraph,
      assets: finalAssets,
      runs: finalRuns,
      session: finalSession,
      turn: finalTurn,
    })
  )
    throw new TripoError(
      'CANVAS_CHANGED',
      'Canvas, run, session, turn or asset state changed during the audit; inspect a fresh snapshot.',
    );
  studio.credentials.load();
  return auditReport(input, graph, nodes, assets, session, turn, runs, initial);
}

function expectationResults(input: Input, reports: ReturnType<typeof nodeReport>[], issues: Issue[]) {
  return input.expect.map((expect) => {
    const node = reports.find((report) => report.node_id === expect.nodeId)!;
    const candidates = node.assets.filter(
      (asset) =>
        asset.available &&
        asset.role !== 'ASSET_ROLE_SUPERSEDED' &&
        (!expect.kind || asset.kind === expect.kind) &&
        (!expect.assetIds || expect.assetIds.includes(asset.asset_id)),
    );
    const missing = (expect.assetIds ?? []).filter(
      (assetId) => !candidates.some((asset) => asset.asset_id === assetId),
    );
    const known = candidates.filter((asset) => asset.ready === true);
    const met =
      candidates.length < expect.minAssets || missing.length
        ? false
        : known.length >= expect.minAssets &&
            (expect.assetIds ?? []).every((assetId) => known.some((asset) => asset.asset_id === assetId))
          ? true
          : null;
    if (met === false)
      issues.push({
        code: 'expected_artifact_unavailable',
        node_id: expect.nodeId,
        message: 'The exact expected output kind, identities or minimum count is unavailable.',
      });
    return {
      node_id: expect.nodeId,
      kind: expect.kind ?? null,
      min_assets: expect.minAssets,
      asset_ids: expect.assetIds ?? null,
      available_asset_ids: candidates.map((asset) => asset.asset_id),
      missing_asset_ids: missing,
      unverified_asset_ids: candidates.filter((asset) => asset.ready === null).map((asset) => asset.asset_id),
      met,
    };
  });
}

function combinedReadiness(states: (boolean | null)[]): boolean | null {
  if (!states.length || states.some((state) => state === null)) return states.includes(false) ? false : null;
  return states.every(Boolean);
}

function attributedScope(input: Input, reports: ReturnType<typeof nodeReport>[]): 'verified' | 'unknown' {
  const outputs = reports.filter((node) => node.type !== 'NODE_TYPE_SECTION');
  if (!outputs.length || outputs.some((node) => node.turn_attribution.status !== 'verified'))
    return 'unknown';
  return input.expect.every((expect) => {
    const node = outputs.find((node) => node.node_id === expect.nodeId);
    return (
      node &&
      expect.minAssets === 1 &&
      (expect.assetIds ?? []).every((assetId) => assetId === node.turn_attribution.asset_id)
    );
  })
    ? 'verified'
    : 'unknown';
}

function downloadActions(input: Input, reports: ReturnType<typeof nodeReport>[]): RecordValue[] {
  return reports.flatMap((node): RecordValue[] => {
    const available = node.assets.filter(
      (asset) => asset.available && asset.role !== 'ASSET_ROLE_SUPERSEDED',
    );
    const exact = new Set(
      input.expect
        .filter((expect) => expect.nodeId === node.node_id)
        .flatMap((expect) => expect.assetIds ?? []),
    );
    const relevant = node.game && !exact.size ? available.filter((asset) => asset.html_candidate) : available;
    const candidates = exact.size
      ? relevant.filter((asset) => exact.has(asset.asset_id))
      : relevant.filter((asset) => asset.selected);
    if (!exact.size && relevant.length && (!candidates.length || (node.game && candidates.length > 1)))
      return [
        {
          command: 'canvas node-assets',
          tool: 'ai_modeling_canvas_node_assets',
          parameters: { nodeIds: [node.node_id] },
          required_arguments: [],
          selection: 'requires_selection',
          candidate_asset_ids: relevant.map((asset) => asset.asset_id),
          purpose: 'Select an exact result identity for acceptance; no asset was selected automatically.',
        },
      ];
    return candidates.map((asset) => ({
      command: 'studio asset-download',
      tool: 'ai_modeling_asset_download',
      parameters: {
        kind: asset.source,
        id: asset.asset_id,
        node_id: node.node_id,
        ...(asset.source === 'canvas_input' ? { canvas_id: input.canvasId } : {}),
      },
      required_arguments: ['destination_path'],
      selection: exact.size ? 'explicit_expectation' : 'selected',
      purpose: asset.html_candidate
        ? 'Retrieve this exact HTML file without executing it. Download does not verify dependencies or gameplay.'
        : 'Retrieve these exact original bytes for content and visual verification.',
    }));
  });
}

function addTurnIssues(
  input: Input,
  session: RecordValue | null,
  turnStatus: string | null,
  issues: Issue[],
) {
  if (
    turnStatus &&
    ![
      'TURN_STATUS_DONE',
      'TURN_STATUS_QUEUED',
      'TURN_STATUS_RUNNING',
      'TURN_STATUS_WAITING_FOR_USER',
      'TURN_STATUS_FAILED',
      'TURN_STATUS_CANCELLED',
    ].includes(turnStatus)
  )
    issues.push({ code: 'unknown_turn_status', message: 'The turn status is not in the verified contract.' });
  if (['TURN_STATUS_FAILED', 'TURN_STATUS_CANCELLED'].includes(turnStatus ?? ''))
    issues.push({ code: 'turn_failed', message: 'The selected Agent turn did not complete successfully.' });
  if (session && text(session.activeTurnId) && session.activeTurnId !== input.turnId)
    issues.push({
      code: 'another_turn_active',
      message:
        'Another turn is active in this session; the graph is not a final result of the selected turn.',
    });
}

function auditReport(
  input: Input,
  graph: Graph,
  nodes: Node[],
  assets: Awaited<ReturnType<typeof readAssets>>,
  session: RecordValue | null,
  turn: RecordValue,
  runs: AuditRunRead[],
  initial: string,
) {
  const issues: Issue[] = canvasGraphIssues(graph.nodes, graph.edges, false).map((message) => ({
    code: 'invalid_graph',
    message,
  }));
  const reports = nodes.map((node) => nodeReport(node, graph, assets, issues, input.turnId, runs));
  const attribution = attributedScope(input, reports);
  const expectations = expectationResults(input, reports, issues);
  const turnStatus = text(turn.status) || null;
  addTurnIssues(input, session, turnStatus, issues);
  const executions = reports.filter(
    (node) => !['NODE_TYPE_UPLOAD_CARD', 'NODE_TYPE_SECTION'].includes(node.type),
  );
  const executionComplete =
    executions.length && executions.every((node) => node.status !== null)
      ? executions.every((node) => done(node.status))
      : null;
  const status =
    turnStatus === 'TURN_STATUS_WAITING_FOR_USER'
      ? 'waiting_input'
      : running(turnStatus) || reports.some((node) => running(node.status))
        ? 'running'
        : issues.length
          ? 'blocked'
          : 'needs_review';
  const downloads = downloadActions(input, reports);
  return sanitize({
    snapshot: {
      canvas_id: input.canvasId,
      project_id: graph.canvas.projectId,
      revision: graph.canvas.revision,
      fingerprint: createHash('sha256').update(initial).digest('hex'),
      stable: true,
      atomic: false,
    },
    scope: {
      kind: input.nodeIds ? 'selected_nodes' : 'saved_canvas',
      node_ids: nodes.map((node) => node.id),
      turn_artifact_attribution: attribution,
      turn_artifact_attribution_scope: 'selected_generated_outputs',
      history_completeness: 'not_checked',
    },
    session,
    turn: input.turnId
      ? {
          turn_id: input.turnId,
          session_id: text(session?.sessionId),
          status: turnStatus,
          complete: turnStatus === 'TURN_STATUS_DONE',
        }
      : null,
    execution: { complete: executionComplete },
    nodes: reports,
    artifact_ready: combinedReadiness(expectations.map((expect) => expect.met)),
    expectations,
    issues,
    next_actions: [
      ...(input.turnId && ['running', 'waiting_input'].includes(status)
        ? [
            {
              command: 'canvas turn-get',
              tool: 'ai_modeling_canvas_turn_get',
              parameters: { turnId: input.turnId },
              required_arguments: [],
              purpose: 'Read this exact turn and any outstanding answer card.',
            },
          ]
        : []),
      ...downloads,
    ],
    acceptance: {
      status,
      requirements_met: null,
      expectations_defined: expectations.length > 0,
      bytes_verified: false,
      visual_review: 'required',
      ...(reports.some((node) => node.game)
        ? { gameplay_review: 'required', playability_verified: false }
        : {}),
      reasons: [
        attribution === 'verified'
          ? 'Only the selected outputs bound to the exact execution in a verified Studio object namespace are attributed; other assets and content requirements are not verified.'
          : 'A current selection or run identity alone does not prove which turn generated an asset.',
        'Remote readiness does not verify file bytes or user-requested appearance.',
        ...(reports.some((node) => node.game)
          ? [
              'HTML availability, a preview URL and a completed node do not verify game loading, dependencies, controls or the requested gameplay.',
            ]
          : []),
        ...(expectations.length ? [] : ['No explicit output expectations were supplied.']),
      ],
    },
  });
}
