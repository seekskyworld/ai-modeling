/** 仅管理本地固定引擎文件，不连接账号、不请求网页、不执行JS或WASM。 */
import type { Config } from '../core/config.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { runtimeCache, runtimeCachePath, runtimeSource, type RuntimeDirectory } from './cache.ts';
import { runtimeKinds, studioAssimpFiles, studioAssimpUrl, type StudioAssimpAssets } from './manifest.ts';

function inspect(directory?: RuntimeDirectory) {
  return runtimeKinds.map((kind) => {
    const file = { kind, ...studioAssimpFiles[kind], url: studioAssimpUrl(kind) };
    try {
      return { ...file, state: directory?.read(kind) ? 'verified' : 'missing' };
    } catch (error) {
      if (!(error instanceof TripoError) || error.code !== 'FRONTEND_RUNTIME_INTEGRITY') throw error;
      return { ...file, state: 'invalid', error_code: error.code };
    }
  });
}

export function runtimeStatus(config: Pick<Config, 'dataDir' | 'inputRoots'>, sourceDir?: string) {
  const source = sourceDir === undefined ? undefined : runtimeSource(sourceDir, config.inputRoots),
    cache = source === undefined ? runtimeCache(config.dataDir, false) : undefined,
    files = inspect(source ?? cache);
  return {
    runtime: 'studio-assimp',
    scope: source ? 'source' : 'cache',
    directory: source?.path ?? cache?.path ?? runtimeCachePath(config.dataDir),
    ready: files.every((file) => file.state === 'verified'),
    files,
    network_used: false,
    account_required: false,
  };
}

export function installRuntime(config: Pick<Config, 'dataDir' | 'inputRoots'>, sourceDir: string) {
  const source = runtimeSource(sourceDir, config.inputRoots),
    verified = {} as StudioAssimpAssets;
  // 全部来源先验证，再创建或修改缓存；不会因第二个文件损坏留下半个新安装。
  for (const kind of runtimeKinds) {
    const bytes = source.read(kind);
    if (!bytes)
      throw new TripoError(
        'FRONTEND_RUNTIME_MISSING',
        `The source directory must contain ${studioAssimpFiles[kind].name}.`,
      );
    verified[kind] = bytes;
  }
  source.check();
  const cache = runtimeCache(config.dataDir, true)!;
  // 已有损坏文件必须先报错；不自动覆盖，也不在发现另一份损坏前写入缺失文件。
  for (const kind of runtimeKinds) cache.read(kind);
  const installed = runtimeKinds.filter((kind) => cache.publish(kind, verified[kind]));
  return {
    ...runtimeStatus(config),
    source_directory: source.path,
    installed,
    reused: runtimeKinds.filter((kind) => !installed.includes(kind)),
  };
}
