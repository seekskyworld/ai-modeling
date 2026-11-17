/** 对应 Studio 球刷命中与 8 位累计权重；与旧屏幕圆形选区分开，不把两者冒称等价。 */
import { mat4, vec3 } from 'gl-matrix';
import type { BrushPart } from './brush-model.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Pixels } from './brush-raster.ts';

export type BrushPoint = [number, number, number];
export interface SurfaceStroke {
  points: BrushPoint[];
  size: number;
  strength: number;
  hardness: number;
}
/** 原网页使用基础 POSITION 和 world 矩阵；不采样动画或将 morph 后的坐标伪装为相同算法。 */
export function surfaceMask(part: BrushPart, stroke: SurfaceStroke): Uint8Array {
  const primitive = part.primitive,
    positions = primitive.getAttribute('POSITION');
  if (!positions || primitive.getMode() !== 4)
    throw new TripoError('BRUSH_GEOMETRY', 'Use triangle geometry with positions.');
  // 避免离线点集让二次遍历失控；调用方可拆成多个独立笔画，而不是等待无界计算。
  const faces = (primitive.getIndices()?.getCount() ?? positions.getCount()) / 3;
  if (positions.getCount() > 2000000 || faces * stroke.points.length > 100000000)
    throw new TripoError(
      'BRUSH_WORK_LIMIT',
      'Use at most 2 million vertices and 100 million face-sample pairs per stroke.',
    );
  const world = part.node.getWorldMatrix(),
    inverse = mat4.invert(mat4.create(), world);
  const scale =
    vec3.length([world[0]!, world[1]!, world[2]!]) +
    vec3.length([world[4]!, world[5]!, world[6]!]) +
    vec3.length([world[8]!, world[9]!, world[10]!]);
  if (!inverse || scale < 1e-12) throw new TripoError('BRUSH_GEOMETRY', 'Mesh transform is singular.');
  const local = Array.from({ length: positions.getCount() }, (_, i) => positions.getElement(i, []));
  const transformed = local.map((p) => vec3.transformMat4(vec3.create(), p, world));
  const indices = primitive.getIndices(),
    count = indices?.getCount() ?? local.length;
  const mask = new Uint8Array(local.length),
    radius2 = (((stroke.size * 3) / scale) * 0.8) ** 2;
  const inner = stroke.size * stroke.hardness,
    feather = stroke.size - inner;
  const maximum = Math.floor(stroke.strength * 255);
  for (const point of stroke.points) {
    const center = vec3.transformMat4(vec3.create(), point, inverse);
    const selected = new Set<number>();
    for (let face = 0; face < count; face += 3) {
      const triangle = [0, 1, 2].map((corner) => indices?.getScalar(face + corner) ?? face + corner);
      if (triangle.some((index) => vec3.squaredDistance(local[index]!, center) <= radius2))
        triangle.forEach((index) => selected.add(index));
    }
    for (const index of selected) {
      const distance = vec3.distance(transformed[index]!, point);
      const falloff = feather > 0 ? 1 - Math.max(0, Math.min(1, (distance - inner) / feather)) : 0;
      const amount = distance <= inner ? maximum : Math.floor(maximum * falloff * falloff);
      mask[index] = Math.min(255, mask[index]! + amount);
    }
  }
  return mask;
}
const linear = (value: number): number =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const srgb = (value: number): number =>
  value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

/** UV 三角形插值后在线性色域混色；填桶也只修改该部件 UV 覆盖区，保留未覆盖的贴图像素。 */
export function paintSurface(
  part: BrushPart,
  base: Pixels,
  input: Pixels | string,
  mask: Uint8Array,
): Pixels {
  const uv = part.primitive.getAttribute('TEXCOORD_0'),
    indices = part.primitive.getIndices();
  if (!uv || part.primitive.getMode() !== 4 || mask.length !== uv.getCount())
    throw new TripoError('BRUSH_GEOMETRY', 'Use UV0 triangles with one mask value per vertex.');
  const color =
    typeof input === 'string' ? [1, 3, 5].map((i) => parseInt(input.slice(i, i + 2), 16)) : undefined;
  const out = Buffer.from(base.data),
    painted = new Uint8Array(base.width * base.height);
  const count = indices?.getCount() ?? uv.getCount();
  for (let face = 0; face < count; face += 3) {
    const ids = [0, 1, 2].map((corner) => indices?.getScalar(face + corner) ?? face + corner);
    const points = ids.map((index) => uv.getElement(index, [] as number[]));
    const [a, b, c] = points as [number[], number[], number[]];
    const det = (b[1]! - c[1]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[1]! - c[1]!);
    if (Math.abs(det) < 1e-12) continue;
    const low = [0, 1].map((k) =>
      Math.max(0, Math.floor(Math.min(...points.map((p) => p[k]!)) * (k ? base.height : base.width))),
    );
    const high = [0, 1].map((k) =>
      Math.min(
        (k ? base.height : base.width) - 1,
        Math.ceil(Math.max(...points.map((p) => p[k]!)) * (k ? base.height : base.width)),
      ),
    );
    for (let y = low[1]!; y <= high[1]!; y++)
      for (let x = low[0]!; x <= high[0]!; x++) {
        const u = (x + 0.5) / base.width,
          v = (y + 0.5) / base.height;
        const first = ((b[1]! - c[1]!) * (u - c[0]!) + (c[0]! - b[0]!) * (v - c[1]!)) / det;
        const second = ((c[1]! - a[1]!) * (u - c[0]!) + (a[0]! - c[0]!) * (v - c[1]!)) / det;
        const weights = [first, second, 1 - first - second];
        if (weights.some((value) => value < -1e-7)) continue;
        const amount = Math.max(
          0,
          Math.min(
            1,
            ids.reduce((sum, index, corner) => sum + (mask[index]! / 255) * weights[corner]!, 0),
          ),
        );
        const offset = (y * base.width + x) * 4;
        for (let channel = 0; channel < 4; channel++) {
          const source =
            typeof input === 'string'
              ? channel === 3
                ? 255
                : color![channel]!
              : input.data[offset + channel]!;
          out[offset + channel] =
            channel === 3
              ? Math.round(base.data[offset + channel]! * (1 - amount) + source * amount)
              : Math.round(
                  255 *
                    srgb(
                      linear(base.data[offset + channel]! / 255) * (1 - amount) +
                        linear(source / 255) * amount,
                    ),
                );
        }
        painted[y * base.width + x] = out[offset + 3] === 255 ? 1 : 0;
      }
  }
  dilateSurface(out, painted, base.width, base.height);
  return { ...base, data: out };
}
/** 网页 EdgeDilationMaterial：三轮取八邻域不透明像素的线性色域平均，而不是复制第一个邻居。 */
function dilateSurface(out: Buffer, painted: Uint8Array, width: number, height: number): void {
  for (let pass = 0; pass < 3; pass++) {
    const previous = painted.slice(),
      pixels = Buffer.from(out);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (previous[index]) continue;
        const neighbors: number[] = [];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            // 渲染目标的 ClampToEdge 与纹理采样一致，边界会重复贡献邻域。
            const next =
              Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx));
            if (previous[next]) neighbors.push(next);
          }
        if (!neighbors.length) continue;
        for (let channel = 0; channel < 3; channel++)
          out[index * 4 + channel] = Math.round(
            255 *
              srgb(
                neighbors.reduce((sum, next) => sum + linear(pixels[next * 4 + channel]! / 255), 0) /
                  neighbors.length,
              ),
          );
        out[index * 4 + 3] = 255;
        painted[index] = 1;
      }
  }
}
