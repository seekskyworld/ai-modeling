/** 网页 dM 的素材替换：修改挂载与来源矩阵，并移除新素材不再能连接的出边；保存仍独立。 */
import { z } from 'zod';
import { id } from '../../studio/contracts/primitives.ts';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { canvasInputPorts } from '../../studio/api/canvas-graph.ts';
import type { CanvasGraph, CanvasNode } from './canvas-layout.ts';

export const replaceUploadAction = z
  .object({
    action: z.literal('replace_upload'),
    node_id: id,
    asset_id: id,
    kind: z.enum(['image', 'model']),
    format: z.enum(['glb', 'gltf', 'fbx', 'obj', 'stl']).optional(),
    transformation: z.array(z.number().finite()).length(16).optional(),
    expected_asset_ids: z.array(id).max(500).optional(),
    catalog: z
      .record(z.string(), z.json())
      .optional()
      .describe(
        'Optional current canvas tools result, including nodeDefinitions and nodeConnections. Omitted uses the verified 2026.11.13-04 connection snapshot.',
      ),
  })
  .strict()
  .refine((x) => x.kind === 'model' || (x.format === undefined && x.transformation === undefined), {
    message: 'Model format and transformation are only valid for a model replacement.',
  });
type Action = z.infer<typeof replaceUploadAction>;
const prefix = 'NODE_TYPE_';
const defaults = {
  image: new Set(
    [
      'MULTIVIEW',
      'GENERATE_HD_MODEL',
      'GENERATE_SM_MODEL',
      'GENERATE_IMAGE',
      'IMAGE_SPLIT',
      'TEXTURE',
      'SEMANTIC_SPLIT',
      'PARTS_DETECT',
      'AI_3D_LAB',
    ].map((x) => prefix + x),
  ),
  model: new Set(
    ['RETOPOLOGY', 'TEXTURE', 'RIGGING', 'SEGMENTATION', 'PBR', 'SMART_UV', 'AI_3D_LAB'].map(
      (x) => prefix + x,
    ),
  ),
};
const viewPorts = new Set(['front', 'back', 'left', 'right']);
const valueTypes: Record<string, string> = {
  PORT_VALUE_TYPE_ANY: 'any',
  PORT_VALUE_TYPE_IMAGE: 'image',
  PORT_VALUE_TYPE_IMAGES: 'images',
  PORT_VALUE_TYPE_IMAGE_PROMPT: 'imagePrompt',
  PORT_VALUE_TYPE_MODEL: 'model',
  PORT_VALUE_TYPE_TEXT: 'text',
};

function activeInput(node: CanvasNode, port: string, replacement: boolean) {
  const multi = node.params?.input_mode === 'multi';
  if (replacement && ['NODE_TYPE_GENERATE_HD_MODEL', 'NODE_TYPE_GENERATE_SM_MODEL'].includes(node.type))
    return multi ? viewPorts.has(port) : port === 'image';
  if (node.type === 'NODE_TYPE_TEXTURE') return port === 'image' ? !multi : !viewPorts.has(port) || multi;
  return true;
}

function targetPorts(node: CanvasNode, catalog?: Action['catalog']) {
  if (!catalog) return Object.entries(canvasInputPorts(node)).map(([id, port]) => ({ id, type: port.type }));
  const definitions = array(catalog.nodeDefinitions).map(object);
  const entry = definitions.find((item) => item.nodeType === node.type);
  return array(entry?.inputPorts).map((value) => {
    const port = object(value),
      type = valueTypes[text(port.valueType)];
    if (!text(port.portId) || !type)
      throw new TripoError('INVALID_INPUT', 'Canvas catalog has an invalid input port.');
    return { id: text(port.portId), type };
  });
}

function compatible(source: string, target: string) {
  return source === target || target === 'any' || (source === 'image' && target === 'images');
}

