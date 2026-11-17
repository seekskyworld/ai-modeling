/** 桌面辅助只启动固定系统程序并传递独立参数；用户文本不作为 Shell 或脚本源码执行。 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readModelInput } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
const exec = promisify(execFile);
export function openExternal(target: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [target], { stdio: 'ignore', shell: false, detached: true });
  child.on('error', () => process.stderr.write('Could not open a browser; use the printed URL.\n'));
  child.unref();
}
export async function notifyDone(message: string): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      await exec('osascript', [
        '-e',
        'on run argv\ndisplay notification (item 1 of argv) with title "ai-modeling"\nend run',
        message,
      ]);
    } else if (process.platform === 'linux') await exec('notify-send', ['ai-modeling', message]);
    else process.stderr.write(`ai-modeling: ${message}\u0007\n`);
  } catch {
    process.stderr.write('Task finished; desktop notification was unavailable.\n');
  }
}
export async function startViewer(
  file: string,
  roots: string[] = [],
): Promise<{ url: string; close: () => void }> {
  const model = await readModelInput(file, roots);
  if (!['glb', 'gltf'].includes(model.format))
    throw new TripoError('INVALID_INPUT', 'view requires GLB/GLTF; convert other formats first.');
  const token = randomUUID();
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || !req.url?.startsWith(`/${token}/`)) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === `/${token}/model`) {
      res.setHeader('Content-Type', model.format === 'glb' ? 'model/gltf-binary' : 'model/gltf+json');
      res.end(model.bytes);
    } else if (req.url === `/${token}/viewer.js`) {
      void readFile(new URL('../dist/model-viewer.min.js', import.meta.resolve('@google/model-viewer')))
        .then((bytes) => {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(bytes);
        })
        .catch(() => res.writeHead(500).end('Viewer asset missing'));
    } else if (req.url === `/${token}/`) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><meta charset="utf-8"><title>ai-modeling Preview</title><script type="module" src="viewer.js"></script><style>body{margin:0;background:#222}model-viewer{width:100vw;height:100vh}</style><model-viewer src="model" camera-controls autoplay shadow-intensity="1"></model-viewer>',
      );
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${typeof address === 'object' ? address?.port : 0}/${token}/`,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
