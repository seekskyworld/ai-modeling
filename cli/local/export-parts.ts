/** 按原始 GLB 的名称筛选网格；保留节点层级、骨骼及动画，避免 Blender 重命名导致误选。 */
import { modelUpload } from '../../studio/model-upload.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { modelIO, removeCompression } from './gltf.ts';

/** 名称必须匹配真实网格或带网格的节点；缺失时拒绝，不能输出空模型或偷偷导出整模。 */
export async function selectExportParts(bytes: Buffer, format: string, names: string[]): Promise<Buffer> {
  const input = await modelUpload(bytes, format);
  const io = await modelIO(),
    document = await io.readBinary(input.bytes);
  removeCompression(document);
  const nodes = document
    .getRoot()
    .listNodes()
    .filter((node) => node.getMesh());
  const matches = (node: (typeof nodes)[number], name: string): boolean =>
    node.getName() === name || node.getMesh()?.getName() === name;
  const missing = names.filter((name) => !nodes.some((node) => matches(node, name)));
  if (missing.length)
    throw new TripoError('INVALID_PART', `No exported mesh/node matches: ${missing.join(', ')}`, 'read');
  for (const node of nodes) if (!names.some((name) => matches(node, name))) node.setMesh(null).setSkin(null);
  // 保留父级变换和关节；只释放已无实例的网格，不能 dispose 带选中子节点的父节点。
  const used = new Set(
    document
      .getRoot()
      .listNodes()
      .map((node) => node.getMesh()),
  );
  for (const mesh of document.getRoot().listMeshes()) if (!used.has(mesh)) mesh.dispose();
  return Buffer.from(await io.writeBinary(document));
}
