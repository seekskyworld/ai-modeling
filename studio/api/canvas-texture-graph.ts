/** 网页 Nu/zv/Vv 的图条件；只提出准备动作，不自动保存或运行纹理生成。 */
import { array, object, text, TripoError } from '../contracts/errors.ts';

export interface ReferenceNode {
  id: string;
  type: string;
  params?: Record<string, unknown> | null;
  nodeAssets?: unknown[];
  inputMount?: unknown[];
}
export interface ReferenceEdge {
  id: string;
  source: { nodeId: string; port?: string };
  target: { nodeId: string; port?: string };
}
export interface ReferenceGraph {
  nodes: ReferenceNode[];
  edges: ReferenceEdge[];
}
interface Port {
  id: string;
  type: string;
}
type Catalog = Map<string, { inputs: Port[]; outputs: Port[] }>;
const views = ['front', 'left', 'back', 'right'];
const slotViews = ['front', 'back', 'left', 'right'];
const upload = 'NODE_TYPE_UPLOAD_CARD',
  lab = 'NODE_TYPE_AI_3D_LAB',
  texture = 'NODE_TYPE_TEXTURE';
const kinds: Record<string, string> = {
  ANY: 'any',
  IMAGE: 'image',
  IMAGES: 'images',
  IMAGE_PROMPT: 'imagePrompt',
  MODEL: 'model',
  TEXT: 'text',
};

