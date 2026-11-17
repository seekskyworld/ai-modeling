/** 保存副本后的素材 ID 读取；失败只报告补读问题，绝不重复已成功的 SaveCanvas。 */
import { StudioClient } from './client.ts';
import { CanvasClient } from './canvas-client.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';

interface SavedNode {
  id: string;
  type: string;
  nodeAssets?: Record<string, unknown>[];
}
interface Rebinding {
  node_id: string;
  from_asset_id: string;
  to_asset_id: string;
}
function assetKind(value: unknown) {
  const kind = text(value).toLowerCase();
  if (!kind || kind === 'asset_kind_unspecified') return '';
  return (
    ['image', 'model', 'text', 'video', 'audio', 'file'].find((candidate) => kind.includes(candidate)) ?? kind
  );
}
function compatible(left: Record<string, unknown>, right: Record<string, unknown>) {
  const a = assetKind(left.kind),
    b = assetKind(right.kind);
  return !a || !b || a === b;
}

/** 按网页唯一 slot / 单对 / selected 配对，不按数组次序臆造新的素材身份。 */
export function matchSavedAssets(nodeId: string, before: unknown[], after: unknown[]) {
  const source = before.map(object).filter((asset) => text(asset.assetId).trim());
  const target = after.map(object).filter((asset) => text(asset.assetId).trim());
  const existing = new Set(target.map((asset) => asset.assetId));
  const unchanged = new Set(
    source.filter((asset) => existing.has(asset.assetId)).map((asset) => asset.assetId),
  );
  const oldAssets = source.filter((asset) => !unchanged.has(asset.assetId));
  const newAssets = target.filter((asset) => !unchanged.has(asset.assetId));
  const usedOld = new Set<Record<string, unknown>>(),
    usedNew = new Set<Record<string, unknown>>();
  const mappings: Rebinding[] = [];
  const bind = (old: Record<string, unknown>, current: Record<string, unknown>) => {
    if (
      !compatible(old, current) ||
      source.filter((asset) => asset.assetId === old.assetId).length !== 1 ||
      target.filter((asset) => asset.assetId === current.assetId).length !== 1
    )
      return;
    usedOld.add(old);
    usedNew.add(current);
    mappings.push({
      node_id: nodeId,
      from_asset_id: text(old.assetId),
      to_asset_id: text(current.assetId),
    });
  };
  const slots = new Set(
    [...oldAssets, ...newAssets].map((asset) => asset.slotIndex).filter((slot) => Number.isInteger(slot)),
  );
  for (const slot of slots) {
    const old = oldAssets.filter((asset) => !usedOld.has(asset) && asset.slotIndex === slot);
    const current = newAssets.filter((asset) => !usedNew.has(asset) && asset.slotIndex === slot);
    if (old.length === 1 && current.length === 1) bind(old[0]!, current[0]!);
  }
  const old = oldAssets.filter((asset) => !usedOld.has(asset));
  const current = newAssets.filter((asset) => !usedNew.has(asset));
  if (old.length === 1 && current.length === 1) bind(old[0]!, current[0]!);
  else {
    const selectedOld = old.filter((asset) => asset.selected === true);
    const selectedNew = current.filter((asset) => asset.selected === true);
    if (selectedOld.length === 1 && selectedNew.length === 1) bind(selectedOld[0]!, selectedNew[0]!);
  }
  return {
    mappings,
    unresolved: oldAssets
      .filter((asset) => !usedOld.has(asset))
      .map((asset) => ({
        node_id: nodeId,
        from_asset_id: text(asset.assetId),
        reason: 'no_unique_compatible_result',
      })),
  };
}

function candidates(nodes: SavedNode[]) {
  const excluded = new Set(['NODE_TYPE_SECTION', 'NODE_TYPE_UPLOAD_CARD', 'NODE_TYPE_AI_3D_LAB']);
  const generated = nodes.filter((node) => !excluded.has(node.type));
  const copied = generated.filter((node) =>
    node.nodeAssets?.some((asset) => text(asset.nodeId) && asset.nodeId !== node.id && text(asset.assetId)),
  );
  // GetCanvas 简略资产经常省略 nodeId；只有明确不同的来源才证明是副本。
  // graph-edit 在复制时补上已知来源，普通 Save 不误报未决或增加额外读取。
  return copied;
}

export async function readSavedAssetRebindings(studio: StudioClient, nodes: SavedNode[]) {
  const copied = candidates(nodes);
  if (!copied.length) return {};
  const mappings: Rebinding[] = [];
  const unresolved: { node_id: string; from_asset_id: string; reason: string }[] = [];
  const signal = AbortSignal.timeout(5000);
  const client = new CanvasClient(
    new StudioClient(
      studio.credentials,
      (url, init) =>
        studio.fetcher(url, {
          ...init,
          signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
        }),
      studio.origin,
    ),
  );
  let failed = false;
  let errorCode = 'ASSET_READBACK_FAILED';
  for (let offset = 0; offset < copied.length; offset += 100) {
    const batch = copied.slice(offset, offset + 100);
    try {
      signal.throwIfAborted();
      const result = object(
        await client.call('/tripo.canvas.api.agent.NodeService/ListNodesAssets', {
          nodeIds: batch.map((node) => node.id),
        }),
      );
      const observed = array(result.nodes).map(object);
      const resolved = [];
      for (const node of batch) {
        const matches = observed.filter((output) => output.nodeId === node.id);
        if (
          matches.length !== 1 ||
          array(matches[0]?.assets).some((asset) => object(asset).nodeId && object(asset).nodeId !== node.id)
        )
          throw new TripoError('CONTRACT_CHANGED', 'Saved node asset identity could not be verified.');
        resolved.push(matchSavedAssets(node.id, node.nodeAssets ?? [], array(matches[0]!.assets)));
      }
      for (const result of resolved) {
        mappings.push(...result.mappings);
        unresolved.push(...result.unresolved);
      }
    } catch (error) {
      failed = true;
      if (error instanceof TripoError && error.code === 'ACCOUNT_MISMATCH') errorCode = error.code;
      unresolved.push(
        ...batch.map((node) => ({ node_id: node.id, from_asset_id: '', reason: 'asset_readback_failed' })),
      );
    }
  }
  return {
    asset_rebindings: mappings,
    asset_rebinding_unresolved: unresolved,
    ...(failed
      ? {
          asset_rebinding_error: {
            code: errorCode,
            message: 'Canvas was saved. Read node-assets to resolve copied assets; do not repeat SaveCanvas.',
          },
        }
      : {}),
  };
}
