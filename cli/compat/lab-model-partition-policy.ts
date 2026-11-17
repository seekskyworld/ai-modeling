/** 投影分组原件仍须保留原mask与.002法线义务；网页表示的量化证明另存，不放宽它。 */
import { isDeepStrictEqual } from 'node:util';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';

export interface LabModelPartitionExpectation {
  groups: string[];
  faces: Record<string, number>;
}
export interface LabModelPartitionProof {
  version: 1;
  matched_groups: number;
  wrong_group_faces: 0;
  groups: {
    name: string;
    faces: number;
    original_oriented_faces_sha256: string;
    studio_oriented_faces_sha256: string;
    correspondence_sha256: string;
  }[];
}
const fail = (): never => {
  throw new TripoError(
    'LAB_MODEL_PARTITION_UNVERIFIED',
    'The projected Lab source has no complete, unchanged mask/group/original-precision proof.',
    'read',
  );
};
export function labModelPartitionExpectation(proof: Record<string, unknown>): LabModelPartitionExpectation {
  const v = object(proof.validation),
    output = object(v.output),
    groups = array(v.groups).map(text).sort(),
    expected = object(v.expected_group_faces),
    actual = object(v.actual_group_faces);
  if (
    groups.length < 2 ||
    groups.length > 8 ||
    new Set(groups).size !== groups.length ||
    groups.some((name) => !/^mask_[a-f0-9]{6}$/.test(name)) ||
    !isDeepStrictEqual(Object.keys(expected).sort(), groups) ||
    !isDeepStrictEqual(expected, actual)
  )
    return fail();
  const faces = Object.fromEntries(groups.map((name) => [name, Number(expected[name])]));
  if (
    Object.values(faces).some((count) => !Number.isSafeInteger(count) || count <= 0) ||
    Object.values(faces).reduce((sum, count) => sum + count, 0) !== output.faces ||
    output.faces !== v.matched_original_faces ||
    output.sha256 !== proof.sha256 ||
    output.bytes !== proof.bytes ||
    !validOriginalPrecision(v)
  )
    return fail();
  return { groups, faces };
}
function validOriginalPrecision(v: Record<string, unknown>): boolean {
  return (
    v.status === 'verified' &&
    v.vertex_tolerance === 0.00004 &&
    v.normal_tolerance_radians === 0.002 &&
    typeof v.max_vertex_error === 'number' &&
    v.max_vertex_error >= 0 &&
    v.max_vertex_error <= 0.00004 &&
    typeof v.max_normal_angle_radians === 'number' &&
    v.max_normal_angle_radians >= 0 &&
    v.max_normal_angle_radians <= 0.002 &&
    v.missing_faces === 0 &&
    v.wrong_group_faces === 0 &&
    v.native_v2_engine === false &&
    v.camera_inferred === false &&
    v.semantic_labels_inferred === false &&
    v.assignment === 'original_world_triangle_centroid_nearest_pixel_including_hidden_faces'
  );
}
export function validLabModelPartitionProof(value: unknown, expected: LabModelPartitionExpectation): boolean {
  const p = object(value),
    groups = array(p.groups).map(object);
  return (
    p.version === 1 &&
    p.matched_groups === expected.groups.length &&
    p.wrong_group_faces === 0 &&
    isDeepStrictEqual(
      groups.map((group) => group.name),
      expected.groups,
    ) &&
    groups.every(
      (group) =>
        group.faces === expected.faces[text(group.name)] &&
        ['original_oriented_faces_sha256', 'studio_oriented_faces_sha256', 'correspondence_sha256'].every(
          (key) => /^[a-f0-9]{64}$/.test(text(group[key])),
        ),
    )
  );
}
