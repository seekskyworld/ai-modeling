/** 网页 Tc/Sc 片段规则：系统结果离开执行器分组后只能作为已完成的图片附件。 */
import type { CanvasGraph } from './canvas-layout.ts';
import { object, text } from '../../studio/contracts/errors.ts';

type Node = CanvasGraph['nodes'][number];
type Asset = NonNullable<Node['nodeAssets']>[number];
const sectionSources = ['cutoutSourceId', 'extractDetectId', 'extractSplitId', 'multiviewSourceId'];

function resultOwner(node: Node, graph: CanvasGraph) {
  const byId = new Map(graph.nodes.map((entry) => [entry.id, entry]));
  const parent = byId.get(node.pid || '');
  const section = parent?.type === 'NODE_TYPE_SECTION' ? parent : undefined;
  const inbound = graph.edges.filter((edge) => edge.target.nodeId === node.id);
  const from = (type: string) =>
    inbound.find((edge) => byId.get(edge.source.nodeId)?.type === type)?.source.nodeId || '';
  const param = (name: string) => text(section?.params?.[name]);
  let executor: string;
  switch (node.type) {
    case 'NODE_TYPE_ASSET':
      executor = from('NODE_TYPE_IMAGE_SPLIT') || param('cutoutSourceId');
      if (!executor || (byId.has(executor) && byId.get(executor)!.type !== 'NODE_TYPE_IMAGE_SPLIT')) return;
      break;
    case 'NODE_TYPE_SPLIT_RESULT':
      executor = from('NODE_TYPE_SEMANTIC_SPLIT') || param('extractSplitId');
      if (!executor) return;
      break;
    case 'NODE_TYPE_MULTIVIEW_RESULT':
      executor =
        from('NODE_TYPE_SEMANTIC_SPLIT') || from('NODE_TYPE_MULTIVIEW') || param('multiviewSourceId');
      break;
    default:
      return;
  }
  return { executor, section: section?.id || '' };
}

function usableImage(node: Node): Asset | undefined {
  const usable = (asset: Asset) => {
    const kind = text(asset.kind).trim();
    return (
      (!kind || kind === 'ASSET_KIND_IMAGE' || kind === 'image') &&
      !!text(asset.assetId).trim() &&
      !!text(asset.url).trim()
    );
  };
  return (
    node.nodeAssets?.find((asset) => asset.selected === true && usable(asset)) ??
    node.nodeAssets?.find(usable)
  );
}

function asUpload(node: Node, asset: Asset) {
  node.type = 'NODE_TYPE_UPLOAD_CARD';
  node.params = { assetType: 'image' };
  node.inputMount = [
    {
      assetId: text(asset.assetId).trim(),
      kind: 'ASSET_KIND_IMAGE',
      url: text(asset.url).trim(),
      ...(text(asset.filename).trim() ? { filename: text(asset.filename).trim() } : {}),
      ...(text(asset.thumbnailUrl).trim() ? { thumbnailUrl: text(asset.thumbnailUrl).trim() } : {}),
    },
  ];
  delete node.batchId;
  delete node.nodeAssets;
  delete node.pid;
}

function cleanCopiedNode(source: Node) {
  const node = structuredClone(source);
  node.params = { ...node.params };
  delete node.displayNo;
  if (node.type !== 'NODE_TYPE_UPLOAD_CARD') delete node.inputMount;
  if (node.type === 'NODE_TYPE_AI_3D_LAB') {
    // Lab 是新的独立工作上下文，不能携带来源会话的 params 和界面尺寸。
    const instructions = object(node.taskInstructions);
    return {
      id: node.id,
      type: node.type,
      params: {},
      ...(node.name === undefined ? {} : { name: node.name }),
      ...(node.pid ? { pid: node.pid } : {}),
      ...(node.nodeAssets ? { nodeAssets: node.nodeAssets } : {}),
      ...(node.taskInstructions ? { taskInstructions: { ...instructions, nodeId: node.id } } : {}),
      ui: { position: { x: node.ui?.position.x ?? 0, y: node.ui?.position.y ?? 0 } },
    } satisfies Node;
  }
  return node;
}

export function remapSectionSources(node: Node, mapping: Map<string, string>) {
  if (node.type !== 'NODE_TYPE_SECTION') return;
  node.params = { ...node.params };
  for (const key of sectionSources) {
    const next = mapping.get(text(node.params[key]));
    if (next) node.params[key] = next;
    else delete node.params[key];
  }
}

export function planCanvasFragment(graph: CanvasGraph, selected: Set<string>) {
  const detached = new Set<string>();
  const excluded: string[] = [];
  const nodes: Node[] = [];
  for (const source of graph.nodes.filter((node) => selected.has(node.id))) {
    const owner = resultOwner(source, graph);
    const node = cleanCopiedNode(source);
    if (
      owner &&
      !(owner.executor && owner.section && selected.has(owner.executor) && selected.has(owner.section))
    ) {
      const image = usableImage(source);
      if (!image) {
        excluded.push(source.id);
        continue;
      }
      asUpload(node, image);
      detached.add(source.id);
    }
    nodes.push(node);
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const kept = new Set(nodes.map((node) => node.id));
  const copyableEdge = (edge: CanvasGraph['edges'][number]) =>
    !detached.has(edge.source.nodeId) &&
    !detached.has(edge.target.nodeId) &&
    byId.get(edge.source.nodeId)?.type !== 'NODE_TYPE_SEMANTIC_SPLIT';
  const edges = graph.edges.filter((edge) => kept.has(edge.target.nodeId) && copyableEdge(edge));
  return { nodes, edges, detached, excluded, kept, byId };
}
