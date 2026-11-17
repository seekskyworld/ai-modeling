/** 只读取官方公开 bundle 的文本和哈希，绝不执行远端 JavaScript，也不自动批准新价格。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { networkFetch } from '../studio/api/client.ts';
const origin = 'https://tripo-webapp-assets.tripo3d.ai';
const entry = process.argv[2];
if (!entry || new URL(entry).origin !== origin || !new URL(entry).pathname.startsWith('/studio-prod/_nuxt/'))
  throw new Error('Pass the current official Studio entry bundle URL.');
const directory = 'artifacts/web-contract';
await mkdir(directory, { recursive: true });
const queue = [entry];
const seen = new Set<string>();
const findings: Record<string, unknown>[] = [];
while (queue.length && seen.size < 160) {
  const batch = queue.splice(0, 6).filter((url) => !seen.has(url));
  batch.forEach((url) => seen.add(url));
  const results = await Promise.allSettled(
    batch.map(async (url) => {
      const file = path.join(directory, path.basename(new URL(url).pathname));
      let source: string;
      try {
        source = await readFile(file, 'utf8');
      } catch {
        const response = await networkFetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        source = await response.text();
        if (source.length > 6000000) throw new Error('Oversized bundle');
        await writeFile(file, source);
      }
      const matches = [...source.matchAll(/(?:from\s*|import\s*\()["'](\.\/?[^"']+\.js)["']/g)];
      for (const match of matches) {
        const next = new URL(match[1]!, url).href;
        if (new URL(next).origin === origin && !seen.has(next) && !queue.includes(next)) queue.push(next);
      }
      if (
        /AICompletion\s*:|imageGenerationByMember|GenerateWithTexture|retarget_model|operation\/export/.test(
          source,
        )
      ) {
        const finding = {
          url,
          sha256: createHash('sha256').update(source).digest('hex'),
          bytes: source.length,
          keys: [
            ...source.matchAll(
              /AICompletion\s*:|imageGenerationByMember|GenerateWithTexture|retarget_model|operation\/export/g,
            ),
          ].map((match) => source.slice(Math.max(0, match.index - 60), match.index + 400)),
        };
        findings.push(finding);
        process.stdout.write(JSON.stringify(finding) + '\n');
      }
    }),
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected') process.stderr.write(`Could not read ${batch[index]}\n`);
  });
}
await writeFile(
  path.join(directory, 'index.json'),
  JSON.stringify({ entry, observed_at: new Date().toISOString(), visited: seen.size, findings }, null, 2),
);
process.stdout.write(JSON.stringify({ visited: seen.size, matches: findings.length }) + '\n');
