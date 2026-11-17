/** 将网页浏览器的 UV 布局下载、利用率与岛拾取封装为独立工具；不提交 UV 生成任务。 */
import { z } from 'zod';
import { vec3 } from 'gl-matrix';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Config } from '../core/config.ts';
import type { LocalSpec } from './operations.ts';
import { localTarget, publishLocal } from './files.ts';
import { loadGLB } from './gltf.ts';
import { uvGeometry, uvIslands } from './uv-geometry.ts';
import { containsUv, uvTriangle, rasterizeUv, renderUv, UV_RESOLUTION } from './uv-raster.ts';

const source = {
  model_path: z
    .string()
    .min(1)
    .describe('Self-contained GLB with existing UV coordinates; no unwrap is performed.'),
  mesh_names: z
    .array(z.string().min(1))
    .min(1)
    .max(256)
    .optional()
    .describe('Exact visible mesh node names; omit to inspect all meshes in the default scene.'),
};
const inspectSchema = z
  .object({
    ...source,
    pick: z.object({ u: z.number().finite(), v: z.number().finite() }).strict().optional(),
    ray: z
      .object({
        origin: z.tuple([z.number(), z.number(), z.number()]),
        direction: z.tuple([z.number(), z.number(), z.number()]),
      })
      .strict()
      .optional()
      .describe('Nearest 3D surface pick in GLB world coordinates, at the stored pose.'),
  })
  .strict()
  .refine((x) => !(x.pick && x.ray), 'Choose a UV point or a 3D ray.');
const layoutSchema = z
  .object({
    ...source,
    destination_path: z.string().min(1),
    highlight_island: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Optional viewer highlight; omit for the webpage Download output.'),
  })
  .strict();
const previewSchema = z
  .object({ ...source, destination_path: z.string().min(1), island_id: z.number().int().nonnegative() })
  .strict();

async function prepare(config: Config, input: z.infer<typeof inspectSchema>) {
  const geometry = await uvGeometry(input.model_path, config.inputRoots, input.mesh_names);
  const atlas = uvIslands(geometry),
    raster = rasterizeUv(geometry);
  return { geometry, atlas, raster };
}
function summary(prepared: Awaited<ReturnType<typeof prepare>>) {
  const { geometry, atlas, raster } = prepared;
  return {
    source_sha256: geometry.sha256,
    meshes: geometry.meshes,
    skipped_meshes: geometry.skipped_meshes,
    triangles: geometry.indices.length / 3,
    islands: atlas.islands,
    utilization: raster.utilization,
    resolution: UV_RESOLUTION,
    processing: 'local equivalent of browser UV viewer; no Studio generation',
    pixel_equivalent: false,
    pose: 'Stored node transforms and morph weights; animation tracks are not sampled.',
  };
}
async function inspect(config: Config, input: unknown) {
  const x = inspectSchema.parse(input),
    prepared = await prepare(config, x);
  let picked: { face_index: number; island: number } | null = null;
  if (x.pick && x.pick.u >= 0 && x.pick.u < 1 && x.pick.v >= 0 && x.pick.v < 1) {
    for (let face = 0; face < prepared.atlas.faceIslands.length; face++) {
      if (containsUv(uvTriangle(prepared.geometry, face), x.pick.u, x.pick.v)) {
        picked = { face_index: face, island: prepared.atlas.faceIslands[face]! };
        break;
      }
    }
  }
  if (x.ray) {
    const face = rayFace(prepared.geometry, x.ray);
    if (face !== null) picked = { face_index: face, island: prepared.atlas.faceIslands[face]! };
  }
  return { ...summary(prepared), ...(x.pick || x.ray ? { picked } : {}) };
}

/** Möller–Trumbore 最近交点；只在已有 UV 的原三角面上查找，不生成新网格。 */
function rayFace(
  geometry: Awaited<ReturnType<typeof uvGeometry>>,
  ray: NonNullable<z.infer<typeof inspectSchema>['ray']>,
): number | null {
  if (!vec3.length(ray.direction)) throw new TripoError('INVALID_INPUT', 'Ray direction must be nonzero.');
  const direction = vec3.normalize(vec3.create(), ray.direction);
  let distance = Infinity,
    selected: number | null = null;
  for (let face = 0; face < geometry.indices.length / 3; face++) {
    const points = geometry.indices
      .slice(face * 3, face * 3 + 3)
      .map((index) => geometry.positions.slice(index * 3, index * 3 + 3));
    const edge1 = vec3.sub(vec3.create(), points[1]!, points[0]!),
      edge2 = vec3.sub(vec3.create(), points[2]!, points[0]!);
    const cross = vec3.cross(vec3.create(), direction, edge2),
      determinant = vec3.dot(edge1, cross);
    if (Math.abs(determinant) < 1e-12) continue;
    const delta = vec3.sub(vec3.create(), ray.origin, points[0]!),
      u = vec3.dot(delta, cross) / determinant;
    if (u < 0 || u > 1) continue;
    const q = vec3.cross(vec3.create(), delta, edge1),
      v = vec3.dot(direction, q) / determinant;
    if (v < 0 || u + v > 1) continue;
    const t = vec3.dot(edge2, q) / determinant;
    if (t >= 0 && t < distance) {
      distance = t;
      selected = face;
    }
  }
  return selected;
}

