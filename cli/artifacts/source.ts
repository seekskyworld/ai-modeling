/** URL 输入只在执行阶段物化；缓存按提交意图隔离，避免重试时重新取到变化后的文件。 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, rm } from 'node:fs/promises';
import path from 'node:path';
import { networkFetch } from '../../studio/api/client.ts';
import { detectFormat } from '../../studio/files.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import type { Plan } from '../compat/planning.ts';
type Fetcher = typeof networkFetch;
async function remoteBytes(input: string, limit: number, fetcher: Fetcher): Promise<Buffer> {
  let url = new URL(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new TripoError('INVALID_INPUT', 'Use an HTTP(S) file URL without embedded credentials.');
    let response: Response;
    try {
      response = await fetcher(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new TripoError('NETWORK_ERROR', 'Input URL download failed.');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new TripoError('INPUT_URL', 'Input redirect has no location.');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body)
      throw new TripoError('INPUT_URL', 'Input URL did not return a downloadable file.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new TripoError('INPUT_SIZE', 'Input URL exceeds its file size limit.');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new TripoError('INPUT_URL', 'Input URL has too many redirects.');
}
async function materialize(
  url: string,
  dir: string,
  intent: string,
  model: boolean,
  fetcher: Fetcher,
): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return url;
  const key = createHash('sha256')
    .update(intent + '\0' + url)
    .digest('hex');
  const target = path.join(dir, key);
  try {
    await readFile(target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const bytes = await remoteBytes(url, (model ? 150 : 20) * 1024 * 1024, fetcher);
  const format = detectFormat(bytes);
  if (!(model ? ['glb', 'gltf', 'fbx', 'obj', 'stl'] : ['png', 'jpeg', 'webp']).includes(format))
    throw new TripoError('INPUT_FORMAT', 'Input URL returned an unsupported file format.');
  const temp = target + '.' + randomUUID() + '.tmp';
  await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
  try {
    // 相同意图的并发进程采用首个完整文件；rename 覆盖会让两次提交读到不同的 URL 内容。
    await link(temp, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await rm(temp, { force: true });
  }
  return target;
}
export async function materializeInputs(
  plan: Plan,
  dataDir: string,
  intent: string,
  fetcher: Fetcher = networkFetch,
): Promise<Plan> {
  const dir = path.join(dataDir, 'input-cache');
  const hasRemote = plan.steps.some((s) =>
    [
      ...Object.values(s.parameters),
      ...(Array.isArray(s.parameters.image_sources)
        ? s.parameters.image_sources.map((source) => object(source).image_path)
        : []),
    ]
      .flat()
      .some((v) => typeof v === 'string' && /^https?:\/\//i.test(v)),
  );
  if (!hasRemote) return plan;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const steps = [];
  for (const step of plan.steps) {
    const x = { ...step.parameters };
    for (const key of ['image_path', 'style_image_path', 'model_path'])
      if (x[key]) x[key] = await materialize(text(x[key]), dir, intent, key === 'model_path', fetcher);
    if (Array.isArray(x.image_paths))
      x.image_paths = await Promise.all(
        x.image_paths.map((v) => (v ? materialize(text(v), dir, intent, false, fetcher) : null)),
      );
    if (Array.isArray(x.image_sources))
      x.image_sources = await Promise.all(
        x.image_sources.map(async (source) => {
          const input = object(source);
          return input.image_path
            ? { image_path: await materialize(text(input.image_path), dir, intent, false, fetcher) }
            : source;
        }),
      );
    steps.push({ ...step, parameters: x });
  }
  return { ...plan, steps };
}
