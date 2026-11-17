/** 网页 UV 导出的像素中心覆盖率与线框；PNG 光栅化引擎不同，线条抗锯齿不宣称逐像素等价。 */
import sharp from 'sharp';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { UvGeometry } from './uv-geometry.ts';

export const UV_RESOLUTION = 1024;
type Triangle = [number, number, number, number, number, number];
export function uvTriangle(geometry: UvGeometry, face: number): Triangle {
  return geometry.indices
    .slice(face * 3, face * 3 + 3)
    .flatMap((i) => geometry.uv.slice(i * 2, i * 2 + 2)) as Triangle;
}
export function containsUv(triangle: Triangle, u: number, v: number): boolean {
  const sides = [0, 2, 4].map((i) => {
    const next = (i + 2) % 6;
    return (
      (triangle[next]! - triangle[i]!) * (v - triangle[i + 1]!) -
      (triangle[next + 1]! - triangle[i + 1]!) * (u - triangle[i]!)
    );
  });
  return !(sides.some((side) => side < 0) && sides.some((side) => side > 0));
}

/** 与网页相同：像素中心在三角形内则覆盖；细小三角形没有中心命中时保留三个顶点像素。 */
export function rasterizeUv(geometry: UvGeometry) {
  const size = UV_RESOLUTION,
    mask = new Uint8Array(size * size);
  let totalArea = 0,
    work = 0;
  const mark = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) mask[y * size + x] = 1;
  };
  for (let face = 0; face < geometry.indices.length / 3; face++) {
    const t = uvTriangle(geometry, face);
    totalArea += Math.abs((t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0])) / 2;
    const pixels = t.map((v) => v * size) as Triangle;
    const left = Math.max(0, Math.floor(Math.min(pixels[0], pixels[2], pixels[4])));
    const right = Math.min(size - 1, Math.ceil(Math.max(pixels[0], pixels[2], pixels[4])));
    const bottom = Math.max(0, Math.floor(Math.min(pixels[1], pixels[3], pixels[5])));
    const top = Math.min(size - 1, Math.ceil(Math.max(pixels[1], pixels[3], pixels[5])));
    work += Math.max(0, right - left + 1) * Math.max(0, top - bottom + 1);
    if (work > 250000000)
      throw new TripoError(
        'UV_LIMIT',
        'Overlapping UVs exceed the bounded rasterization workload. Select fewer meshes.',
      );
    let hit = false;
    for (let y = bottom; y <= top; y++)
      for (let x = left; x <= right; x++) {
        if (containsUv(pixels, x + 0.5, y + 0.5)) {
          mark(x, y);
          hit = true;
        }
      }
    if (!hit) for (let i = 0; i < 6; i += 2) mark(Math.floor(pixels[i]!), Math.floor(pixels[i + 1]!));
  }
  return { mask, totalArea, utilization: mask.reduce((count, value) => count + value, 0) / mask.length };
}

export async function renderUv(
  geometry: UvGeometry,
  raster: ReturnType<typeof rasterizeUv>,
  highlighted?: Set<number>,
) {
  const size = UV_RESOLUTION,
    background = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const color = raster.mask[y * size + x] ? 242 : 2;
      background.fill(color, ((size - 1 - y) * size + x) * 3, ((size - 1 - y) * size + x) * 3 + 3);
    }
  const width = Math.max(
    0.1,
    Math.min(
      1,
      Math.sqrt((Math.min(raster.totalArea, 1) * size * size) / (geometry.indices.length / 3)) * 0.2,
    ),
  );
  const wires: string[] = [],
    highlight: string[] = [];
  for (let face = 0; face < geometry.indices.length / 3; face++) {
    const t = uvTriangle(geometry, face);
    const p = [0, 2, 4].map((i) => `${t[i]! * size},${(1 - t[i + 1]!) * size}`);
    const shape = `M${p[0]}L${p[1]}L${p[2]}Z`;
    wires.push(shape);
    if (highlighted?.has(face)) highlight.push(shape);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><path d="${wires.join('')}" fill="none" stroke="#c4c4c4" stroke-width="${width}"/>${highlight.length ? `<path d="${highlight.join('')}" fill="#FEBB06" fill-opacity="0.6"/>` : ''}</svg>`;
  return await sharp(background, { raw: { width: size, height: size, channels: 3 } })
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
}
