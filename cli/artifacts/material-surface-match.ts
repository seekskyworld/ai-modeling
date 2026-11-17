/** 新快照按带角属性的有向三角唯一匹配，避免微小浮点误差改变排序；旧快照不改写。 */
export type MaterialSurface = [string, number[], string[]?];
const tolerance = 1e-5;
const cellSize = tolerance * 2;
function center(face: MaterialSurface): number[] {
  return [0, 1, 2].map((axis) =>
    Math.floor((face[1][axis]! + face[1][3 + axis]! + face[1][6 + axis]!) / 3 / cellSize),
  );
}
function valid(face: MaterialSurface): boolean {
  return (
    typeof face[0] === 'string' &&
    face[1].length === 9 &&
    face[1].every(Number.isFinite) &&
    face[2]?.length === 3 &&
    face[2].every((key) => typeof key === 'string')
  );
}
function sameFace(a: MaterialSurface, b: MaterialSurface): boolean {
  if (a[0] !== b[0]) return false;
  return [0, 1, 2].some((shift) =>
    [0, 1, 2].every((corner) => {
      const other = (corner + shift) % 3;
      return (
        a[2]![corner] === b[2]![other] &&
        [0, 1, 2].every((axis) => Math.abs(a[1][corner * 3 + axis]! - b[1][other * 3 + axis]!) <= tolerance)
      );
    }),
  );
}
export function sameOrientedMaterialSurfaces(source: MaterialSurface[], output: MaterialSurface[]): boolean {
  if (source.length !== output.length || source.length > 100000 || ![...source, ...output].every(valid))
    return false;
  const buckets = new Map<string, number[]>(),
    used = new Set<number>();
  for (const [index, face] of source.entries()) {
    const key = `${face[0]}:${center(face).join(',')}`,
      rows = buckets.get(key) ?? [];
    rows.push(index);
    buckets.set(key, rows);
  }
  let attempts = 0;
  for (const face of output) {
    const cell = center(face),
      matches: number[] = [];
    for (const x of [-1, 0, 1])
      for (const y of [-1, 0, 1])
        for (const z of [-1, 0, 1]) {
          const key = `${face[0]}:${[cell[0]! + x, cell[1]! + y, cell[2]! + z].join(',')}`;
          for (const index of buckets.get(key) ?? []) {
            if (++attempts > 1000000) return false;
            // 已占用面也参与唯一性检查；完全重叠或歧义不能被贪心匹配掩盖。
            if (sameFace(face, source[index]!)) matches.push(index);
          }
        }
    if (matches.length !== 1 || used.has(matches[0]!)) return false;
    used.add(matches[0]!);
  }
  return used.size === source.length;
}
