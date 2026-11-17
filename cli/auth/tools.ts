/** Studio 扩展认证工具；官方 default/full 工具合同保持不变。 */
import { z } from 'zod';
import { resolveDependency, type Dependency } from '../tool-dependencies.ts';
import type { Config } from '../core/config.ts';
import type { ToolSpec } from '../commands.ts';
import { beginLogin, readLogin, waitLogin, cancelLogin } from './coordinator.ts';

const loginId = z.string().uuid().optional();
export function authenticationTools(config: Dependency<Config>): ToolSpec[] {
  return [
    {
      name: 'ai_modeling_auth_begin',
      description:
        'Begin or reuse browser login for this profile. Returns a local login URL; no token input is required.',
      schema: z.object({ open: z.boolean().default(false) }).strict(),
      readOnly: false,
      run: async (input) =>
        await beginLogin({ config: resolveDependency(config), open: input.open as boolean, wait: false }),
    },
    {
      name: 'ai_modeling_auth_status',
      description: 'Read the current browser login flow status without returning credentials.',
      schema: z.object({ login_id: loginId }).strict(),
      readOnly: true,
      run: async (input) =>
        await readLogin(input.login_id as string | undefined, { config: resolveDependency(config) }),
    },
    {
      name: 'ai_modeling_auth_wait',
      description:
        'Wait briefly for browser login. Resume the original request ID or job after authentication; never resubmit an unknown outcome.',
      schema: z
        .object({ login_id: z.string().uuid(), timeout_seconds: z.number().int().min(1).max(60).default(30) })
        .strict(),
      readOnly: true,
      run: async (input) =>
        await waitLogin(input.login_id as string, {
          config: resolveDependency(config),
          timeoutMs: Number(input.timeout_seconds) * 1000,
        }),
    },
    {
      name: 'ai_modeling_auth_cancel',
      description: "Cancel this profile's active browser login without deleting its saved Studio session.",
      schema: z.object({ login_id: loginId }).strict(),
      readOnly: false,
      run: async (input) =>
        await cancelLogin(input.login_id as string | undefined, { config: resolveDependency(config) }),
    },
  ];
}
