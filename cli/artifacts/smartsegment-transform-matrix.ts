/** 规划与最终原件证明共用网页 TRS 范围；不分解重写请求、不接纳 shear/reflection。 */
import { TripoError } from '../../studio/contracts/errors.ts';

export type MetadataTransform = {
  matrix: number[];
  scales: [number, number, number];
  tolerance: number;
};

const fail = (message: string): never => {
  throw new TripoError('SMARTSEGMENT_TRANSFORM_UNVERIFIED', message, 'not_submitted');
};
const dot = (a: number[], b: number[]): number => a.reduce((sum, value, i) => sum + value * b[i]!, 0);

export function checkedMetadataTransform(value: unknown): MetadataTransform {
  if (
    !Array.isArray(value) ||
    value.length !== 16 ||
    Array.from(value).some((v) => typeof v !== 'number' || !Number.isFinite(v))
  )
    return fail('Metadata transformation requires a finite column-major affine 4×4 matrix.');
  const matrix: number[] = [...value];
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1)
    return fail('Metadata transformation requires affine last row [0,0,0,1]; projection is unsupported.');
  const columns = [0, 1, 2].map((i) => matrix.slice(i * 4, i * 4 + 3));
  const scales = columns.map((column) => Math.hypot(...column)) as [number, number, number];
  if (scales.some((scale) => scale < 0.01 || scale > 100))
    return fail('The verified static TRS route currently supports each positive scale from 0.01 to 100.');
  const unit = columns.map((column, i) => column.map((v) => v / scales[i]!));
  if (
    Math.abs(dot(unit[0]!, unit[1]!)) > 1e-7 ||
    Math.abs(dot(unit[0]!, unit[2]!)) > 1e-7 ||
    Math.abs(dot(unit[1]!, unit[2]!)) > 1e-7
  )
    return fail('Metadata transformation requires orthogonal rotation columns; shear is not verified.');
  const [a, b, c] = unit as [number[], number[], number[]];
  const determinant =
    (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) -
      b[0]! * (a[1]! * c[2]! - a[2]! * c[1]!) +
      c[0]! * (a[1]! * b[2]! - a[2]! * b[1]!)) *
    scales[0] *
    scales[1] *
    scales[2];
  if (determinant < 1e-8)
    return fail(
      'Metadata transformation requires a proper rotation and positive nonsingular scale; reflection is unsupported.',
    );
  const tolerance = 0.00004 * Math.max(1, ...scales);
  // 巨大但有限的平移也可能吞掉整个单元模型，不能在付费后才发现 double 无法表达目标。
  if (Math.max(...matrix.slice(12, 15).map(Math.abs)) * Number.EPSILON > tolerance / 1000)
    return fail(
      'Translation is too large to verify the requested geometry within the declared coordinate tolerance.',
    );
  return { matrix, scales, tolerance };
}
