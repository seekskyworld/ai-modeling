/** 网页画布的端口与必填输入契约；保存允许未完成节点，执行前才验证所选节点的输入可用性。 */
import { array, object, text } from '../contracts/errors.ts';

interface Node {
  id: string;
  type: string;
  pid?: string;
  params?: Record<string, unknown> | null;
  inputMount?: unknown[];
  nodeAssets?: unknown[];
}
interface Edge {
  id: string;
  source: { nodeId: string; port: string };
  target: { nodeId: string; port: string };
}
interface Port {
  type: string;
  multiple?: boolean;
  required?: boolean;
  group?: string;
  fallback?: string;
}
interface Ports {
  inputs: Record<string, Port>;
  outputs: Record<string, Port>;
}
const image: Port = { type: 'image' };
const model: Port = { type: 'model' };
const views = Object.fromEntries(['front', 'left', 'back', 'right'].map((key) => [key, image]));
const modelProcessors = new Set(['RETOPOLOGY', 'SMART_UV', 'PBR', 'RIGGING', 'ANIMATION', 'SEGMENTATION']);
const executable = new Set([
  ...modelProcessors,
  'GENERATE_IMAGE',
  'GENERATE_HD_MODEL',
  'GENERATE_SM_MODEL',
  'IMAGE_SPLIT',
  'MULTIVIEW',
  'PARTS_DETECT',
  'SEMANTIC_SPLIT',
  'TEXTURE',
  'REVIEW',
]);

