/** 真实 CLI 子进程契约的可控上游，不向生产暴露测试认证入口。 */
import { z } from 'zod';
import { fixture } from './helpers.ts';
import { callTool, toolRegistry } from '../cli/commands.ts';
import { runGuides } from '../cli/guides.ts';
if (process.argv[3] === 'guides') {
  process.stdout.write(JSON.stringify(await runGuides(process.argv.slice(4))));
  process.exit(0);
}
const f = await fixture(process.argv[2]);
const toolsetIndex = process.argv.indexOf('--toolset');
const definitions = toolRegistry(
  f.service,
  {
    assets: async () => ({ assets: [] }),
    client: { request: async () => ({}) },
  },
  toolsetIndex < 0 ? 'studio' : process.argv[toolsetIndex + 1],
);
try {
  if (process.argv[3] === 'tools') {
    process.stdout.write(
      JSON.stringify(
        definitions.map((d) => ({
          name: d.name,
          description: d.description,
          inputSchema: z.toJSONSchema(d.schema),
        })),
      ),
    );
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const result = await callTool(
      definitions,
      process.argv[4]!,
      JSON.parse(Buffer.concat(chunks).toString()),
    );
    process.stdout.write(JSON.stringify(result.structuredContent));
    if (result.isError) process.exitCode = 2;
  }
} finally {
  f.jobs.close();
}
