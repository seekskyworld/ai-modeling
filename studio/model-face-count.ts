/** Canvas 在浏览器统计模型面数；只对已核实的格式/布局复现口径，不加载贴图或外部资源。 */
import { NodeIO, Logger, type GLTF } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { array, object, TripoError } from './contracts/errors.ts';
import { detectFormat, validateGlb } from './files.ts';
import { inspectFbxFaces } from './fbx/faces.ts';
import { countWebGltfFaces, GltfFaceScopeError } from './gltf-face-count.ts';

export interface ModelFaceCheck {
  limit: number;
  face_count: number | null;
  verified: boolean;
  method: string;
  reason?: string;
}

const limit = 3_000_000;

function unchecked(method: string, reason: string): ModelFaceCheck {
  return { limit, face_count: null, verified: false, method, reason };
}

function checked(faceCount: number, method: string): ModelFaceCheck {
  if (!Number.isSafeInteger(faceCount) || faceCount < 0)
    return unchecked(method, 'The model does not have a finite, nonnegative integer face count.');
  if (faceCount > limit)
    throw new TripoError(
      'INPUT_SIZE',
      'Canvas Upload Card accepts at most 3,000,000 faces. Reduce the model before uploading.',
      'not_submitted',
      { face_count: faceCount, face_limit: limit, method },
    );
  return { limit, face_count: faceCount, verified: true, method };
}

/** BaciG_DM OBJLoader 先以 fan 拆分 f，再由 z() 数渲染三角面；MTL 指令不读取文件。 */
function objFaces(bytes: Buffer): ModelFaceCheck {
  const method = 'web_obj_triangulated_faces';
  const source = bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\\\n/g, '');
  let vertices = 0;
  let faces = 0;
  for (const line of source.matchAll(/[^\n]+/g)) {
    const parts = line[0].trim().split(/\s+/);
    if (parts[0] === 'v') {
      if (parts.length < 4 || parts.slice(1, 4).some((value) => !Number.isFinite(Number(value))))
        return unchecked(method, 'OBJ has a vertex that cannot be reliably parsed.');
      vertices++;
    } else if (parts[0] === 'f') {
      const indices = parts.slice(1).map((value) => value.split('/')[0]!);
      if (
        indices.length < 3 ||
        indices.some((value) => {
          const index = Number(value);
          return (
            !/^[+-]?\d+$/.test(value) ||
            !Number.isSafeInteger(index) ||
            index === 0 ||
            Math.abs(index) > vertices
          );
        })
      )
        return unchecked(method, 'OBJ has a face with missing or unresolved vertex indices.');
      faces += indices.length - 2;
    } else if (parts[0] === 'l' || parts[0] === 'p')
      return unchecked(method, 'OBJ line/point groups need the webpage loader to determine mesh membership.');
  }
  return vertices && faces
    ? checked(faces, method)
    : unchecked(method, 'OBJ contains no countable mesh faces.');
}

/** 网页 STLLoader 的二进制 header count 与 ASCII 每个三顶点 facet 都是一面。 */
function stlFaces(bytes: Buffer): ModelFaceCheck {
  const method = 'web_stl_triangles';
  if (bytes.length >= 84) {
    const count = bytes.readUInt32LE(80);
    if (84 + count * 50 === bytes.length) return checked(count, method);
  }
  const source = bytes.toString('utf8');
  let faces = 0;
  let vertices = 0;
  for (const solid of source.matchAll(/solid([\s\S]*?)endsolid/g)) {
    for (const facet of solid[0].matchAll(/facet([\s\S]*?)endfacet/g)) {
      const points = [...facet[0].matchAll(/\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g)];
      if (
        points.length !== 3 ||
        points.some((point) => point.slice(1).some((value) => !Number.isFinite(Number(value))))
      )
        return unchecked(method, 'ASCII STL contains an incomplete or invalid triangular facet.');
      vertices += points.length;
      faces++;
    }
  }
  if (
    !faces ||
    [...source.matchAll(/\bfacet\b/g)].length !== faces ||
    [...source.matchAll(/\bvertex\b/g)].length !== vertices
  )
    return unchecked(method, 'STL is truncated or its facet structure cannot be reliably counted.');
  return checked(faces, method);
}

async function gltfFaces(bytes: Buffer, format: string): Promise<ModelFaceCheck> {
  const method = 'web_gltf_scene_model_info';
  let count: number;
  try {
    const json = format === 'glb' ? validateGlb(bytes) : object(JSON.parse(bytes.toString('utf8')));
    detectFormat(bytes);
    if (bytes.length > 150 * 1024 * 1024) throw new Error('glTF exceeds the model input byte limit.');
    let elements = 0;
    for (const accessor of array(json.accessors).map(object)) {
      const count = accessor.count;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
        throw new Error('glTF accessor count is invalid.');
      elements +=
        count *
        ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[String(accessor.type)] ?? 16);
    }
    if (elements * 8 > 256 * 1024 * 1024)
      throw new Error('glTF decoded geometry exceeds the bounded inspection limit.');
    await MeshoptDecoder.ready;
    const io = new NodeIO()
      .setLogger(new Logger(Logger.Verbosity.SILENT))
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const document =
      format === 'glb'
        ? await io.readBinary(bytes)
        : await io.readJSON({ json: json as unknown as GLTF.IGLTF, resources: {} });
    count = countWebGltfFaces(
      json,
      document
        .getRoot()
        .listMeshes()
        .map((mesh) =>
          mesh.listPrimitives().map((primitive) => {
            const mode = primitive.getMode(),
              accessor = primitive.getIndices() ?? primitive.getAttribute('POSITION');
            if (!accessor) throw new Error('Missing geometry');
            const length = accessor.getCount();
            return {
              mesh: [4, 5, 6].includes(mode),
              faces: mode === 4 ? length / 3 : Math.max(0, length - 2),
            };
          }),
        ),
    );
  } catch (error) {
    return unchecked(
      method,
      error instanceof GltfFaceScopeError
        ? error.message
        : 'glTF geometry could not be counted offline; no external decoder or resource was fetched.',
    );
  }
  return checked(count, method);
}

/** 无法核实的格式返回 verified:false，不把缺失计数当零，也不改变网页实际可上传格式。 */
export async function inspectModelFaceCount(bytes: Buffer, format: string): Promise<ModelFaceCheck> {
  if (format === 'obj') return objFaces(bytes);
  if (format === 'stl') return stlFaces(bytes);
  if (format === 'glb' || format === 'gltf') return gltfFaces(bytes, format);
  if (format === 'fbx') {
    const result = inspectFbxFaces(bytes);
    return result.face_count === null
      ? unchecked('web_fbx_original_polygons', result.reason!)
      : checked(result.face_count, 'web_fbx_original_polygons');
  }
  return unchecked(
    'unsupported_model_format',
    'This format has no verified local webpage face-count mapping.',
  );
}
