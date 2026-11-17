/** 单轴剪切只分成两段正TRS；新轴共轭原XY代数，不修改原件或按远端结果拟合。 */
import { TripoError } from '../../studio/contracts/errors.ts';
import { checkedMetadataTransform } from './smartsegment-transform-matrix.ts';
import {
  checkedGeneralAffine,
  decomposeGeneralAffine,
  type GeneralAffine,
} from './smartsegment-affine-svd.ts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const smartSegmentAffineTolerance = 0.00004;
const fail = (message: string): never => {
  throw new TripoError('SMARTSEGMENT_TRANSFORM_UNVERIFIED', message, 'not_submitted');
};
type AxisShearFamily = 'xz' | 'yx' | 'yz' | 'zx' | 'zy';
type AxisShear = { matrix: number[]; k: number; family?: AxisShearFamily };
const axisShears: ReadonlyArray<readonly [number, AxisShearFamily]> = [
  [8, 'xz'],
  [1, 'yx'],
  [9, 'yz'],
  [2, 'zx'],
  [6, 'zy'],
];
export function checkedSmartSegmentAffine(value: unknown): AxisShear | GeneralAffine {
  if (
    !Array.isArray(value) ||
    value.length !== 16 ||
    Array.from(value).some((v) => typeof v !== 'number' || !Number.isFinite(v))
  )
    return fail('Native axis shear requires a complete finite column-major 4×4 matrix.');
  const changed = value.flatMap((v, i) => (v !== identity[i] ? [i] : [])),
    index = changed[0],
    selected = axisShears.find(([i]) => i === index);
  if (changed.length !== 1 || (index !== 4 && !selected)) return checkedGeneralAffine(value);
  if (Math.abs(value[index!]) < 0.01 || Math.abs(value[index!]) > 1) return checkedGeneralAffine(value);
  // XY的既有持久化对象不能因新family字段而改变。
  return index === 4
    ? { matrix: [...value], k: value[4] }
    : { matrix: [...value], k: value[index!], family: selected![1] };
}
export function affineMatrixProduct(left: number[], right: number[]): number[] {
  return Array.from({ length: 16 }, (_, i) =>
    [0, 1, 2, 3].reduce((sum, k) => sum + left[(i % 4) + 4 * k]! * right[k + 4 * Math.floor(i / 4)]!, 0),
  );
}
export function decomposeSmartSegmentAffine(
  value: unknown,
  positions: readonly (readonly number[])[],
): (AxisShear | GeneralAffine) & { first_matrix: number[]; second_matrix: number[] } {
  const selected = checkedSmartSegmentAffine(value);
  if (selected.family === 'general') return decomposeGeneralAffine(selected, positions);
  if (selected.family) return decomposeAxisShear(selected, positions);
  return decomposeXYShear(selected, positions);
}
// 原XY计算顺序和返回字段保留，保证旧准备指纹与真实回执逐字节可恢复。
function decomposeXYShear(
  selected: AxisShear,
  positions: readonly (readonly number[])[],
): AxisShear & { first_matrix: number[]; second_matrix: number[] } {
  const { matrix, k } = selected,
    theta = 0.5 * Math.atan2(2 * k, -k * k),
    c = Math.cos(theta),
    s = Math.sin(theta),
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  if (!positions.length || positions.length > 75000)
    return fail('Affine source coordinates exceed the bounded triangle budget.');
  for (const point of positions) {
    if (point.length !== 3 || point.some((v) => !Number.isFinite(v)))
      return fail('Affine preparation requires complete finite original source coordinates.');
    const rotated = [c * point[0]! + s * point[1]!, -s * point[0]! + c * point[1]!, point[2]!];
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, rotated[i]!);
      max[i] = Math.max(max[i]!, rotated[i]!);
    }
  }
  const extent = Math.max(...max.map((v, i) => v - min[i]!)),
    center = min.map((v, i) => (v + max[i]!) / 2);
  if (!Number.isFinite(extent) || extent <= 0)
    return fail('Affine source cannot have a zero or nonfinite extent.');
  const first = [
      c / extent,
      -s / extent,
      0,
      0,
      s / extent,
      c / extent,
      0,
      0,
      0,
      0,
      1 / extent,
      0,
      -center[0]! / extent,
      -center[1]! / extent,
      -center[2]! / extent,
      1,
    ],
    inverse = [
      c * extent,
      s * extent,
      0,
      0,
      -s * extent,
      c * extent,
      0,
      0,
      0,
      0,
      extent,
      0,
      c * center[0]! - s * center[1]!,
      s * center[0]! + c * center[1]!,
      center[2]!,
      1,
    ],
    second = affineMatrixProduct(matrix, inverse),
    composed = affineMatrixProduct(second, first);
  checkedMetadataTransform(first);
  checkedMetadataTransform(second);
  if (composed.some((v, i) => Math.abs(v - matrix[i]!) > 1e-14))
    return fail('The deterministic native TRS factors do not reproduce the original affine request.');
  return { matrix, k, first_matrix: first, second_matrix: second };
}

function decomposeAxisShear(
  selected: AxisShear,
  positions: readonly (readonly number[])[],
): AxisShear & { first_matrix: number[]; second_matrix: number[] } {
  if (!positions.length || positions.length > 75000)
    return fail('Affine source coordinates exceed the bounded triangle budget.');
  const index = axisShears.find(([, family]) => family === selected.family)![0],
    target = index % 4,
    input = Math.floor(index / 4),
    remaining = [0, 1, 2].find((i) => i !== target && i !== input)!,
    axes = [target, input, remaining];
  // 只给原分解器排列内存中的坐标；不构造或重写任何模型字节。
  const canonical = decomposeXYShear(
    { matrix: identity.map((v, i) => (i === 4 ? selected.k : v)), k: selected.k },
    positions.map((point) => {
      if (point.length !== 3 || Array.from(point).some((v) => !Number.isFinite(v)))
        return fail('Affine preparation requires complete finite original source coordinates.');
      return axes.map((i) => point[i]!);
    }),
  );
  const conjugate = (matrix: number[]): number[] => {
    const result = [...identity];
    for (let column = 0; column < 3; column++)
      for (let row = 0; row < 3; row++) result[axes[row]! + 4 * axes[column]!] = matrix[row + 4 * column]!;
    for (let row = 0; row < 3; row++) result[12 + axes[row]!] = matrix[12 + row]!;
    return result;
  };
  const first = conjugate(canonical.first_matrix),
    second = conjugate(canonical.second_matrix),
    composed = affineMatrixProduct(second, first);
  checkedMetadataTransform(first);
  checkedMetadataTransform(second);
  if (composed.some((v, i) => Math.abs(v - selected.matrix[i]!) > 1e-14))
    return fail('The deterministic axis TRS factors do not reproduce the original affine request.');
  return { ...selected, first_matrix: first, second_matrix: second };
}
