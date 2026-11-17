/** 按 Studio 投影规则在 UV 空间混合贴图；采用正面阈值 0.5，保留背面与视野外原像素。 */
import { mat3, mat4, vec3, vec4 } from 'gl-matrix';
import type { Node, Primitive } from '@gltf-transform/core';
import { TripoError } from '../../studio/contracts/errors.ts';
export interface Pixels {
  data: Buffer;
  width: number;
  height: number;
}
export interface Stroke {
  x: number;
  y: number;
  radius: number;
  opacity: number;
  erase: boolean;
}
export interface BrushInput {
  camera_matrix: number[];
  fov: number;
  strokes: Stroke[];
  color?: string;
  opacity: number;
}
interface Vertex {
  uv: number[];
  screen: number[];
  facing: number;
  mask: number;
}
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
function selection(screen: number[], strokes: Stroke[]): number {
  if (!strokes.length) return 1;
  let mask = 0;
  for (const stroke of strokes) {
    if (Math.hypot(screen[0]! - stroke.x, screen[1]! - stroke.y) <= stroke.radius)
      mask = stroke.erase ? 0 : Math.max(mask, stroke.opacity);
  }
  return mask;
}
function vertices(node: Node, primitive: Primitive, input: BrushInput, aspect: number): Vertex[] {
  const position = primitive.getAttribute('POSITION'),
    normals = primitive.getAttribute('NORMAL');
  const uv = primitive.getAttribute('TEXCOORD_0');
  if (!position || !normals || !uv || primitive.getMode() !== 4)
    throw new TripoError('BRUSH_GEOMETRY', 'Magic Brush requires triangles, vertex normals and TEXCOORD_0.');
  const world = node.getWorldMatrix(),
    normal = mat3.normalFromMat4(mat3.create(), world);
  const view = mat4.invert(mat4.create(), input.camera_matrix);
  if (!normal || !view) throw new TripoError('INVALID_INPUT', 'Camera or model matrix is singular.');
  const projection = mat4.perspective(mat4.create(), (input.fov * Math.PI) / 180, aspect, 0.001, 10000);
  const camera = input.camera_matrix.slice(12, 15),
    result: Vertex[] = [];
  for (let i = 0; i < position.getCount(); i++) {
    const p = vec3.transformMat4(vec3.create(), position.getElement(i, []), world);
    const n = vec3.normalize(
      vec3.create(),
      vec3.transformMat3(vec3.create(), normals.getElement(i, []), normal),
    );
    const direction = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), p, camera));
    const clip = vec4.transformMat4(vec4.create(), [p[0], p[1], p[2], 1], view);
    vec4.transformMat4(clip, clip, projection);
    const screen = [(clip[0] / clip[3]) * 0.5 + 0.5, 0.5 - (clip[1] / clip[3]) * 0.5];
    result.push({
      uv: uv.getElement(i, []),
      screen,
      facing: clip[3] > 0 ? -vec3.dot(n, direction) : -1,
      mask: selection(screen, input.strokes),
    });
  }
  return result;
}
function sample(image: Pixels, x: number, y: number): number[] {
  const px = clamp(x) * (image.width - 1),
    py = clamp(y) * (image.height - 1);
  const x0 = Math.floor(px),
    y0 = Math.floor(py),
    x1 = Math.min(x0 + 1, image.width - 1),
    y1 = Math.min(y0 + 1, image.height - 1);
  return [0, 1, 2, 3].map((c) => {
    const row = (yy: number): number =>
      image.data[(yy * image.width + x0) * 4 + c]! * (1 - (px - x0)) +
      image.data[(yy * image.width + x1) * 4 + c]! * (px - x0);
    return row(y0) * (1 - (py - y0)) + row(y1) * (py - y0);
  });
}
function paintTriangle(
  corners: Vertex[],
  base: Pixels,
  image: Pixels | undefined,
  input: BrushInput,
  out: Buffer,
  painted: Uint8Array,
): void {
  const [a, b, c] = corners as [Vertex, Vertex, Vertex];
  const determinant =
    (b.uv[1]! - c.uv[1]!) * (a.uv[0]! - c.uv[0]!) + (c.uv[0]! - b.uv[0]!) * (a.uv[1]! - c.uv[1]!);
  if (Math.abs(determinant) < 1e-12) return;
  const low = [0, 1].map((k) =>
    Math.max(0, Math.floor(Math.min(...corners.map((v) => v.uv[k]!)) * (k ? base.height : base.width))),
  );
  const high = [0, 1].map((k) =>
    Math.min(
      (k ? base.height : base.width) - 1,
      Math.ceil(Math.max(...corners.map((v) => v.uv[k]!)) * (k ? base.height : base.width)),
    ),
  );
  const color = input.color
    ? [1, 3, 5].map((i) => parseInt(input.color!.slice(i, i + 2), 16)).concat(255)
    : undefined;
  for (let y = low[1]!; y <= high[1]!; y++)
    for (let x = low[0]!; x <= high[0]!; x++) {
      const u = (x + 0.5) / base.width,
        v = (y + 0.5) / base.height;
      const first =
        ((b.uv[1]! - c.uv[1]!) * (u - c.uv[0]!) + (c.uv[0]! - b.uv[0]!) * (v - c.uv[1]!)) / determinant;
      const second =
        ((c.uv[1]! - a.uv[1]!) * (u - c.uv[0]!) + (a.uv[0]! - c.uv[0]!) * (v - c.uv[1]!)) / determinant;
      const weights = [first, second, 1 - first - second];
      if (weights.some((w) => w < -1e-5)) continue;
      const blend = (get: (p: Vertex) => number): number =>
        corners.reduce((s, p, i) => s + weights[i]! * get(p), 0);
      const sx = blend((p) => p.screen[0]!),
        sy = blend((p) => p.screen[1]!);
      if (sx < 0 || sx > 1 || sy < 0 || sy > 1 || blend((p) => p.facing) < 0.5) continue;
      const amount = clamp(blend((p) => p.mask)) * input.opacity;
      if (!amount) continue;
      const pixel = color ?? sample(image!, sx, sy),
        offset = (y * base.width + x) * 4;
      for (let channel = 0; channel < 4; channel++)
        out[offset + channel] = Math.round(
          base.data[offset + channel]! * (1 - amount) + pixel[channel]! * amount,
        );
      painted[y * base.width + x] = 1;
    }
}
/** 三轮边缘扩展消除 UV 缝隙；只填未命中的相邻像素，不反复模糊有效贴图。 */
function dilate(out: Buffer, mask: Uint8Array, width: number, height: number): void {
  for (let pass = 0; pass < 3; pass++) {
    const previous = mask.slice(),
      pixels = Buffer.from(out);
    for (let y = 1; y < height - 1; y++)
      for (let x = 1; x < width - 1; x++) {
        const index = y * width + x;
        if (previous[index]) continue;
        const from = [index - 1, index + 1, index - width, index + width].find((i) => previous[i]);
        if (from !== undefined) {
          pixels.copy(out, index * 4, from * 4, from * 4 + 4);
          mask[index] = 1;
        }
      }
  }
}
export function bakePart(
  node: Node,
  primitive: Primitive,
  base: Pixels,
  image: Pixels | undefined,
  input: BrushInput,
): { data: Buffer; changed_pixels: number } {
  const list = vertices(node, primitive, input, image ? image.width / image.height : 1);
  const indices = primitive.getIndices(),
    count = indices?.getCount() ?? list.length;
  const out = Buffer.from(base.data),
    mask = new Uint8Array(base.width * base.height);
  for (let i = 0; i < count; i += 3)
    paintTriangle(
      [0, 1, 2].map((j) => list[indices?.getScalar(i + j) ?? i + j]!),
      base,
      image,
      input,
      out,
      mask,
    );
  const changed_pixels = mask.reduce((sum, n) => sum + n, 0);
  dilate(out, mask, base.width, base.height);
  return { data: out, changed_pixels };
}
