/** 规范化后逐有向面核组名，而不是只比三个总面数；节点顺序不构成组身份。 */
import { inspectLabReferenceGeometry, type LabReferenceFace } from './lab-reference-edit-geometry.ts';
import {
  labModelCorrespondence,
  normalizedLabModelGeometry,
  verifyLabModelGeometry,
  type LabModelGeometryProof,
} from './lab-model-geometry.ts';
import { validateGlb } from '../../studio/files.ts';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { canonical, fingerprint } from '../core/fingerprint.ts';
import type { LabModelPartitionExpectation, LabModelPartitionProof } from './lab-model-partition-policy.ts';

export interface LabModelPartitionGeometryProof extends Omit<LabModelGeometryProof, 'version'> {
  version: 2;
  partition: LabModelPartitionProof;
}
const fail = (): never => {
  throw new TripoError(
    'LAB_MODEL_PARTITION_UNVERIFIED',
    'The Studio representation changed a projected group name, layout or original oriented-face membership.',
    'read',
  );
};
function checkLayout(bytes: Buffer, expected: LabModelPartitionExpectation): void {
  const json = validateGlb(bytes, true),
    nodes = array(json.nodes).map(object),
    meshes = array(json.meshes).map(object),
    scenes = array(json.scenes),
    roots = array(object(scenes[0]).nodes),
    names = nodes.map((node) => text(node.name)),
    meshIndices = nodes.map((node) => node.mesh);
  if (
    scenes.length !== 1 ||
    nodes.length !== expected.groups.length ||
    meshes.length !== expected.groups.length ||
    roots.length !== expected.groups.length ||
    new Set(names).size !== names.length ||
    new Set(meshIndices).size !== meshIndices.length ||
    roots.some(
      (index, i) => !Number.isInteger(index) || !nodes[Number(index)] || roots.indexOf(index) !== i,
    ) ||
    nodes.some(
      (node) =>
        !expected.groups.includes(text(node.name)) ||
        array(node.children).length > 0 ||
        !Number.isInteger(node.mesh) ||
        array(meshes[Number(node.mesh)]?.primitives).length !== 1,
    )
  )
    return fail();
}
function orientedFace(face: LabReferenceFace): string {
  const rotations = [0, 1, 2].map((rotation) =>
    canonical({
      points: face.points.map((_, i) => face.points[(i + rotation) % 3]),
      normals: face.normals.map((_, i) => face.normals[(i + rotation) % 3]),
      material: face.material,
    }),
  );
  return fingerprint(rotations.sort()[0]);
}
export async function verifyLabModelPartitionGeometry(
  originalBytes: Buffer,
  studioBytes: Buffer,
  expected: LabModelPartitionExpectation,
): Promise<LabModelPartitionGeometryProof> {
  checkLayout(originalBytes, expected);
  checkLayout(studioBytes, expected);
  const base = await verifyLabModelGeometry(originalBytes, studioBytes),
    [original, studio] = await Promise.all([
      inspectLabReferenceGeometry(originalBytes, false),
      inspectLabReferenceGeometry(studioBytes, false),
    ]),
    match = labModelCorrespondence(normalizedLabModelGeometry(original).faces, studio.faces);
  if (
    match.pairs.some((pair) => original.faces[pair.source]!.nodeName !== studio.faces[pair.target]!.nodeName)
  )
    return fail();
  const groups = expected.groups.map((name) => {
    const pairs = match.pairs.filter((pair) => original.faces[pair.source]!.nodeName === name);
    if (
      pairs.length !== expected.faces[name] ||
      studio.faces.filter((face) => face.nodeName === name).length !== pairs.length
    )
      return fail();
    const identities = pairs.map((pair) => ({
      original: orientedFace(original.faces[pair.source]!),
      studio: orientedFace(studio.faces[pair.target]!),
    }));
    return {
      name,
      faces: pairs.length,
      original_oriented_faces_sha256: fingerprint(identities.map((pair) => pair.original).sort()),
      studio_oriented_faces_sha256: fingerprint(identities.map((pair) => pair.studio).sort()),
      correspondence_sha256: fingerprint(identities.map((pair) => `${pair.original}:${pair.studio}`).sort()),
    };
  });
  return {
    ...base,
    version: 2,
    partition: { version: 1, matched_groups: groups.length, wrong_group_faces: 0, groups },
  };
}