function oldKind(node: CanvasNode) {
  const mount = object(node.inputMount?.[0]);
  if (mount.kind === 'ASSET_KIND_MODEL') return 'model';
  if (mount.kind === 'ASSET_KIND_IMAGE') return 'image';
  const files = [text(mount.filename), text(mount.url)];
  if (files.some((file) => /\.(glb|gltf|obj|fbx|stl|usdz)(?:[?#]|$)/i.test(file))) return 'model';
  if (files.some((file) => /\.(png|jpe?g|webp|gif|bmp|avif)(?:[?#]|$)/i.test(file))) return 'image';
  return node.params?.assetType === 'model' ? 'model' : 'image';
}

function resolveTargetPort(
  kind: string,
  target: CanvasNode,
  requested: string,
  ports: { id: string; type: string }[],
  replacement: boolean,
) {
  const explicit = ports.find((port) => port.id === requested);
  if (explicit) return explicit;
  if (!['', 'input'].includes(requested)) return;
  const preferred = ['NODE_TYPE_GENERATE_HD_MODEL', 'NODE_TYPE_GENERATE_SM_MODEL'].includes(target.type)
    ? target.params?.input_mode === 'multi'
      ? 'front'
      : 'image'
    : '';
  return (
    ports.find((port) => port.id === preferred && activeInput(target, port.id, replacement)) ??
    ports.find((port) => port.type === kind && activeInput(target, port.id, replacement)) ??
    ports.find((port) => compatible(kind, port.type) && activeInput(target, port.id, replacement))
  );
}

function permitsTarget(kind: Action['kind'], target: string, catalog?: Action['catalog']) {
  if (!catalog) return defaults[kind].has(target);
  const source = array(catalog.nodeDefinitions)
    .map(object)
    .find((item) => item.nodeType === 'NODE_TYPE_UPLOAD_CARD');
  if (!array(source?.userDownstreamNodeTypes).includes(target)) return false;
  const rules = array(catalog.nodeConnections).map(object);
  const from = rules.find((item) => item.nodeType === 'NODE_TYPE_UPLOAD_CARD');
  const to = rules.find((item) => item.nodeType === target);
  if (from && !array(from.downstreamNodeTypes).includes(target)) return false;
  if (to && !array(to.upstreamNodeTypes).includes('NODE_TYPE_UPLOAD_CARD')) return false;
  const specialized = array(from?.downstreamByAssetKind)
    .map(object)
    .find((item) => item.assetKind === `ASSET_KIND_${kind.toUpperCase()}`);
  return !specialized || array(specialized.downstreamNodeTypes).includes(target);
}

export function replaceCanvasUpload(graph: CanvasGraph, requested: Action) {
  const action = replaceUploadAction.parse(requested);
  const source = graph.nodes.find((node) => node.id === action.node_id);
  if (!source || source.type !== 'NODE_TYPE_UPLOAD_CARD')
    throw new TripoError('INVALID_INPUT', 'Select an existing Upload Card.');
  const previous = (source.inputMount ?? []).map((asset) => text(asset.assetId));
  if (action.expected_asset_ids && JSON.stringify(action.expected_asset_ids) !== JSON.stringify(previous))
    throw new TripoError(
      'CANVAS_CHANGED',
      'The Upload Card attachments differ from expected_asset_ids. Read the current graph.',
    );
  if (
    action.catalog &&
    (!Array.isArray(action.catalog.nodeDefinitions) ||
      !array(action.catalog.nodeDefinitions)
        .map(object)
        .some((item) => item.nodeType === 'NODE_TYPE_UPLOAD_CARD'))
  )
    throw new TripoError(
      'INVALID_INPUT',
      'Pass a canvas tools catalog containing Upload Card nodeDefinitions.',
    );
  const params = { ...source.params };
  delete params.uploadSource;
  const next: CanvasNode = {
    ...source,
    inputMount: [{ assetId: action.asset_id }],
    params: {
      ...params,
      assetType: action.kind,
      ...(action.kind === 'model'
        ? {
            uploadSource: {
              assetId: action.asset_id,
              ...(action.format ? { format: action.format } : {}),
              ...(action.transformation ? { transformMatrix: [...action.transformation] } : {}),
            },
          }
        : {}),
    },
  };
  const removed = graph.edges
    .filter((edge) => {
      if (edge.source.nodeId !== source.id) return false;
      const target = graph.nodes.find((node) => node.id === edge.target.nodeId);
      if (!target || !permitsTarget(action.kind, target.type, action.catalog)) return true;
      const ports = targetPorts(target, action.catalog);
      const previousPort =
        resolveTargetPort(oldKind(source), target, edge.target.port, ports, false)?.id ?? edge.target.port;
      const port = resolveTargetPort(action.kind, target, previousPort, ports, true);
      return (
        !['', 'output', 'image'].includes(edge.source.port) ||
        !port ||
        !activeInput(target, port.id, true) ||
        !compatible(action.kind, port.type)
      );
    })
    .map((edge) => edge.id);
  graph.nodes[graph.nodes.indexOf(source)] = next;
  graph.edges = graph.edges.filter((edge) => !removed.includes(edge.id));
  return {
    node_id: source.id,
    previous_asset_ids: previous,
    asset_id: action.asset_id,
    removed_edge_ids: removed,
    remote_saved: false,
    capability_source: action.catalog
      ? `caller_catalog:${text(action.catalog.nodeDefinitionsVersion) || 'unspecified'}`
      : 'web_snapshot:2026.11.13-04',
  };
}