function labAssetPort(asset: Record<string, unknown>): Port | undefined {
  const unavailable = /(?:^|_)(?:queued|running|processing|pending|failed|error|cancelled)$/i;
  if (unavailable.test(text(asset.status)) || unavailable.test(text(asset.studioState))) return;
  const kind = text(asset.kind);
  if (kind && kind !== 'ASSET_KIND_UNSPECIFIED')
    return { type: kind === 'ASSET_KIND_MODEL' ? 'model' : kind === 'ASSET_KIND_IMAGE' ? 'image' : 'any' };
  // GetCanvas 的简略素材省略 kind；只以明确文件类型恢复，未知格式必须先查 ListNodesAssets。
  const file = text(asset.filename) || text(asset.url);
  if (/\.(glb|gltf|fbx|obj|stl|usdz|3mf)(?:[?#]|$)/i.test(file)) return model;
  if (/\.(png|jpe?g|webp)(?:[?#]|$)/i.test(file)) return image;
}

/** 新 Lab 连线使用选中资产的 output；旧图命名端口只在当前 Studio 产物有对应类型时保留。 */
function labOutputs(node: Node): Record<string, Port> {
  const assets = array(node.nodeAssets)
    .map(object)
    .filter((asset) => asset.role !== 'ASSET_ROLE_SUPERSEDED');
  if (!assets.length) return { output: { type: 'any' } };
  const result: Record<string, Port> = {};
  for (const asset of assets) {
    if (asset.role !== 'ASSET_ROLE_CURRENT' || asset.source !== 'ASSET_SOURCE_STUDIO') continue;
    const port = labAssetPort(asset);
    if (port && ['image', 'model'].includes(port.type) && text(asset.assetId)) result[port.type] = port;
  }
  const selected = assets.filter((asset) => asset.selected === true);
  if (selected.length === 1 && text(selected[0]!.assetId)) {
    const output = labAssetPort(selected[0]!);
    if (output) result.output = output;
  }
  return result;
}

function uploadPorts(node: Node): Ports {
  const mount = object(node.inputMount?.[0]);
  const file = text(mount.filename) || text(mount.url);
  // 视频是 Lab 附件，不能因非 MODEL 而误判为图片并流入图片建模。
  if (
    mount.kind === 'ASSET_KIND_VIDEO' ||
    /\.(3gp|avi|flv|m4v|mkv|mov|mp4|rmvb|ts|webm|wmv)(?:[?#]|$)/i.test(file)
  )
    return { inputs: {}, outputs: { image: { type: 'video' } } };
  const isModel =
    mount.kind === 'ASSET_KIND_MODEL' ||
    node.params?.assetType === 'model' ||
    /\.(glb|gltf|fbx|obj|stl)(?:[?#]|$)/i.test(file);
  return { inputs: {}, outputs: { image: isModel ? model : image } };
}

/** 端口名来自已核对的网页 schema；动态上传和 Lab 输出依据资产类型解析。 */
function ports(node: Node): Ports {
  const kind = node.type.replace('NODE_TYPE_', '');
  if (modelProcessors.has(kind))
    return { inputs: { model: { ...model, required: true } }, outputs: { model } };
  if (['GENERATE_HD_MODEL', 'GENERATE_SM_MODEL'].includes(kind))
    return {
      inputs: Object.fromEntries(
        Object.entries({ ...views, image, images: { type: 'images', multiple: true } }).map(([key, p]) => [
          key,
          { ...p, group: 'source' },
        ]),
      ),
      outputs: { model },
    };
  if (kind === 'GENERATE_IMAGE')
    return {
      inputs: {
        image: { ...image, multiple: true, group: 'source' },
        text: { type: 'text', fallback: 'prompt', group: 'source' },
      },
      outputs: { image },
    };
  if (kind === 'TEXTURE')
    return { inputs: { ...views, image, model: { ...model, required: true } }, outputs: { model } };
  if (kind === 'MULTIVIEW') return { inputs: { image: { ...image, required: true } }, outputs: views };
  if (kind === 'IMAGE_SPLIT')
    return { inputs: { image: { ...image, required: true } }, outputs: { images: { type: 'images' } } };
  if (kind === 'SEMANTIC_SPLIT')
    return {
      inputs: { image: { ...image, required: true } },
      outputs: { image: { type: 'imagePrompt', multiple: true } },
    };
  if (kind === 'PARTS_DETECT')
    return { inputs: { image: { ...image, required: true } }, outputs: { text: { type: 'text' } } };
  if (kind === 'REVIEW') return { inputs: { image: { ...image, required: true } }, outputs: { image } };
  if (kind === 'SECTION') return { inputs: {}, outputs: {} };
  // HolyMolly executes through Agent capabilities; graph links carry HTML, not material attachments.
  if (kind === 'HOLY_MOLLY')
    return {
      inputs: { materials: { type: 'any', multiple: true }, html: { type: 'any' } },
      outputs: { html: { type: 'any' } },
    };
  if (kind === 'UPLOAD_CARD') return uploadPorts(node);
  if (kind === 'AI_3D_LAB')
    return {
      inputs: { input: { type: 'any', multiple: true } },
      outputs: labOutputs(node),
    };
  return { inputs: { image: { type: 'images' } }, outputs: { image } };
}
function compatible(source: string, target: string): boolean {
  return (
    source === 'any' ||
    target === 'any' ||
    source === target ||
    (source === 'image' && target === 'images') ||
    (source === 'imagePrompt' && ['image', 'images', 'text'].includes(target))
  );
}

/** 本地图编辑复用同一输入端口契约；动态目录可由调用方显式提供。 */
export function canvasInputPorts(node: Node): Record<string, Port> {
  return ports(node).inputs;
}

/** 保存保留已有 Lab 边，不以当前任务状态删除拓扑；新建连接和运行时再检查实际输出。 */
function graphOutputs(node: Node, checkLabState: boolean): Record<string, Port> {
  if (node.type === 'NODE_TYPE_AI_3D_LAB' && !checkLabState) return { output: { type: 'any' }, model, image };
  return ports(node).outputs;
}

function hasSourceArtifact(node: Node, port: string): boolean {
  if (node.type !== 'NODE_TYPE_AI_3D_LAB')
    return [...array(node.nodeAssets), ...array(node.inputMount)].some((asset) => text(object(asset).url));
  const name = port || 'output';
  if (!labOutputs(node)[name]) return false;
  return array(node.nodeAssets)
    .map(object)
    .some((asset) => {
      if (asset.role === 'ASSET_ROLE_SUPERSEDED' || !text(asset.assetId) || !text(asset.url)) return false;
      const type = labAssetPort(asset)?.type;
      if (!type) return false;
      return name === 'output'
        ? asset.selected === true
        : asset.role === 'ASSET_ROLE_CURRENT' && asset.source === 'ASSET_SOURCE_STUDIO' && type === name;
    });
}
function hasCycle(ids: string[], adjacency: Map<string, string[]>): boolean {
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return true;
    if (visited.has(id)) return false;
    active.add(id);
    if ((adjacency.get(id) ?? []).some(visit)) return true;
    active.delete(id);
    visited.add(id);
    return false;
  };
  return ids.some(visit);
}
function systemResultEdge(source: Node | undefined, target: Node | undefined, edge: Edge): boolean {
  if (!source || !target || edge.source.port || edge.target.port) return false;
  const allowed: Record<string, string[]> = {
    NODE_TYPE_IMAGE_SPLIT: ['NODE_TYPE_ASSET', 'NODE_TYPE_SPLIT_RESULT'],
    NODE_TYPE_MULTIVIEW: ['NODE_TYPE_MULTIVIEW_RESULT'],
    NODE_TYPE_SEMANTIC_SPLIT: ['NODE_TYPE_SPLIT_RESULT'],
  };
  return allowed[source.type]?.includes(target.type) ?? false;
}
function connectionPorts(
  source: Node | undefined,
  target: Node | undefined,
  edge: Edge,
  checkLabState: boolean,
): { from?: Port; to?: Port } {
  // The webpage's connection builder routes Holy HTML to html, never materials; rejected saves report 5415.
  // Material references travel in CreateTurn attachments. Preserve existing saved topology on reads.
  if (checkLabState && target?.type === 'NODE_TYPE_HOLY_MOLLY' && edge.target.port === 'materials') return {};
  // ANY materials does not imply arbitrary uploads: the live directory permits only HolyMolly upstream.
  if (
    (target?.type === 'NODE_TYPE_HOLY_MOLLY' && source?.type !== 'NODE_TYPE_HOLY_MOLLY') ||
    (source?.type === 'NODE_TYPE_HOLY_MOLLY' &&
      !['NODE_TYPE_HOLY_MOLLY', 'NODE_TYPE_AI_3D_LAB'].includes(target?.type ?? ''))
  )
    return {};
  // 网页新建 Lab 连线省略 source.port，服务读回为空串。
  const sourcePort =
    source?.type === 'NODE_TYPE_AI_3D_LAB' && !edge.source.port ? 'output' : edge.source.port;
  return {
    from: source && graphOutputs(source, checkLabState)[sourcePort],
    to: target && ports(target).inputs[edge.target.port],
  };
}
export function canvasGraphIssues(nodes: Node[], edges: Edge[], checkLabState = true): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const issues: string[] = [];
  if (byId.size !== nodes.length) issues.push('Duplicate node IDs.');
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) issues.push('Duplicate edge IDs.');
  const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const parents = new Map(nodes.map((node) => [node.id, node.pid ? [node.pid] : []]));
  if (nodes.some((node) => node.pid && byId.get(node.pid)?.type !== 'NODE_TYPE_SECTION'))
    issues.push('Node pid must reference a section.');
  if (hasCycle([...byId.keys()], parents)) issues.push('Canvas section nesting must be acyclic.');
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const source = byId.get(edge.source.nodeId);
    const target = byId.get(edge.target.nodeId);
    if (systemResultEdge(source, target, edge)) {
      adjacency.get(edge.source.nodeId)!.push(edge.target.nodeId);
      continue;
    }
    const { from, to } = connectionPorts(source, target, edge, checkLabState);
    if (!from || !to) {
      issues.push('Connection references an invalid node or port.');
      continue;
    }
    if (!compatible(from.type, to.type)) issues.push('Connection has incompatible port types.');
    const key = `${edge.target.nodeId}:${edge.target.port}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > 1 && !to.multiple) issues.push('Input port accepts only one connection.');
    adjacency.get(edge.source.nodeId)!.push(edge.target.nodeId);
  }
  if (hasCycle([...byId.keys()], adjacency)) issues.push('Canvas graph must be acyclic.');
  return [...new Set(issues)];
}
export function canvasInputIssues(nodes: Node[], edges: Edge[], selectedIds: string[]): string[] {
  const selected = new Set(selectedIds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inputs = (node: Node, visiting: Set<string>): string[] => {
    const definition = ports(node).inputs;
    const available = (port: string): boolean => {
      const fallback = definition[port]?.fallback;
      if (fallback && text(node.params?.[fallback]).trim()) return true;
      return edges.some((edge) => {
        if (edge.target.nodeId !== node.id || edge.target.port !== port) return false;
        const source = byId.get(edge.source.nodeId);
        if (!source) return false;
        if (hasSourceArtifact(source, edge.source.port)) return true;
        return (
          selected.has(source.id) &&
          executable.has(source.type.replace('NODE_TYPE_', '')) &&
          !visiting.has(source.id) &&
          inputs(source, new Set(visiting).add(source.id)).length === 0
        );
      });
    };
    const missing = Object.entries(definition)
      .filter(([key, p]) => p.required && !available(key))
      .map(([key]) => key);
    const groups = new Set(
      Object.values(definition)
        .map((p) => p.group)
        .filter(Boolean),
    );
    for (const group of groups)
      if (!Object.entries(definition).some(([key, p]) => p.group === group && available(key)))
        missing.push(String(group));
    if (node.type === 'NODE_TYPE_TEXTURE') {
      const multi = node.params?.input_mode === 'multi';
      if (multi && (!available('front') || !['left', 'back', 'right'].some(available)))
        missing.push('front plus another view');
      if (
        !multi &&
        !available('image') &&
        !node.params?.image &&
        !node.params?.images &&
        !node.params?.prompt_text
      )
        missing.push('image or prompt_text');
    }
    return missing;
  };
  // 只核本次执行节点的 Lab 入边；其他节点的旧边即使重跑中也不能阻止无关分支执行。
  const labEdges = edges.filter(
    (edge) =>
      selected.has(edge.target.nodeId) && byId.get(edge.source.nodeId)?.type === 'NODE_TYPE_AI_3D_LAB',
  );
  const labIssues = canvasGraphIssues(nodes, labEdges);
  if (labEdges.some((edge) => !hasSourceArtifact(byId.get(edge.source.nodeId)!, edge.source.port)))
    labIssues.push('Selected nodes reference a Lab output that is not ready.');
  return [
    ...labIssues,
    ...nodes
      .filter((node) => selected.has(node.id))
      .flatMap((node) => inputs(node, new Set([node.id])).map((port) => `${node.id} requires ${port}.`)),
  ];
}
