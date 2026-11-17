/** 短时回环登录入口：凭据由浏览器直接提交到本机，不经过 Agent 的参数或结果。 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { errorResult, TripoError } from '../contracts/errors.ts';
import type { CredentialStore } from './credentials.ts';
import { importCredential } from './import.ts';

export async function startAuthBridge(
  store: CredentialStore,
  onImported?: (result: Record<string, unknown>) => void,
  importer: (input: string) => Promise<Record<string, unknown>> = (input) => importCredential(input, store),
): Promise<{ url: string; close: () => Promise<void> }> {
  const nonce = randomBytes(24).toString('hex');
  let origin = '';
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    if (req.headers.host !== new URL(origin).host || req.url !== `/${nonce}`) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        `<!doctype html><html lang="zh"><title>ai-modeling 本机登录</title><style>body{font:18px system-ui;max-width:640px;margin:80px auto;background:#101820;color:#edf4f7}input,button{font:inherit;padding:12px;width:100%;box-sizing:border-box;margin:12px 0}button{background:#62d5bf;border:0;cursor:pointer}</style><h1>连接 Tripo Studio</h1><p>将本人 Studio 会话或浏览器请求副本粘贴到下方。内容仅提交给本机，并保存到当前用户的私有本地 JSON 文件。</p><form method="post"><label for="credential">Studio 登录凭证</label><input id="credential" name="credential" type="password" autocomplete="off" required><button>验证并保存登录</button></form><p>已有浏览器登录可以在 Studio 的开发者工具中复制本人会话或请求。请勿提交密码。</p></html>`,
      );
      return;
    }
    if (req.method !== 'POST' || req.headers.origin !== origin) {
      res.writeHead(403).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        length += buffer.length;
        if (length > 196608) throw new TripoError('INVALID_INPUT', 'Input too large.');
        chunks.push(buffer);
      }
      const value = new URLSearchParams(Buffer.concat(chunks).toString()).get('credential') ?? '';
      // 自动登录协调器可以绑定 login_id / CAS；旧手动调用保留验证后保存的原语义。
      const result = await importer(value);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<title>Tripo3D MCP 登录成功</title><h1>登录已验证并保存在本机</h1><p>可以关闭此页面，返回 MCP 客户端。</p>',
      );
      onImported?.(result);
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorResult(error)));
    }
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing auth listener');
  origin = `http://127.0.0.1:${address.port}`;
  const timer = setTimeout(() => server.close(), 15 * 60 * 1000);
  timer.unref();
  return {
    url: `${origin}/${nonce}`,
    close: async () => {
      clearTimeout(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
