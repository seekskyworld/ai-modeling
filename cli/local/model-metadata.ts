/** 网页前端轻量导出的 metadata 对应处理；直接保留 GLB 资源，不使用分割预览的彩色材质。 */
import { z } from 'zod';
import type { Document, Node } from '@gltf-transform/core';
import { mat4 } from 'gl-matrix';
import type { Config } from '../core/config.ts';
import { metadataFields } from '../../studio/contracts/metadata.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { modelUpload } from '../../studio/model-upload.ts';
import { readModelInput } from '../../studio/files.ts';
import { modelIO, removeCompression } from './gltf.ts';
import { localTarget, publishLocal } from './files.ts';

export const localMetadataSchema = z.object(metadataFields).partial().strict();
type Metadata = z.infer<typeof localMetadataSchema>;
const schema = z
  .object({
    model_path: z.string().min(1),
    source_metadata: localMetadataSchema,
    expected_source_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    destination_path: z.string().min(1),
  })
  .strict();

/** 网页按原节点名应用删除/矩阵，最后改名。动画直接写入的 TRS 不能被静态覆盖。 */
function applyNodes(document: Document, metadata: Metadata): void {
  const nodes = document.getRoot().listNodes();
  const affected = new Set([
    ...(metadata.children_deleted ?? []),
    ...Object.keys(metadata.children_transform_matrix ?? {}),
    ...Object.keys(metadata.children_rename ?? {}),
  ]);
  const names = new Set<string>();
  for (const node of nodes)
    if (affected.has(node.getName())) {
      if (names.has(node.getName()))
        throw new TripoError('AMBIGUOUS_PART', 'Metadata names must identify unique source nodes.');
      names.add(node.getName());
    }
  const animated = new Set(
    document
      .getRoot()
      .listAnimations()
      .flatMap((animation) =>
        animation
          .listChannels()
          .filter((c) => c.getTargetPath() !== 'weights')
          .map((c) => c.getTargetNode()),
      ),
  );
  const joints = new Set(
    document
      .getRoot()
      .listSkins()
      .flatMap((skin) => skin.listJoints()),
  );
  for (const node of nodes) {
    const name = node.getName();
    if (metadata.children_deleted?.includes(name)) {
      node.traverse((child) => {
        if (joints.has(child)) throw new TripoError('METADATA_SKIN', 'Cannot remove a joint used by a skin.');
      });
      if (node.getParentNode()) node.getParentNode()!.removeChild(node);
      for (const scene of document.getRoot().listScenes()) scene.removeChild(node);
    }
    const delta = metadata.children_transform_matrix?.[name];
    if (delta) {
      if (animated.has(node) || joints.has(node))
        throw new TripoError(
          'METADATA_ANIMATION',
          'A static delta cannot replace an animated node or joint.',
        );
      const matrix = mat4.multiply(mat4.create(), delta, node.getMatrix());
      node.setMatrix(Array.from(matrix) as ReturnType<Node['getMatrix']>);
      if (node.getMatrix().some((v, i) => !Number.isFinite(v) || Math.abs(v - matrix[i]!) > 1e-5))
        throw new TripoError(
          'METADATA_MATRIX',
          'This delta cannot be preserved as GLTF translation/rotation/scale.',
        );
    }
    const rename = metadata.children_rename?.[name];
    if (rename) node.setName(rename);
  }
  if (
    !document
      .getRoot()
      .listScenes()
      .some((scene) => {
        let visible = false;
        scene.traverse((node) => {
          if (node.getMesh()) visible = true;
        });
        return visible;
      })
  )
    throw new TripoError('EMPTY_MODEL', 'Metadata hides every mesh in the source.');
}

export async function applyModelMetadata(bytes: Buffer, format: string, supplied: unknown): Promise<Buffer> {
  const metadata = localMetadataSchema.parse(supplied);
  const input = await modelUpload(bytes, format);
  const io = await modelIO(),
    document = await io.readBinary(input.bytes);
  removeCompression(document);
  applyNodes(document, metadata);
  for (const material of document.getRoot().listMaterials()) {
    if (metadata.material_factor?.metallic !== undefined)
      material.setMetallicFactor(metadata.material_factor.metallic);
    if (metadata.material_factor?.roughness !== undefined)
      material.setRoughnessFactor(metadata.material_factor.roughness);
  }
  return Buffer.from(await io.writeBinary(document));
}

async function apply(config: Config, input: unknown): Promise<unknown> {
  const x = schema.parse(input);
  const target = await localTarget(config.outputDir, x.destination_path, 'glb');
  const source = await readModelInput(x.model_path, config.inputRoots);
  if (x.expected_source_sha256 && source.sha256 !== x.expected_source_sha256)
    throw new TripoError('SOURCE_CHANGED', 'Metadata belongs to different source bytes.');
  const bytes = await applyModelMetadata(source.bytes, source.format, x.source_metadata);
  return {
    ...(await publishLocal(target, bytes, 'glb')),
    source_sha256: source.sha256,
    processing:
      'Local counterpart of Studio frontend metadata application; original coordinates and materials retained.',
  };
}

export const metadataOperations = [
  {
    name: 'model_metadata_apply',
    description:
      'Apply Studio part transforms, visibility, names and PBR factors to the original GLB locally; keep materials and coordinates.',
    schema,
    run: apply,
  },
];
