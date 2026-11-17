/** Studio扩展工具由CLI执行；MCP不接触引擎文件、凭据或网络实现。 */
import { z } from 'zod';
import { resolveDependency, type Dependency } from '../tool-dependencies.ts';
import type { ToolSpec } from '../commands.ts';
import type { Config } from '../core/config.ts';
import { installRuntime, runtimeStatus } from './assets.ts';

const directory = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'));
export const runtimeStatusSchema = z.object({ source_dir: directory.optional() }).strict();
export const runtimeInstallSchema = z.object({ source_dir: directory }).strict();
export function runtimeTools(config: Dependency<Pick<Config, 'dataDir' | 'inputRoots'>>): ToolSpec[] {
  return [
    {
      name: 'ai_modeling_runtime_status',
      description:
        'Verify the pinned Studio frontend JS/WASM in the private cache or a caller-selected source_dir. Returns required filenames, official URLs, sizes and SHA-256. No network, login, execution or directory creation.',
      schema: runtimeStatusSchema,
      readOnly: true,
      run: async (input) =>
        runtimeStatus(resolveDependency(config), runtimeStatusSchema.parse(input).source_dir),
    },
    {
      name: 'ai_modeling_runtime_install',
      description:
        'Install both pinned Studio frontend JS/WASM files from a caller-selected source_dir into the private cache after complete size/SHA-256 verification. Obtain the files through the normal website first. No network, credentials, execution or overwrite of damaged cache files.',
      schema: runtimeInstallSchema,
      readOnly: false,
      run: async (input) =>
        installRuntime(resolveDependency(config), runtimeInstallSchema.parse(input).source_dir),
    },
  ];
}
