/** 新仿射族采用独立确定性谱分解；不改变旧XY/六轴准备对象或写入模型顶点。 */
import { TripoError } from '../../studio/contracts/errors.ts';
import { checkedMetadataTransform } from './smartsegment-transform-matrix.ts';

export type GeneralAffine = { matrix: number[]; family: 'general'; k?: never };
type Basis = { right: number[]; singular: number[] };
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fail = (message: string): never => {
  throw new TripoError('SMARTSEGMENT_TRANSFORM_UNVERIFIED', message, 'not_submitted');
};
const determinant = (a: number[][]): number =>
  a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) -
  a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) +
  a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!);

function rotateGram(g: number[][], v: number[][], p: number, q: number): void {
  const tau = (g[q]![q]! - g[p]![p]!) / (2 * g[p]![q]!),
    t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.hypot(1, tau)),
    c = 1 / Math.hypot(1, t),
    s = t * c,
    off = g[p]![q]!;
  g[p]![p]! -= t * off;
  g[q]![q]! += t * off;
  g[p]![q] = g[q]![p] = 0;
  for (let k = 0; k < 3; k++) {
    if (k !== p && k !== q) {
      const x = g[k]![p]!,
        y = g[k]![q]!;
      g[k]![p] = g[p]![k] = c * x - s * y;
      g[k]![q] = g[q]![k] = s * x + c * y;
    }
    const x = v[k]![p]!,
      y = v[k]![q]!;
    v[k]![p] = c * x - s * y;
    v[k]![q] = s * x + c * y;
  }
}
function canonicalBasis(g: number[][], v: number[][]): Basis {
  const order = [0, 1, 2].sort((x, y) => g[y]![y]! - g[x]![x]! || x - y),
    basis = v.map((row) => order.map((i) => row[i]!));
  for (let col = 0; col < 3; col++) {
    const pivot = [0, 1, 2].sort(
      (x, y) => Math.abs(basis[y]![col]!) - Math.abs(basis[x]![col]!) || x - y,
    )[0]!;
    if (basis[pivot]![col]! < 0) for (let row = 0; row < 3; row++) basis[row]![col]! *= -1;
  }
  // 重复谱的符号/次序也固定；保证两个网页因子都只有正旋转与正尺度。
  if (determinant(basis) < 0) for (let row = 0; row < 3; row++) basis[row]![2]! *= -1;
  const right = [...identity];
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) right[row + 4 * col] = basis[col]![row]!;
  return { right, singular: order.map((i) => Math.sqrt(g[i]![i]!)) };
}
function rightBasis(matrix: number[]): Basis {
  const a = Array.from({ length: 3 }, (_, row) =>
      Array.from({ length: 3 }, (_, col) => matrix[row + 4 * col]!),
    ),
    det = determinant(a);
  if (!Number.isFinite(det) || det <= 0)
    return fail('General native affine segmentation requires a positive nonsingular determinant.');
  const gram = Array.from({ length: 3 }, (_, row) =>
      Array.from({ length: 3 }, (_, col) => a.reduce((sum, line) => sum + line[row]! * line[col]!, 0)),
    ),
    v = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  if (gram.flat().some((value) => !Number.isFinite(value)))
    return fail('General affine coefficients exceed the finite decomposition range.');
  for (let iteration = 0; iteration < 96; iteration++) {
    const [p, q] = [
      [0, 1],
      [0, 2],
      [1, 2],
    ].sort(([i, j], [k, l]) => Math.abs(gram[k!]![l!]!) - Math.abs(gram[i!]![j!]!))[0]!;
    if (
      Math.abs(gram[p!]![q!]!) <=
      Number.EPSILON * 4 * Math.max(1, ...gram.map((row, i) => Math.abs(row[i]!)))
    )
      return canonicalBasis(gram, v);
    rotateGram(gram, v, p!, q!);
  }
  return fail('General affine decomposition did not converge within its fixed work bound.');
}
function checkedBasis(matrix: number[]): Basis {
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1)
    return fail('General native affine requires the exact last row [0,0,0,1]; projection is unsupported.');
  // 最终证明固定4e-5：不得借第二段的大尺度放宽原始A(P)的可表达精度。
  if (Math.max(...matrix.slice(12, 15).map(Math.abs)) * Number.EPSILON > 0.00004 / 1000)
    return fail('General native affine translation cannot preserve the fixed final coordinate precision.');
  const basis = rightBasis(matrix);
  if (basis.singular.some((s) => !Number.isFinite(s) || s <= 0))
    return fail('General native affine singular values must be finite and strictly positive.');
  return basis;
}
export function checkedGeneralAffine(matrix: number[]): GeneralAffine {
  checkedBasis(matrix);
  let ordinary = false;
  try {
    checkedMetadataTransform(matrix);
    ordinary = true;
  } catch (error) {
    if (!(error instanceof TripoError) || error.code !== 'SMARTSEGMENT_TRANSFORM_UNVERIFIED') throw error;
  }
  if (ordinary) return fail('A proper ordinary TRS must retain its existing native metadata route.');
  return { matrix: [...matrix], family: 'general' };
}
function normalization(right: number[], positions: readonly (readonly number[])[]) {
  if (!positions.length || positions.length > 75000)
    return fail('General affine source exceeds the bounded triangle budget.');
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const point of positions) {
    if (point.length !== 3 || Array.from(point).some((v) => !Number.isFinite(v)))
      return fail('General affine preparation requires complete finite original source coordinates.');
    for (let row = 0; row < 3; row++) {
      const value = right[row]! * point[0]! + right[row + 4]! * point[1]! + right[row + 8]! * point[2]!;
      min[row] = Math.min(min[row]!, value);
      max[row] = Math.max(max[row]!, value);
    }
  }
  const extent = Math.max(...max.map((v, i) => v - min[i]!));
  if (!Number.isFinite(extent) || extent <= 0) return fail('General affine source has invalid bounds.');
  return { extent, center: min.map((v, i) => (v + max[i]!) / 2) };
}
export function decomposeGeneralAffine(selected: GeneralAffine, positions: readonly (readonly number[])[]) {
  const { right } = checkedBasis(selected.matrix),
    { extent, center } = normalization(right, positions),
    first = right.map((value, i) => (i === 15 ? 1 : i >= 12 ? -center[i - 12]! / extent : value / extent)),
    inverse = [...identity];
  // 已知正旋转的解析逆保持精确仿射末行，不用一般逆矩阵的浮点[15]近似值。
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) inverse[row + 4 * col] = right[col + 4 * row]! * extent;
    inverse[12 + row] = center.reduce((sum, value, col) => sum + right[col + 4 * row]! * value, 0);
  }
  const product = (left: number[], right: number[]) =>
      Array.from({ length: 16 }, (_, i) =>
        [0, 1, 2, 3].reduce((sum, k) => sum + left[(i % 4) + 4 * k]! * right[k + 4 * Math.floor(i / 4)]!, 0),
      ),
    second = product(selected.matrix, inverse),
    composed = product(second, first);
  checkedMetadataTransform(first);
  checkedMetadataTransform(second);
  if (composed.some((value, i) => Math.abs(value - selected.matrix[i]!) > 1e-12))
    return fail('General native TRS factors do not reproduce the original affine request.');
  return { ...selected, first_matrix: first, second_matrix: second };
}
