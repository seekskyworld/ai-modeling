#!/usr/bin/env node
/** CLI 是唯一业务入口；认证秘密只从本机表单、受限文件或 stdin 导入。 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { auth } from './auth.ts';
import { runCompatible } from './compat/program.ts';
import { configFromEnv } from './core/config.ts';
import { createApplication } from './core/application.ts';
import { launchMcp } from './compat/launch.ts';
import { callTool, toolRegistry, toolMetadata } from './commands.ts';
import { errorResult, object, TripoError } from '../studio/contracts/errors.ts';
import { runtimeTools } from './runtime/tools.ts';
import { authenticationTools } from './auth/tools.ts';
import { prepareAuthentication } from './auth/recovery.ts';
import { localOperations } from './local/operations.ts';
import { runGuides } from './guides.ts';
import {
  parseStructuredArgs,
  structuredInput,
  structuredRoute,
  structuredEntryPointNames,
  type StructuredRequest,
} from './structured-input.ts';

const help = `ai-modeling — use your own Tripo Studio account

  auth login                    Sign in in a browser; continue automatically
  auth begin                    Start login without waiting
  auth session status|wait|cancel [id]  Manage the current login flow
  auth import --file PATH       Import a private credential file (POSIX mode or Windows ACL)
  auth import --stdin           Import without a command-line secret
  auth status                   Verify session and show credit balance
  auth logout                   Remove this profile's saved Studio session
  tools                         List MCP tool contracts as JSON
  call TOOL [--input JSON]       Call any tool from a script or terminal
  guides list|read ID            Read shared usage, command and pipeline guides as JSON
  mcp                           Start MCP over stdio

Environment: AI_MODELING_PROFILE, AI_MODELING_DATA_DIR, AI_MODELING_OUTPUT_DIR, AI_MODELING_INPUT_ROOTS
Never pass cookies or tokens as tool arguments or command-line flags.
`;
function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}
async function main(args: string[]): Promise<void> {
  args = structuredRoute(args);
  const command = args[0] ?? 'help';
  if (command === 'guides') {
    print(await runGuides(args.slice(1)));
    return;
  }
  if (!structuredEntryPointNames.some((name) => name === command)) {
    await runCompatible(args);
    return;
  }
  if (command === 'auth') {
    await auth(args.slice(1));
    return;
  }
  if (command === 'serve') {
    launchMcp(args[1] === '--toolset' ? (args[2] ?? 'studio') : 'studio');
    return;
  }
  const request = parseStructuredArgs(args);
  if (request.help) {
    process.stdout.write(help);
    return;
  }
  if (request.profile) process.env.AI_MODELING_PROFILE = request.profile;
  if (request.command === 'tools') {
    print(toolMetadata(request.toolset));
    return;
  }
  const input = await structuredInput(request, readStandardInput);
  if (await runtimeCall(request, input)) return;
  if (await authenticationCall(request, input)) return;
  const app = await createApplication();
  try {
    const definitions = toolRegistry(app.service, app.studio, request.toolset);
    const result = await callTool(definitions, request.name!, input, async (tool, input) => {
      const offline =
        input.dry_run ||
        [
          'ai_modeling_plan',
          'ai_modeling_motion_presets',
          'ai_modeling_quote',
          ...localOperations.map((spec) => `ai_modeling_${spec.name}`),
        ].includes(tool.name);
      if (offline) return;
      const schema = tool.jsonSchema ?? z.toJSONSchema(tool.schema, { target: 'draft-7', io: 'input' });
      if ('request_id' in object(schema.properties) && input.request_id === undefined)
        input.request_id = randomUUID();
      try {
        await prepareAuthentication(app.service.config, app.service.credentials);
      } catch (error) {
        if (error instanceof TripoError && error.code === 'AUTH_REQUIRED' && input.request_id)
          error.details = { ...error.details, request_id: input.request_id };
        throw error;
      }
    });
    print(result.structuredContent);
    if (result.isError) process.exitCode = 1;
  } finally {
    app.close();
  }
}
/** 本地运行时工具和直接runtime命令等价，不因MCP调用初始化账号或任务数据库。 */
async function runtimeCall(request: StructuredRequest, input: unknown): Promise<boolean> {
  if (!['ai_modeling_runtime_status', 'ai_modeling_runtime_install'].includes(request.name ?? ''))
    return false;
  const studio = request.toolset === 'studio';
  const result = await callTool(studio ? runtimeTools(configFromEnv()) : [], request.name!, input);
  print(result.structuredContent);
  if (result.isError) process.exitCode = 1;
  return true;
}
/** 登录控制不初始化业务数据库，也不会先要求已有登录。 */
async function authenticationCall(request: StructuredRequest, input: unknown): Promise<boolean> {
  if (
    ![
      'ai_modeling_auth_begin',
      'ai_modeling_auth_status',
      'ai_modeling_auth_wait',
      'ai_modeling_auth_cancel',
    ].includes(request.name ?? '')
  )
    return false;
  const studio = request.toolset === 'studio';
  const result = await callTool(studio ? authenticationTools(configFromEnv()) : [], request.name!, input);
  print(result.structuredContent);
  if (result.isError) process.exitCode = 1;
  return true;
}
/** 结构化调用使用 stdin，避免长提示词、文件路径和 Shell 转义进入命令行。 */
async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 1048576) throw new TripoError('INVALID_INPUT', 'Command input exceeds 1 MiB.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
await main(process.argv.slice(2)).catch((error) => {
  print({ error: errorResult(error) });
  process.exitCode = 1;
});