export function referenceCatalog(value: unknown): Catalog {
  const result: Catalog = new Map();
  for (const definition of array(object(value).nodeDefinitions).map(object)) {
    const ports = (key: string) =>
      array(definition[key]).map((value) => {
        const x = object(value),
          type = kinds[text(x.valueType).replace('PORT_VALUE_TYPE_', '')];
        if (!text(x.portId) || !type)
          throw new TripoError('CONTRACT_CHANGED', 'Canvas reference port catalog changed.');
        return { id: text(x.portId), type };
      });
    result.set(text(definition.nodeType), { inputs: ports('inputPorts'), outputs: ports('outputPorts') });
  }
  if (!result.has(texture)) throw new TripoError('CONTRACT_CHANGED', 'Canvas catalog has no Texture node.');
  return result;
}
function uploadModel(node: ReferenceNode) {
  const mount = object(array(node.inputMount)[0]);
  if (mount.kind === 'ASSET_KIND_MODEL') return true;
  if (mount.kind === 'ASSET_KIND_IMAGE') return false;
  return (
    [mount.filename, mount.url].some((x) => /\.(glb|gltf|obj|fbx|stl|usdz)(?:[?#]|$)/i.test(text(x))) ||
    node.params?.assetType === 'model'
  );
}
function currentLab(node: ReferenceNode) {
  return array(node.nodeAssets)
    .map(object)
    .filter((asset) => asset.role === 'ASSET_ROLE_CURRENT' && asset.source === 'ASSET_SOURCE_STUDIO');
}
function outputs(node: ReferenceNode, catalog: Catalog): Port[] {
  if (node.type === lab) {
    const assets = currentLab(node);
    const result = ['model', 'image']
      .filter((kind) => assets.some((a) => a.kind === `ASSET_KIND_${kind.toUpperCase()}`))
      .map((type) => ({ id: type, type }));
    return result.length ? result : [{ id: 'output', type: 'any' }];
  }
  const ports = catalog.get(node.type)?.outputs ?? [];
  return node.type === upload
    ? ports.map((port) => ({ ...port, type: uploadModel(node) ? 'model' : 'image' }))
    : ports;
}
function compatible(source: string, target: string) {
  return (
    source === target ||
    source === 'any' ||
    target === 'any' ||
    (source === 'image' && target === 'images') ||
    (source === 'imagePrompt' && ['image', 'images', 'text'].includes(target))
  );
}
function active(node: ReferenceNode, port: string) {
  return (
    node.type !== texture ||
    (port === 'image'
      ? node.params?.input_mode !== 'multi'
      : !views.includes(port) || node.params?.input_mode === 'multi')
  );
}
function resolve(source: ReferenceNode, target: ReferenceNode, edge: ReferenceEdge, catalog: Catalog) {
  const from = outputs(source, catalog),
    to = catalog.get(target.type)?.inputs ?? [];
  const explicit = to.find((p) => p.id === edge.target.port);
  const origin =
    source.type === lab
      ? from.find((p) =>
          explicit
            ? compatible(p.type, explicit.type)
            : to.some((t) => active(target, t.id) && compatible(p.type, t.type)),
        )
      : (from.find((p) => p.id === edge.source.port) ??
        (!edge.source.port || edge.source.port === 'output' ? from[0] : undefined));
  if (!origin) return null;
  const dest =
    explicit ??
    (!edge.target.port || edge.target.port === 'input'
      ? (to.find((p) => p.type === origin.type && active(target, p.id)) ??
        to.find((p) => compatible(origin.type, p.type) && active(target, p.id)))
      : undefined);
  if (!dest || (source.type === lab && (!active(target, dest.id) || !compatible(origin.type, dest.type))))
    return null;
  return { sourcePort: origin, targetPort: dest };
}
function parents(node: ReferenceNode, graph: ReferenceGraph, catalog: Catalog, port?: string) {
  const result: { node: ReferenceNode; sourcePort: Port; targetPort: Port }[] = [];
  for (const edge of graph.edges.filter((e) => e.target.nodeId === node.id)) {
    const source = graph.nodes.find((n) => n.id === edge.source.nodeId);
    if (!source || (source.type === upload && !text(object(array(source.inputMount)[0]).assetId).trim()))
      continue;
    const pair = resolve(source, node, edge, catalog);
    if (
      !pair ||
      (port && pair.targetPort.id !== port) ||
      (source.type === upload && !compatible(pair.sourcePort.type, pair.targetPort.type))
    )
      continue;
    if (!result.some((p) => p.node.id === source.id && p.sourcePort.id === pair.sourcePort.id))
      result.push({ node: source, ...pair });
  }
  return result;
}
export function hasReference(value: unknown): boolean {
  if (typeof value === 'string') return !!value.trim();
  const x = object(value);
  if ('asset' in x) return hasReference(x.asset);
  return !!(text(x.url).trim() || text(x.assetId).trim() || (text(x.bucket).trim() && text(x.key).trim()));
}
function explicitImages(node: ReferenceNode) {
  const images = node.params?.images;
  return (Array.isArray(images) ? images : views.map((v) => object(images)[v])).some(hasReference);
}
function modelAsset(node: ReferenceNode, port: Port): string {
  if (node.type === upload || port.type !== 'model') return '';
  const assets = array(node.nodeAssets)
    .map(object)
    .filter((a) =>
      node.type === lab
        ? a.kind === 'ASSET_KIND_MODEL' && a.source === 'ASSET_SOURCE_STUDIO'
        : !a.kind || a.kind === 'ASSET_KIND_UNSPECIFIED' || a.kind === 'ASSET_KIND_MODEL',
    );
  const chosen =
    assets.find((a) => a.selected) ??
    assets.find((a) => a.role === 'ASSET_ROLE_CURRENT' && text(a.assetId).trim()) ??
    (node.type !== lab
      ? assets.find((a) => (!a.role || a.role === 'ASSET_ROLE_UNSPECIFIED') && text(a.assetId).trim())
      : undefined);
  return text(chosen?.assetId).trim();
}
function modelHasLab(node: ReferenceNode, graph: ReferenceGraph, catalog: Catalog) {
  const seen = new Set<string>();
  let level = [node];
  for (let depth = 0; depth < 16 && level.length; depth++) {
    const next: ReferenceNode[] = [];
    for (const current of level) {
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      if (current.type === lab) return true;
      next.push(...parents(current, graph, catalog, 'model').map((x) => x.node));
    }
    level = next;
  }
  return false;
}
function validUrl(value: unknown) {
  return /^https?:\/\//.test(text(value).trim());
}
function multiviewImage(node: ReferenceNode, view: string) {
  const assets = array(node.nodeAssets).map(object),
    index = slotViews.indexOf(view);
  const asset =
    assets.find((a) => a.slotIndex === index) ??
    (assets.every((a) => a.slotIndex == null) ? assets[index] : undefined);
  if (validUrl(asset?.url) || validUrl(asset?.thumbnailUrl)) return true;
  let entry: unknown = object(node.params?.viewPreviews)[view];
  const images = node.params?.images;
  if (Array.isArray(images)) entry = images.find((a) => object(a).label === view) ?? entry;
  else entry = object(images)[view] ?? entry;
  const nested = object(entry).asset ?? entry;
  const mount = array(node.inputMount)
    .map(object)
    .find((a) => a.assetId === object(nested).assetId);
  return (
    validUrl(mount?.url) ||
    validUrl(object(nested).url) ||
    validUrl(object(nested).thumbnailUrl) ||
    validUrl(nested)
  );
}
function declaredView(node: ReferenceNode, port: string) {
  const named = ['NODE_TYPE_MULTIVIEW_RESULT', 'NODE_TYPE_ASSET'].includes(node.type)
    ? text(
        node.params?.view ?? (node.type === 'NODE_TYPE_ASSET' ? node.params?.label : undefined),
      ).toLowerCase()
    : '';
  return views.includes(named) ? named : views.includes(port) ? port : '';
}
function imageViews(node: ReferenceNode, catalog: Catalog) {
  if (node.type === upload && uploadModel(node)) return [];
  let assets = array(node.nodeAssets).map(object);
  if (node.type === lab) {
    assets = currentLab(node);
    const selected = assets.filter((a) => a.selected);
    return (selected.length ? selected : assets)
      .filter((a) => a.kind === 'ASSET_KIND_IMAGE' && validUrl(a.url))
      .map(() => '');
  }
  const result: string[] = [];
  // Fv 调用的是不带上传运行态的 U(type)；目录把 UploadCard 输出声明为 any 时，网页不把它当作自动图像祖先。
  const ports = catalog.get(node.type)?.outputs ?? [];
  for (const [index, port] of ports.entries()) {
    if (!['image', 'images'].includes(port.type)) continue;
    if (node.type === 'NODE_TYPE_MULTIVIEW') {
      if (multiviewImage(node, port.id)) result.push(port.id);
      continue;
    }
    const values =
      port.type === 'images'
        ? assets
        : [
            node.type === upload
              ? object(array(node.inputMount)[0])
              : (assets.find((a) => a.selected) ?? assets[index]),
          ];
    for (const asset of values) if (validUrl(object(asset).url)) result.push(declaredView(node, port.id));
  }
  return result;
}
function nearestImage(node: ReferenceNode, graph: ReferenceGraph, catalog: Catalog) {
  const seen = new Set([node.id]);
  let level = [node.id];
  for (let depth = 0; depth < 16 && level.length; depth++) {
    const next: string[] = [],
      candidates: { node: ReferenceNode; view: string }[] = [];
    for (const id of level)
      for (const edge of graph.edges.filter((e) => e.target.nodeId === id)) {
        const source = graph.nodes.find((n) => n.id === edge.source.nodeId);
        if (!source || seen.has(source.id)) continue;
        seen.add(source.id);
        if (source.type !== lab) next.push(source.id);
        for (const view of imageViews(source, catalog)) candidates.push({ node: source, view });
      }
    if (candidates.length) return candidates.find((x) => x.view === 'front')?.node ?? candidates[0]!.node;
    level = next;
  }
  return null;
}
function connectNearest(target: ReferenceNode, graph: ReferenceGraph, catalog: Catalog) {
  const nearest = nearestImage(target, graph, catalog);
  if (!nearest) return null;
  const pair = resolve(
    nearest,
    target,
    {
      id: '',
      source: { nodeId: nearest.id, port: 'output' },
      target: { nodeId: target.id, port: 'image' },
    },
    catalog,
  );
  return pair
    ? { kind: 'connect_image' as const, source_node_id: nearest.id, source_port: pair.sourcePort.id }
    : null;
}
export function textureReferencePlan(graph: ReferenceGraph, nodeId: string, catalog: Catalog) {
  const target = graph.nodes.find((n) => n.id === nodeId);
  if (!target || target.type !== texture)
    throw new TripoError('INVALID_INPUT', 'Select an existing Texture node.');
  const unchanged = (reason: string) => ({ kind: 'unchanged' as const, reason });
  const params = target.params ?? {};
  if (params.texture_reference_locked === true) return unchanged('reference_locked');
  const incoming = parents(target, graph, catalog);
  const activeViews = new Set(params.input_mode === 'multi' ? views : ['image']);
  if (
    graph.edges.some((e) => e.target.nodeId === nodeId && activeViews.has(e.target.port ?? '')) ||
    incoming.some((p) => activeViews.has(p.targetPort.id))
  )
    return unchanged('image_connection_present');
  const prompt = text(params.prompt_text).trim(),
    multiple = explicitImages(target);
  if (!prompt && !multiple && params.input_mode !== 'multi') {
    const connection = connectNearest(target, graph, catalog);
    if (connection) return connection;
  }
  if (prompt) return unchanged('prompt_present');
  if (multiple || hasReference(params.image)) return unchanged('explicit_reference_present');
  const model = incoming.find((p) => p.targetPort.id === 'model');
  if (!model) return unchanged('model_connection_absent');
  if (modelHasLab(model.node, graph, catalog)) return unchanged('lab_model_ancestor');
  const assetId = modelAsset(model.node, model.sourcePort);
  return assetId
    ? { kind: 'model_source' as const, source_asset_id: assetId }
    : unchanged('model_asset_unavailable');
}
