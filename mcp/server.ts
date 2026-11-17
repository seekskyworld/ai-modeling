/** MCP 只转译协议并调用 CLI；不读取凭证、数据库或 Studio 业务实现。 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from '../version.ts';
import { CliBridge, type CliInvocation } from './cli-bridge.ts';

/** 可注入子进程入口供隔离测试使用；生产默认始终调用同包 CLI。 */
export async function serve(
  invocation?: CliInvocation,
  toolset: 'full' | 'default' | 'studio' = 'studio',
): Promise<Server> {
  const bridge = new CliBridge(invocation);
  const server = new Server(
    { name: 'ai-modeling', version: VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Use ai-modeling://guides/usage for usage and recovery, ai-modeling://guides/pipelines for examples, and ai-modeling://guides/commands/index to find focused command guides such as ai-modeling://guides/commands/model/convert. Read the full ai-modeling://guides/commands reference only when necessary. Call this server's tools to execute: MCP invokes the bundled CLI internally, so a separate shell invocation is not required. If a tool returns AUTH_REQUIRED, show its login.login_url to the user to open on the server's machine and complete browser sign-in. Read ai-modeling://auth/status to check progress; do not request tokens or passwords. After authentication, resume the same request_id only when the original request was not submitted; query the original task when it was submitted or its outcome is unknown. Reuse the original task identity when recovering uncertain results.",
    },
  );
  server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => {
    const guides = ListResourcesResultSchema.parse(
      await bridge.run(['guides', 'list'], undefined, extra.signal),
    );
    return {
      resources: [
        {
          uri: 'ai-modeling://auth/status',
          name: 'Studio browser login status',
          mimeType: 'application/json',
          description: 'Read the bundled CLI login flow status. No credentials are returned.',
        },
        ...guides.resources,
      ],
    };
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (_request, extra) =>
    ListResourceTemplatesResultSchema.parse(
      await bridge.run(['guides', 'templates'], undefined, extra.signal),
    ),
  );
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const guide = /^ai-modeling:\/\/guides\/([a-z][a-z0-9-]*(?:\/[a-z0-9-]+)*)$/.exec(request.params.uri);
    if (guide) {
      const result = await bridge.run(['guides', 'read', guide[1]!], undefined, extra.signal);
      if (result && typeof result === 'object' && 'error' in result) {
        const detail = result.error as { code?: unknown } | undefined;
        if (detail?.code === 'INVALID_INPUT') throw new McpError(ErrorCode.InvalidParams, 'Unknown guide.');
        throw new McpError(ErrorCode.InternalError, 'Cannot read bundled guide.');
      }
      return ReadResourceResultSchema.parse({ contents: [result] });
    }
    if (request.params.uri !== 'ai-modeling://auth/status')
      throw new McpError(ErrorCode.InvalidParams, 'Unknown resource.');
    const status = await bridge.run(['auth', 'session', 'status'], undefined, extra.signal);
    return {
      contents: [{ uri: request.params.uri, mimeType: 'application/json', text: JSON.stringify(status) }],
    };
  });
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const tools = await bridge.run(['tools', '--toolset', toolset], undefined, extra.signal);
    return ListToolsResultSchema.parse({ tools });
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const data = await bridge.call(
      request.params.name,
      request.params.arguments ?? {},
      extra.signal,
      toolset,
    );
    const payload = toolset === 'studio' || !('result' in data) ? data : data.result;
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent:
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : { result: payload },
      ...(data.error ? { isError: true } : {}),
    };
  });
  server.onclose = () => bridge.close();
  await server.connect(new StdioServerTransport());
  return server;
}
