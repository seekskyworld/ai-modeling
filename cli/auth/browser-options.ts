/** 显式登录模式覆盖另一模式的环境默认值；冲突在访问凭据或流程状态前报告。 */
import { TripoError } from '../../studio/contracts/errors.ts';
import { environmentValue } from '../core/environment.ts';

export interface LoginBrowserOptions {
  executablePath?: string;
  cdpEndpoint?: string;
}

function environmentOption(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = environmentValue(name, env);
  return value?.trim() ? value : undefined;
}

export function resolveLoginBrowserOptions(
  options: LoginBrowserOptions,
  env: NodeJS.ProcessEnv = process.env,
): LoginBrowserOptions {
  for (const value of [options.executablePath, options.cdpEndpoint])
    if (value !== undefined && !value.trim())
      throw new TripoError(
        'INVALID_INPUT',
        'Browser login options require a nonempty value.',
        'not_submitted',
      );
  if (options.executablePath !== undefined && options.cdpEndpoint !== undefined)
    throw new TripoError(
      'INVALID_INPUT',
      'Choose either --browser-executable or --cdp-endpoint for browser login.',
      'not_submitted',
    );
  if (options.executablePath !== undefined) return { executablePath: options.executablePath };
  if (options.cdpEndpoint !== undefined) return { cdpEndpoint: options.cdpEndpoint };
  const executablePath = environmentOption('BROWSER_EXECUTABLE', env),
    cdpEndpoint = environmentOption('BROWSER_CDP_ENDPOINT', env);
  if (executablePath && cdpEndpoint)
    throw new TripoError(
      'INVALID_INPUT',
      'Set only one of AI_MODELING_BROWSER_EXECUTABLE and AI_MODELING_BROWSER_CDP_ENDPOINT, or select an explicit browser login mode.',
      'not_submitted',
    );
  return { ...(executablePath ? { executablePath } : {}), ...(cdpEndpoint ? { cdpEndpoint } : {}) };
}
