/** Live-directory drift must remain visible without pretending a new node has a verified execution chain. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasToolCoverage } from '../studio/api/canvas-capabilities.ts';
import { canvasNode, canvasSaveSchema } from '../studio/api/canvas.ts';
import { canvasNodeQuote } from '../studio/api/canvas-pricing.ts';
import { canvasGraphIssues } from '../studio/api/canvas-graph.ts';

test('Canvas directory reports new, retired, structural and mapped nodes separately', () => {
  const coverage = canvasToolCoverage(
    {
      registryVersion: 'test-registry',
      nodeDefinitionsVersion: 'test-nodes',
      maxCanvasNodes: 200,
      tools: [
        { nodeType: 'NODE_TYPE_GENERATE_IMAGE' },
        { nodeType: 'NODE_TYPE_HOLY_MOLLY' },
        { nodeType: 'NODE_TYPE_EXPORT_MODEL' },
        { nodeType: 'NODE_TYPE_NEW_TOOL' },
      ],
      nodeDefinitions: [
        { nodeType: 'NODE_TYPE_GENERATE_IMAGE', kind: 'NODE_KIND_TOOL', userCreatable: true, retired: false },
        { nodeType: 'NODE_TYPE_HOLY_MOLLY', kind: 'NODE_KIND_TOOL', userCreatable: true, retired: false },
        { nodeType: 'NODE_TYPE_AI_3D_LAB', kind: 'NODE_KIND_OTHER', userCreatable: true, retired: false },
        { nodeType: 'NODE_TYPE_SECTION', kind: 'NODE_KIND_CONTAINER', userCreatable: true, retired: false },
        { nodeType: 'NODE_TYPE_EXPORT_MODEL', kind: 'NODE_KIND_TOOL', userCreatable: false, retired: true },
      ].map((definition) => ({
        ...definition,
        inputPorts: [],
        outputPorts: [],
        systemDownstreamNodeTypes: [],
        userDownstreamNodeTypes: [],
      })),
    },
    canvasNode.shape.type.options,
  );
  assert.equal(coverage.max_canvas_nodes, 200);
  assert.equal(coverage.directory_status, 'incomplete');
  const byType = Object.fromEntries(coverage.nodes.map((node) => [node.node_type, node]));
  assert.equal(byType.NODE_TYPE_GENERATE_IMAGE!.execution_command, 'ai-modeling studio canvas-run');
  assert.equal(byType.NODE_TYPE_AI_3D_LAB!.execution_command, 'ai-modeling studio canvas-lab');
  assert.equal(byType.NODE_TYPE_SECTION!.execution, 'not_applicable');
  assert.equal(byType.NODE_TYPE_HOLY_MOLLY!.graph_edit, true);
  assert.equal(byType.NODE_TYPE_HOLY_MOLLY!.create_node, true);
  assert.equal(byType.NODE_TYPE_HOLY_MOLLY!.execution_command, 'ai-modeling studio canvas-turn');
  assert.deepEqual(byType.NODE_TYPE_HOLY_MOLLY!.execution_parameters, { capabilities: ['holy_molly'] });
  assert.equal(byType.NODE_TYPE_HOLY_MOLLY!.live_game_acceptance, 'not_completed');
  assert.equal(byType.NODE_TYPE_EXPORT_MODEL!.execution, 'retired');
  assert.equal(byType.NODE_TYPE_EXPORT_MODEL!.create_node, false);
  assert.equal(byType.NODE_TYPE_NEW_TOOL!.execution, 'unverified');
  assert.deepEqual(coverage.unmapped_execution_node_types, []);
  assert.deepEqual(coverage.unverified_definition_node_types, ['NODE_TYPE_NEW_TOOL']);
});

test('incomplete or ambiguous definitions never grant creation or execution', () => {
  for (const nodeDefinitions of [
    [],
    [{ nodeType: 'NODE_TYPE_GENERATE_IMAGE' }],
    [
      { nodeType: 'NODE_TYPE_GENERATE_IMAGE', retired: false, userCreatable: true },
      { nodeType: 'NODE_TYPE_GENERATE_IMAGE', retired: true, userCreatable: false },
    ],
  ]) {
    const result = canvasToolCoverage(
      {
        tools: [{ nodeType: 'NODE_TYPE_GENERATE_IMAGE' }],
        nodeDefinitions,
        maxCanvasNodes: '200',
      },
      canvasNode.shape.type.options,
    );
    assert.equal(result.nodes[0]!.execution, 'unverified');
    assert.equal(result.nodes[0]!.create_node, false);
    assert.equal(result.max_canvas_nodes, null);
  }
  const empty = canvasToolCoverage({}, canvasNode.shape.type.options);
  assert.equal(empty.directory_status, 'unavailable');
  assert.equal(
    canvasToolCoverage({ nodeDefinitions: [{}], tools: [] }, canvasNode.shape.type.options).directory_status,
    'incomplete',
  );
  const malformed = canvasToolCoverage(
    { nodeDefinitions: [{ nodeType: 'NODE_TYPE_GENERATE_IMAGE', retired: false, userCreatable: true }] },
    canvasNode.shape.type.options,
  );
  assert.equal(malformed.directory_status, 'incomplete');
  assert.equal(malformed.nodes[0]!.create_node, false);
  assert.equal(malformed.nodes[0]!.execution_command, null);
  assert.throws(() => canvasNodeQuote({ type: 'NODE_TYPE_constructor', params: {} }, {}), {
    code: 'PRICE_UNKNOWN',
  });
});

test('HolyMolly graph ports retain directory constraints rather than treating ANY as unrestricted', () => {
  const nodes = [
    { id: 'model', type: 'NODE_TYPE_GENERATE_HD_MODEL' },
    { id: 'image', type: 'NODE_TYPE_GENERATE_IMAGE' },
    { id: 'game', type: 'NODE_TYPE_HOLY_MOLLY', params: {} },
    { id: 'game2', type: 'NODE_TYPE_HOLY_MOLLY', params: {} },
    { id: 'game3', type: 'NODE_TYPE_HOLY_MOLLY', params: {} },
    { id: 'lab', type: 'NODE_TYPE_AI_3D_LAB' },
  ];
  const edge = (id: string, source: string, port: string, target: string, input: string) => ({
    id,
    source: { nodeId: source, port },
    target: { nodeId: target, port: input },
  });
  const graph = {
    canvasId: 'canvas',
    revision: '3',
    clientId: 'client',
    nodes,
    edges: [
      edge('a', 'game', 'html', 'game3', 'materials'),
      edge('b', 'game2', 'html', 'game3', 'materials'),
      edge('c', 'game', 'html', 'game2', 'html'),
      edge('d', 'game', 'html', 'lab', 'input'),
    ],
  };
  assert.equal(canvasSaveSchema.parse(graph).nodes[2]!.type, 'NODE_TYPE_HOLY_MOLLY');
  assert.deepEqual(canvasGraphIssues(nodes, graph.edges.slice(2)), []);
  assert.ok(canvasGraphIssues(nodes, [graph.edges[0]!]).length > 0);
  assert.deepEqual(canvasGraphIssues(nodes, [graph.edges[0]!], false), []);
  assert.throws(() =>
    canvasSaveSchema.parse({ ...graph, edges: [edge('bad', 'game', 'model', 'lab', 'input')] }),
  );
  assert.throws(() =>
    canvasSaveSchema.parse({
      ...graph,
      edges: [edge('unverified-material', 'image', 'image', 'game', 'materials')],
    }),
  );
  assert.throws(() =>
    canvasSaveSchema.parse({
      ...graph,
      edges: [edge('unverified-output', 'game', 'html', 'model', 'image')],
    }),
  );
  assert.throws(() =>
    canvasSaveSchema.parse({
      ...graph,
      edges: [...graph.edges, edge('duplicate', 'game3', 'html', 'game2', 'html')],
    }),
  );
  assert.throws(() =>
    canvasSaveSchema.parse({
      ...graph,
      edges: [...graph.edges, edge('cycle', 'game2', 'html', 'game', 'html')],
    }),
  );
  assert.throws(() => canvasNodeQuote(nodes[2]!, {}), {
    code: 'UNSUPPORTED_OPERATION',
    certainty: 'not_submitted',
  });
});
