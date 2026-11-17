/** 本地 GLB 读取/解码共用适配层；网页 meshopt 压缩不泄漏给渲染和纹理工具。 */
import { NodeIO, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { readModelInput } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

export async function modelIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
}
export function removeCompression(document: Document): void {
  for (const extension of document.getRoot().listExtensionsUsed())
    if (extension.extensionName === 'EXT_meshopt_compression') extension.dispose();
}
export async function loadGLB(
  file: string,
  roots: string[],
): Promise<{ document: Document; io: NodeIO; sha256: string }> {
  const input = await readModelInput(file, roots);
  if (input.format !== 'glb')
    throw new TripoError('INPUT_FORMAT', 'This local editor requires a self-contained GLB.');
  const io = await modelIO();
  const document = await io.readBinary(input.bytes);
  removeCompression(document);
  return { document, io, sha256: input.sha256 };
}
export async function decodedModel(bytes: Buffer, format: string): Promise<Buffer> {
  if (format !== 'glb' || !bytes.includes(Buffer.from('EXT_meshopt_compression'))) return bytes;
  const io = await modelIO(),
    document = await io.readBinary(bytes);
  removeCompression(document);
  return Buffer.from(await io.writeBinary(document));
}
