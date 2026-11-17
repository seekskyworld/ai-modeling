/** 网页滴管对应：读取工作贴图原像素，不取含灯光的屏幕截图；可按 UV 或最近三维交点采样。 */
import { z } from 'zod';
import { vec3 } from 'gl-matrix';
import type { LocalSpec } from './operations.ts';
import { loadGLB } from './gltf.ts';
import { brushParts, brushTexture, type BrushPart } from './brush-model.ts';
import { brushPoint } from './brush-paint.ts';
import { uvPositionReader } from './uv-position.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

const ray = z.object({ origin: brushPoint, direction: brushPoint }).strict();
const schema = z
  .object({
    model_path: z.string().min(1),
    part_name: z.string().min(1).optional(),
    uv: z.tuple([z.number().finite(), z.number().finite()]).optional(),
    ray: ray.optional(),
  })
  .strict()
  .refine((x) => Boolean(x.uv) !== Boolean(x.ray), 'Choose UV coordinates or a 3D ray.')
  .refine((x) => !x.uv || Boolean(x.part_name), 'UV picking requires a part_name.');
function hit(parts: BrushPart[], input: z.infer<typeof ray>) {
  if (vec3.length(input.direction) < 1e-12)
    throw new TripoError('INVALID_INPUT', 'Ray direction must be nonzero.');
  const direction = vec3.normalize(vec3.create(), input.direction);
  let closest: {
    part: BrushPart;
    uv: number[];
    point: number[];
    face_index: number;
    distance: number;
  } | null = null;
  for (const part of parts) {
    const uv = part.primitive.getAttribute('TEXCOORD_0'),
      indices = part.primitive.getIndices();
    const position = part.primitive.getAttribute('POSITION');
    if (!position || !uv || part.primitive.getMode() !== 4) continue;
    const read = uvPositionReader(part.node, part.primitive),
      count = indices?.getCount() ?? position.getCount();
    const points = Array.from({ length: position.getCount() }, (_, i) => read(i));
    for (let face = 0; face < count; face += 3) {
      const ids = [0, 1, 2].map((c) => indices?.getScalar(face + c) ?? face + c);
      const a = points[ids[0]!]!,
        b = points[ids[1]!]!,
        c = points[ids[2]!]!;
      const first = vec3.sub(vec3.create(), b, a),
        second = vec3.sub(vec3.create(), c, a);
      const cross = vec3.cross(vec3.create(), direction, second),
        det = vec3.dot(first, cross);
      if (Math.abs(det) < 1e-12) continue;
      const delta = vec3.sub(vec3.create(), input.origin, a),
        u = vec3.dot(delta, cross) / det;
      if (u < 0 || u > 1) continue;
      const q = vec3.cross(vec3.create(), delta, first),
        v = vec3.dot(direction, q) / det;
      if (v < 0 || u + v > 1) continue;
      const distance = vec3.dot(second, q) / det;
      if (distance < 0 || (closest && closest.distance <= distance)) continue;
      const weights = [1 - u - v, u, v];
      closest = {
        part,
        face_index: face / 3,
        distance,
        point: Array.from(vec3.scaleAndAdd(vec3.create(), input.origin, direction, distance)),
        uv: [0, 1].map((axis) =>
          ids.reduce((sum, id, corner) => sum + uv.getElement(id, [])[axis]! * weights[corner]!, 0),
        ),
      };
    }
  }
  return closest;
}
export const brushPickOperations: LocalSpec[] = [
  {
    name: 'brush_pick',
    description:
      'pick the original texture color at a UV coordinate or nearest 3D surface, without lighting; use a brush preview to pick edited colors',
    readOnly: true,
    schema,
    run: async (config, input) => {
      const x = schema.parse(input),
        loaded = await loadGLB(x.model_path, config.inputRoots);
      const parts = brushParts(loaded.document).filter((part) => !x.part_name || part.name === x.part_name);
      if (!parts.length) throw new TripoError('INVALID_INPUT', 'Unknown part name; use brush-parts.');
      const selected = x.ray ? hit(parts, x.ray) : { part: parts[0]!, uv: x.uv! };
      if (!selected) return { model_sha256: loaded.sha256, picked: null };
      const pixels = await brushTexture(selected.part);
      const px = Math.max(0, Math.min(pixels.width - 1, Math.floor(selected.uv[0]! * pixels.width)));
      const py = Math.max(0, Math.min(pixels.height - 1, Math.floor(selected.uv[1]! * pixels.height)));
      const rgba = [...pixels.data.subarray((py * pixels.width + px) * 4, (py * pixels.width + px) * 4 + 4)];
      const { part, ...location } = selected;
      return {
        model_sha256: loaded.sha256,
        picked: {
          part_name: part.name,
          ...location,
          pixel: [px, py],
          rgba,
          color:
            '#' +
            rgba
              .slice(0, 3)
              .map((value) => value.toString(16).padStart(2, '0'))
              .join(''),
        },
        processing: 'local equivalent of browser texture color picker',
        remote_applied: false,
      };
    },
  },
];
