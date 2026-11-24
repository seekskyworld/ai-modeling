/** Compare the live Canvas directory with executable CLI routes; retain uncertainty for newly advertised tools. */
import { array, object, text } from '../contracts/errors.ts';
import { canvasExecutionCommand } from './canvas-pricing.ts';

function completeDefinition(definition: Record<string, unknown> | undefined): boolean {
  if (!definition) return false;
  return (
    [
      'NODE_KIND_INPUT',
      'NODE_KIND_TOOL',
      'NODE_KIND_CONTAINER',
      'NODE_KIND_RESULT',
      'NODE_KIND_OTHER',
    ].includes(text(definition.kind)) &&
    typeof definition.userCreatable === 'boolean' &&
    typeof definition.retired === 'boolean' &&
    [definition.inputPorts, definition.outputPorts].every(
      (ports) =>
        Array.isArray(ports) &&
        ports.every((value) => {
          const port = object(value);
          return !!text(port.portId) && /^PORT_VALUE_TYPE_[A-Z_]+$/.test(text(port.valueType));
        }),
    ) &&
    [definition.systemDownstreamNodeTypes, definition.userDownstreamNodeTypes].every(
      (types) =>
        Array.isArray(types) &&
        types.every((type) => typeof type === 'string' && type.startsWith('NODE_TYPE_')),
    )
  );
}

export function canvasToolCoverage(input: unknown, graphTypes: readonly string[]) {
  const registry = object(input);
  const supported = new Set(graphTypes);
  const definitions = array(registry.nodeDefinitions).map(object);
  const validRows = [registry.nodeDefinitions, registry.tools].every(
    (rows) =>
      Array.isArray(rows) && rows.every((row) => /^NODE_TYPE_[A-Z0-9_]+$/.test(text(object(row).nodeType))),
  );
  const toolTypes = new Set(
    array(registry.tools)
      .map((entry) => text(object(entry).nodeType))
      .filter(Boolean),
  );
  const types = [
    ...new Set([...definitions.map((entry) => text(entry.nodeType)).filter(Boolean), ...toolTypes]),
  ];
  const nodes = types.map((nodeType) => {
    const matches = definitions.filter((entry) => entry.nodeType === nodeType);
    const definition = matches.length === 1 ? matches[0] : undefined;
    const complete = completeDefinition(definition);
    const retired = typeof definition?.retired === 'boolean' ? definition.retired : null;
    const creatable = typeof definition?.userCreatable === 'boolean' ? definition.userCreatable : null;
    const graph = supported.has(nodeType);
    const command = canvasExecutionCommand(nodeType);
    const structural = ['NODE_KIND_INPUT', 'NODE_KIND_CONTAINER', 'NODE_KIND_RESULT'].includes(
      text(definition?.kind),
    );
    const execution =
      retired === true
        ? 'retired'
        : !complete
          ? 'unverified'
          : graph && command
            ? 'mapped'
            : structural && !toolTypes.has(nodeType)
              ? 'not_applicable'
              : 'unmapped';
    return {
      node_type: nodeType,
      definition_available: complete,
      graph_edit: graph,
      create_node: complete && graph && creatable === true && retired === false,
      user_creatable: creatable,
      retired,
      execution,
      execution_command: execution === 'mapped' ? command : null,
      ...(nodeType === 'NODE_TYPE_HOLY_MOLLY'
        ? {
            execution_parameters: { capabilities: ['holy_molly'] },
            live_game_acceptance: 'not_completed',
            limitation:
              'The webpage Agent request contract is mapped: material refs, optional game node_id and explicit variable billing. Canvas CreateRun and new materials edges are not supported. Generation, modification, settled cost, original game files and playability have not completed live acceptance.',
          }
        : {}),
    };
  });
  return {
    directory_status: !definitions.length
      ? 'unavailable'
      : validRows && nodes.length > 0 && nodes.every((node) => node.definition_available)
        ? 'available'
        : 'incomplete',
    registry_version: text(registry.registryVersion) || null,
    node_definitions_version: text(registry.nodeDefinitionsVersion) || null,
    max_canvas_nodes:
      Number.isSafeInteger(registry.maxCanvasNodes) && Number(registry.maxCanvasNodes) > 0
        ? registry.maxCanvasNodes
        : null,
    nodes,
    unmapped_execution_node_types: nodes
      .filter((node) => node.execution === 'unmapped')
      .map((node) => node.node_type),
    unverified_definition_node_types: nodes
      .filter((node) => node.execution === 'unverified')
      .map((node) => node.node_type),
    graph_unsupported_node_types: nodes.filter((node) => !node.graph_edit).map((node) => node.node_type),
    local_only_node_types: graphTypes.filter((nodeType) => !types.includes(nodeType)),
    scope:
      'Current service directory compared with CLI routes; not webpage-menu, account-permission or output-effect acceptance.',
  };
}
