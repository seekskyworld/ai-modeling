/** 内置文档沿用官方主题路径，但示例和边界只描述已声明的 Studio 后端行为。 */
import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { TripoError } from '../../studio/contracts/errors.ts';

const examples: Record<string, string> = {
  animation:
    'ai-modeling make "a humanoid robot in T pose" --for anim --model H3.1 --dry-run\nai-modeling anim check @character\nai-modeling anim rig @character --spec mixamo --name rigged\nai-modeling anim retarget @rigged --animation preset:idle preset:walk --out-format glb',
  'ar-web':
    'ai-modeling make "a small ceramic teapot" --for ar-web --dry-run\nai-modeling make "a small ceramic teapot" --for ar-web --out ./delivery',
  film: 'ai-modeling make "a sculpted lion" --for film --dry-run\nai-modeling model convert @sculpture --format OBJ --out ./film-asset',
  'game-asset':
    'ai-modeling make "a blue toy robot" --for game-mobile --dry-run\nai-modeling mesh decimate @character --face-limit 5000 --name lod\nai-modeling model convert @lod --format FBX --out ./game-asset',
  pipes:
    'ai-modeling generate text-to-model "a toy robot" --model H3.1 --json --no-download | ai-modeling model convert --format GLTF --json\nai-modeling task get @last --json | ai-modeling model texture --json --no-download',
  print:
    'ai-modeling make "a solid chess rook" --for print --dry-run\nai-modeling model convert @rook --format STL --flatten-bottom --out ./print',
};
const commandExamples: Record<string, string> = {
  make: 'ai-modeling make "a blue toy robot" --model H3.1 --dry-run\nai-modeling make ./front.png --model P2 --then rig-check,rig --name character',
  generate:
    'ai-modeling generate text-to-image "a red toy car" --model banana2\nai-modeling generate image-to-image ./front.png --model banana2 -p template=t_pose\nai-modeling generate image-to-image ./base.png ./style.png --edit-base --model banana2 --prompt "Apply the reference colors"',
  process:
    'ai-modeling model texture @character -p texture_prompt=blue\nai-modeling mesh uv @character\nai-modeling anim retarget @rigged --animation preset:idle preset:walk',
  task: 'ai-modeling task list @last 00000000-0000-0000-0000-000000000000\nai-modeling task watch @last --timeout 600 --download\nai-modeling history --limit 10',
  account: 'ai-modeling login\nai-modeling whoami\nai-modeling balance\nai-modeling usage --limit 20',
  batch:
    'ai-modeling make "a blue toy robot" --model tripo-p2 --dry-run\nai-modeling batch run ./jobs.yaml --concurrency 2\n# Batch run executes requests; reuse the same manifest and state to resume original IDs.',
  view: 'ai-modeling view @last\nai-modeling view ./delivery/model.glb',
};
const errors = `# Common errors\n\n| Code | Meaning / recovery |\n| --- | --- |\n| INVALID_INPUT | Correct the named option; run --dry-run before submitting. |\n| AUTH_REQUIRED | Import your own Studio session with ai-modeling login. |\n| PRICE_UNKNOWN | No current reviewed price; refresh pricing evidence. Unknown is not zero. |\n| NOT_RIGGABLE | The website check rejected rigging; the chain stopped before rig. |\n| PROJECT_BUSY | Query the active operation before changing the same project. |\n| STUDIO_CAPABILITY_UNAVAILABLE | No verified Studio mapping or current permission. No API-wallet fallback. |\n| IDEMPOTENCY_CONFLICT | The request_id already identifies different input; recover the original task first. |\n| OUTCOME_UNKNOWN | Reconcile the original remote IDs. Do not create a replacement request. |\n\nTask watch exits 6 on failure or timeout; timeout does not cancel the original task. Task list separates tasks, missed and per-item errors. Download errors preserve the paid task ID.\n`;

export async function bundledDocs(program: Command, rawTopic = ''): Promise<string> {
  const topic = rawTopic.replace(/\.md$/, '');
  if (topic === 'common-errors') return errors;
  if (topic.startsWith('examples/')) {
    const key = topic.slice(9),
      sample = examples[key];
    if (!sample)
      throw new TripoError('INVALID_INPUT', `Unknown example; choose ${Object.keys(examples).join(', ')}.`);
    return `# ${key}\n\nBackend: Studio web account and credits. Paths and task names below are placeholders chosen by the caller.\n\n\`\`\`sh\n${sample}\n\`\`\`\n\nDry runs do not submit. Omit --dry-run only when ready to execute. Generation defaults to P2; explicit H3.1 selects the HD website engine.\n`;
  }
  if (topic.startsWith('commands/')) {
    const key = topic.slice(9);
    const names =
      key === 'process'
        ? ['model', 'mesh', 'anim']
        : key === 'account'
          ? ['login', 'whoami', 'balance', 'usage']
          : [key];
    const commands = names.map((name) => program.commands.find((c) => c.name() === name));
    if (commands.some((command) => !command))
      throw new TripoError('INVALID_INPUT', 'Unknown command documentation.');
    return `# ${key}\n\n${commands.map((command) => command!.helpInformation()).join('\n')}\n${commandExamples[key] ? `Examples:\n\n\`\`\`sh\n${commandExamples[key]}\n\`\`\`\n` : ''}\nUse --json for automation. Studio limits, prices and request IDs differ from the official API.\n`;
  }
  const topics = new Map([
    ['README', 'README'],
    ['usage', 'usage'],
    ['commands', 'commands'],
    ['compatibility', 'compatibility'],
    ['development', 'development'],
    // Keep previously supported CLI topics after consolidating the Markdown files.
    ['agent-guide', 'usage'],
    ['cli-compatibility', 'compatibility'],
    ['web-coverage', 'compatibility'],
    ['verification', 'development'],
    ['design', 'development'],
  ]);
  const document = topics.get(topic || 'usage');
  if (!document) throw new TripoError('INVALID_INPUT', 'Unknown bundled documentation topic.');
  const root = new URL(import.meta.url.endsWith('.ts') ? '../../' : '../../../', import.meta.url);
  return await readFile(new URL(`docs/${document}.md`, root), 'utf8');
}
