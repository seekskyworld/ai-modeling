/** 原件验收只比较分区与原面；不本地重组、修补或替换远端结果。 */
import sharp from '../runtime/sharp.ts';
import { createHash } from 'node:crypto';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { validateGlb } from '../../studio/files.ts';
import {
  inspectLabReferenceGeometry,
  matchLabReferenceFaces,
  type LabReferenceGeometry,
} from './lab-reference-edit-geometry.ts';
import { labReferenceProjectionSchema, type LabReferenceProjection } from './lab-projected-segment-plan.ts';

const fail = (message: string): never => {
  throw new TripoError('LAB_PROJECTED_SEGMENT_UNVERIFIED', message, 'read');
};
interface Mask {
  width: number;
  height: number;
  pixels: Buffer;
  groups: string[];
  sha256: string;
}
async function maskImage(bytes: Buffer): Promise<Mask> {
  const image = sharp(bytes, { limitInputPixels: 4096 * 4096, animated: false }),
    metadata = await image.metadata();
  if (
    metadata.format !== 'png' ||
    metadata.hasAlpha ||
    !metadata.width ||
    !metadata.height ||
    (metadata.pages ?? 1) !== 1
  )
    return fail('The projected mask must be one opaque PNG without an alpha channel.');
  const { data, info } = await image.toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 || info.width > 4096 || info.height > 4096)
    return fail('Projected masks require RGB pixels within 4096×4096.');
  const colors = new Set<string>();
  for (let offset = 0; offset < data.length; offset += 3) {
    const color = data.subarray(offset, offset + 3).toString('hex');
    if (color !== 'ffffff') colors.add(`mask_${color}`);
    if (colors.size > 8)
      return fail(
        'Use 2–8 exact nonwhite mask colors; antialiasing and photographic masks have no verified mapping.',
      );
  }
  if (colors.size < 2) return fail('The reference mask must contain at least two nonwhite partition colors.');
  return {
    width: info.width,
    height: info.height,
    pixels: data,
    groups: [...colors].sort(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
function assignments(source: LabReferenceGeometry, mask: Mask, projection: LabReferenceProjection): string[] {
  if (!labReferenceProjectionSchema.safeParse(projection).success)
    return fail('The original orthographic projection is invalid.');
  const labels = source.faces.map((face) => {
    const pixel = projection.map((row) =>
      Math.floor(
        row[0] * face.centroid[0] + row[1] * face.centroid[1] + row[2] * face.centroid[2] + row[3] + 0.5,
      ),
    );
    const [x, y] = pixel as [number, number];
    if (x < 0 || y < 0 || x >= mask.width || y >= mask.height)
      return fail('Every original triangle centroid must project inside the supplied mask.');
    const offset = (y * mask.width + x) * 3,
      color = mask.pixels.subarray(offset, offset + 3).toString('hex');
    if (color === 'ffffff')
      return fail(
        'A source triangle projects to white background; supply an unambiguous mask and projection.',
      );
    return `mask_${color}`;
  });
  if (mask.groups.some((group) => !labels.includes(group)))
    return fail('Every nonwhite mask color must contain at least one projected source triangle.');
  return labels;
}
const counts = (groups: string[], labels: string[]) =>
  Object.fromEntries(groups.map((group) => [group, labels.filter((label) => label === group).length]));
async function prepared(sourceBytes: Buffer, imageBytes: Buffer, projection: LabReferenceProjection) {
  const [source, mask] = await Promise.all([inspectLabReferenceGeometry(sourceBytes), maskImage(imageBytes)]);
  const labels = assignments(source, mask, projection);
  return { source, mask, labels };
}
export async function labProjectedSegmentSourceSummary(
  sourceBytes: Buffer,
  imageBytes: Buffer,
  projection: LabReferenceProjection,
): Promise<Record<string, unknown>> {
  const { source, mask, labels } = await prepared(sourceBytes, imageBytes, projection);
  return {
    sha256: source.sha256,
    bytes: source.bytes,
    faces: source.faces.length,
    bounds: source.bounds,
    projection,
    reference_sha256: mask.sha256,
    width: mask.width,
    height: mask.height,
    groups: mask.groups,
    group_faces: counts(mask.groups, labels),
    assignment_sha256: createHash('sha256').update(JSON.stringify(labels)).digest('hex'),
  };
}
function checkLayout(bytes: Buffer, groups: string[]): void {
  const json = validateGlb(bytes, true),
    nodes = array(json.nodes),
    meshes = array(json.meshes),
    scenes = array(json.scenes);
  const roots = array(object(scenes[0]).nodes),
    names = nodes.map((n) => text(object(n).name)),
    meshIndices = nodes.map((n) => object(n).mesh);
  if (
    scenes.length !== 1 ||
    roots.length !== groups.length ||
    nodes.length !== groups.length ||
    meshes.length !== groups.length ||
    new Set(names).size !== groups.length ||
    new Set(meshIndices).size !== groups.length ||
    roots.some(
      (index, i) => !Number.isInteger(index) || !nodes[Number(index)] || roots.indexOf(index) !== i,
    ) ||
    nodes.some((n) => {
      const node = object(n);
      return (
        !groups.includes(text(node.name)) ||
        array(node.children).length !== 0 ||
        !Number.isInteger(node.mesh) ||
        array(object(meshes[Number(node.mesh)]).primitives).length !== 1
      );
    })
  )
    return fail(
      'The remote partition must retain one nonempty root node, mesh and triangle primitive per mask color.',
    );
}
export async function verifyLabProjectedSegment(
  sourceBytes: Buffer,
  imageBytes: Buffer,
  outputBytes: Buffer,
  projection: LabReferenceProjection,
): Promise<Record<string, unknown>> {
  const { source, mask, labels } = await prepared(sourceBytes, imageBytes, projection);
  const output = await inspectLabReferenceGeometry(outputBytes, false);
  checkLayout(outputBytes, mask.groups);
  const proof = matchLabReferenceFaces(source.faces, output.faces);
  const wrong = proof.pairs.filter(
    (pair) => labels[pair.source] !== output.faces[pair.output]!.nodeName,
  ).length;
  if (
    proof.missing ||
    proof.ambiguous ||
    proof.normalFailures ||
    proof.materialFailures ||
    proof.used.size !== output.faces.length ||
    wrong ||
    output.faces.some((face) => face.material !== 'default')
  )
    return fail(
      'The actual Lab model changed, added or omitted original oriented triangles/normals/materials, or assigned a triangle to the wrong reference-image color. Preserve the original request; do not regenerate.',
    );
  const actualLabels = output.faces.map((face) => face.nodeName!);
  return {
    version: 1,
    status: 'verified',
    source: { sha256: source.sha256, bytes: source.bytes, faces: source.faces.length },
    output: { sha256: output.sha256, bytes: output.bytes, faces: output.faces.length },
    projection,
    reference_sha256: mask.sha256,
    width: mask.width,
    height: mask.height,
    groups: mask.groups,
    expected_group_faces: counts(mask.groups, labels),
    actual_group_faces: counts(mask.groups, actualLabels),
    matched_original_faces: proof.used.size,
    missing_faces: proof.missing,
    wrong_group_faces: wrong,
    max_vertex_error: proof.maxVertex,
    max_normal_angle_radians: proof.maxNormal,
    vertex_tolerance: 0.00004,
    normal_tolerance_radians: 0.002,
    assignment: 'original_world_triangle_centroid_nearest_pixel_including_hidden_faces',
    camera_inferred: false,
    semantic_labels_inferred: false,
    native_v2_engine: false,
    backend: 'studio_lab',
  };
}