/** 预览独立输出 GLB，保留 UV/几何并只替换临时材质；正式网页资产不被改变。 */
async function preview(config: Config, input: unknown) {
  const x = previewSchema.parse(input),
    target = await localTarget(config.outputDir, x.destination_path, 'glb');
  const prepared = await prepare(config, x);
  if (x.island_id >= prepared.atlas.islands.length)
    throw new TripoError('INVALID_INPUT', 'Selected UV island is absent.');
  const { document, io, sha256 } = await loadGLB(x.model_path, config.inputRoots);
  if (sha256 !== prepared.geometry.sha256)
    throw new TripoError('INPUT_CHANGED', 'UV source changed while preparing the preview.');
  const buffer = document.getRoot().listBuffers()[0]!,
    scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0]!;
  const ordinary = document
    .createMaterial('uv-preview')
    .setBaseColorFactor([0.3, 0.3, 0.3, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.8);
  const selected = document
    .createMaterial('uv-selected-island')
    .setBaseColorFactor([0.99, 0.5, 0.002, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.8);
  let face = 0;
  scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh || (x.mesh_names && !x.mesh_names.includes(node.getName()))) return;
    const replacement = document.createMesh(mesh.getName());
    replacement.setWeights(mesh.getWeights());
    for (const primitive of mesh.listPrimitives()) {
      if (!primitive.getAttribute('TEXCOORD_0')) {
        replacement.addPrimitive(primitive.clone().setMaterial(ordinary));
        continue;
      }
      const indices = primitive.getIndices(),
        count = indices?.getCount() ?? primitive.getAttribute('POSITION')!.getCount();
      const groups: number[][] = [[], []];
      for (let i = 0; i < count; i += 3, face++) {
        const group = prepared.atlas.faceIslands[face] === x.island_id ? 1 : 0;
        for (let j = 0; j < 3; j++) groups[group]!.push(indices ? indices.getScalar(i + j) : i + j);
      }
      groups.forEach((values, index) => {
        if (values.length)
          replacement.addPrimitive(
            primitive
              .clone()
              .setIndices(
                document
                  .createAccessor()
                  .setType('SCALAR')
                  .setArray(new Uint32Array(values))
                  .setBuffer(buffer),
              )
              .setMaterial(index ? selected : ordinary),
          );
      });
    }
    node.setMesh(replacement);
  });
  for (const mesh of document.getRoot().listMeshes())
    if (
      !document
        .getRoot()
        .listNodes()
        .some((node) => node.getMesh() === mesh)
    )
      mesh.dispose();
  return {
    ...(await publishLocal(target, Buffer.from(await io.writeBinary(document)), 'glb')),
    ...summary(prepared),
    highlighted_island: x.island_id,
    preview_only: true,
  };
}
async function layout(config: Config, input: unknown) {
  const x = layoutSchema.parse(input),
    target = await localTarget(config.outputDir, x.destination_path, 'png');
  const prepared = await prepare(config, x);
  if (x.highlight_island !== undefined && x.highlight_island >= prepared.atlas.islands.length)
    throw new TripoError('INVALID_INPUT', 'Selected UV island is absent.');
  const selected =
    x.highlight_island === undefined
      ? undefined
      : new Set(prepared.atlas.faceIslands.flatMap((id, face) => (id === x.highlight_island ? [face] : [])));
  const bytes = await renderUv(prepared.geometry, prepared.raster, selected);
  return {
    ...(await publishLocal(target, bytes, 'png')),
    ...summary(prepared),
    highlighted_island: x.highlight_island,
  };
}
export const uvOperations: LocalSpec[] = [
  {
    name: 'uv_preview',
    description: 'save a separate GLB preview highlighting one UV island on the 3D model',
    schema: previewSchema,
    run: preview,
  },
  {
    name: 'uv_inspect',
    description: 'inspect existing UV islands and utilization, optionally pick by UV coordinates or a 3D ray',
    schema: inspectSchema,
    readOnly: true,
    run: inspect,
  },
  {
    name: 'uv_layout',
    description:
      'export the current UV layout as a 1024px PNG locally, matching the browser UV Download function',
    schema: layoutSchema,
    run: layout,
  },
];
