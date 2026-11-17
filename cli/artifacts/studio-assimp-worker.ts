/** 固定摘要引擎在可终止worker内执行；VM不提供本机文件、进程或网络入口。 */
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import { studioAssimpFiles, studioAssimpHash } from './studio-assimp-assets.ts';
import { normalizeFrontendAnimation } from './studio-assimp-normalize.ts';
import { restoreFrontendDefaults } from './studio-assimp-rest.ts';
import { verifyStudioFrontend, type StudioFrontendMetadata } from './studio-assimp-proof.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { isBinaryFrontendFbx, readStaticFrontendFbx } from './studio-fbx-source.ts';
import { verifyStaticFrontendFbx } from './studio-fbx-proof.ts';

interface NativeFile {
  GetPath(): string;
  GetContent(): Uint8Array;
  delete(): void;
}
interface NativeList {
  AddFile(name: string, bytes: Uint8Array): void;
  delete(): void;
}
interface NativeResult {
  IsSuccess(): boolean;
  GetErrorCode(): number;
  FileCount(): number;
  GetFile(index: number): NativeFile;
  delete(): void;
}
interface Assimp {
  FileList: new () => NativeList;
  ConvertFileList(
    files: NativeList,
    format: string,
    metadata: StudioFrontendMetadata,
    name: string,
  ): NativeResult;
}
interface Input {
  source: Uint8Array;
  glue: Uint8Array;
  wasm: Uint8Array;
  metadata: StudioFrontendMetadata;
  projectName: string;
}

async function originalEngine(input: Input): Promise<Assimp> {
  if (
    studioAssimpHash(input.glue) !== studioAssimpFiles.glue.sha256 ||
    studioAssimpHash(input.wasm) !== studioAssimpFiles.wasm.sha256
  )
    throw new TripoError('FRONTEND_RUNTIME_INTEGRITY', 'Worker runtime SHA-256 verification failed.');
  const context = vm.createContext({
    WebAssembly,
    TextDecoder,
    TextEncoder,
    ArrayBuffer,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    setTimeout,
    clearTimeout,
    performance,
    console: { log() {}, warn() {}, error() {} },
    fetch() {
      throw new TripoError('FRONTEND_RUNTIME_IO', 'The conversion worker cannot fetch resources.');
    },
  });
  vm.runInContext(
    Buffer.from(input.glue).toString('utf8') + '\n;globalThis.capturedFactory=assimpjs;',
    context,
    { timeout: 5000 },
  );
  const factory = context.capturedFactory as (options: Record<string, unknown>) => Promise<Assimp>;
  return await factory({
    wasmBinary: input.wasm,
    locateFile: () => 'offline-pinned-assimp.wasm',
    print() {},
    printErr() {},
  });
}
async function convert(input: Input): Promise<{ bytes: Buffer; proof: Record<string, unknown> }> {
  const source = Buffer.from(input.source),
    fbx = isBinaryFrontendFbx(source);
  if (fbx) readStaticFrontendFbx(source);
  const normalized = fbx
      ? {
          bytes: source,
          proof: {
            changed_accessors: 0,
            source_format: 'fbx',
            method: 'Original binary FBX bytes passed directly to the original webpage engine.',
          },
        }
      : await normalizeFrontendAnimation(source),
    engine = await originalEngine(input),
    list = new engine.FileList();
  let result: NativeResult | undefined;
  let bytes: Buffer;
  try {
    list.AddFile(fbx ? 'model.fbx' : 'model.glb', new Uint8Array(normalized.bytes));
    result = engine.ConvertFileList(list, 'glb2', input.metadata, input.projectName);
    if (!result.IsSuccess() || result.FileCount() !== 1)
      throw new TripoError('FRONTEND_CONVERSION_FAILED', 'The pinned Studio engine did not return one GLB.');
    const file = result.GetFile(0);
    try {
      const content = file.GetContent();
      if (!content.byteLength || content.byteLength > 150 * 1024 * 1024)
        throw new TripoError('FRONTEND_CONVERSION_FAILED', 'The frontend GLB exceeds its output boundary.');
      bytes = Buffer.from(content);
    } finally {
      file.delete();
    }
  } finally {
    result?.delete();
    list.delete();
  }
  const originalOutputHash = studioAssimpHash(bytes),
    restored = fbx
      ? {
          bytes,
          proof: {
            source_format: 'fbx',
            modified: false,
            method: 'Original webpage FBX conversion output is not rewritten.',
          },
        }
      : await restoreFrontendDefaults(source, bytes);
  bytes = restored.bytes;
  const verification = fbx
    ? await verifyStaticFrontendFbx(source, bytes, input.metadata)
    : await verifyStudioFrontend(source, bytes, input.metadata);
  return {
    bytes,
    proof: {
      ...verification,
      normalization: normalized.proof,
      rest_state_restoration: restored.proof,
      original_engine_output_sha256: originalOutputHash,
      normalized_source_sha256: studioAssimpHash(normalized.bytes),
      engine: {
        kind: 'Studio pinned frontend Assimp WASM',
        glue_sha256: studioAssimpFiles.glue.sha256,
        wasm_sha256: studioAssimpFiles.wasm.sha256,
      },
      processing: fbx
        ? 'Local execution of the original Studio frontend engine on original binary FBX bytes, independently verified as static polygon surfaces. The export-lite receipt is separate and is not a file.'
        : 'Local execution of the original Studio frontend engine, with explicit standard normalized-animation decoding. The export-lite receipt is separate and is not a file.',
    },
  };
}

if (parentPort) {
  try {
    const result = await convert(workerData as Input);
    parentPort.postMessage({ ok: true, bytes: result.bytes, proof: result.proof });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      code: error instanceof TripoError ? error.code : 'FRONTEND_CONVERSION_FAILED',
      message:
        error instanceof TripoError
          ? error.message
          : 'The frontend engine or preservation proof failed; no export was submitted.',
    });
  }
}
