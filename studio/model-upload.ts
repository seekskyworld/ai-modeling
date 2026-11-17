/** 网页导入接口只收 GLB 等二进制格式；自包含文本 glTF 在上传前转换，不读取外部依赖。 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { detectFormat } from './files.ts';
import { TripoError } from './contracts/errors.ts';

export async function modelUpload(bytes: Buffer, format: string): Promise<{ bytes: Buffer; format: string }> {
  if (format !== 'gltf') return { bytes, format };
  detectFormat(bytes);
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  try {
    const doc = await io.readJSON({ json: JSON.parse(bytes.toString('utf8')), resources: {} });
    for (const extension of doc.getRoot().listExtensionsUsed())
      if (extension.extensionName === 'EXT_meshopt_compression') extension.dispose();
    const buffers = doc.getRoot().listBuffers();
    for (const accessor of doc.getRoot().listAccessors()) accessor.setBuffer(buffers[0]!);
    for (const buffer of buffers.slice(1)) buffer.dispose();
    return { bytes: Buffer.from(await io.writeBinary(doc)), format: 'glb' };
  } catch {
    throw new TripoError(
      'INPUT_FORMAT',
      'Cannot convert this self-contained glTF to GLB. Export a GLB from the authoring tool.',
    );
  }
}
