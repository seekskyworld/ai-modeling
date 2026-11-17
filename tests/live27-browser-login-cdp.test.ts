/** 协议测试只连接随机本机端口的假 CDP 服务，不连接任何浏览器。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { connectLocalCdpTransport } from '../studio/auth/browser-login-cdp.ts';

function frame(value: string): Buffer {
  const body = Buffer.from(value);
  assert.ok(body.length < 126);
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

function serveFrames(socket: Duplex, messages: unknown[]): void {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const length = buffer[1]! & 0x7f;
      const opcode = buffer[0]! & 0x0f;
      const masked = Boolean(buffer[1]! & 0x80);
      if (length >= 126) {
        socket.destroy();
        return;
      }
      const offset = masked ? 6 : 2;
      if (buffer.length < offset + length) return;
      if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0]));
        return;
      }
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked)
        for (let index = 0; index < length; index++)
          payload[index] = payload[index]! ^ buffer[2 + (index % 4)]!;
      buffer = buffer.subarray(offset + length);
      if (opcode !== 1) continue;
      const message = JSON.parse(payload.toString()) as { id?: number };
      messages.push(message);
      socket.write(frame(JSON.stringify({ id: message.id, result: { controlled: true } })));
    }
  });
}

async function fakeCdp(
  respond?: (req: IncomingMessage, res: ServerResponse, origin: string) => void,
  upgrade?: (socket: Duplex) => void,
) {
  const messages: unknown[] = [];
  const sockets = new Set<Duplex>();
  let origin = '';
  let upgrades = 0;
  const server = createServer((req, res) => {
    if (respond) return respond(req, res, origin);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl: `${origin.replace('http:', 'ws:')}/devtools/browser/controlled`,
      }),
    );
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket) => {
    upgrades++;
    if (upgrade) return upgrade(socket);
    const key = req.headers['sec-websocket-key'];
    assert.equal(typeof key, 'string');
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    serveFrames(socket, messages);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    messages,
    upgrades: () => upgrades,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('local CDP transport exchanges protocol messages and disconnects without a Browser.close request', async () => {
  const server = await fakeCdp();
  try {
    const transport = await connectLocalCdpTransport(server.origin, new AbortController().signal, 1000);
    let received!: (value: object) => void;
    const reply = new Promise<object>((resolve) => {
      received = resolve;
    });
    transport.onmessage = received;
    transport.send({ id: 1, method: 'Browser.getVersion' });
    assert.deepEqual(await reply, { id: 1, result: { controlled: true } });
    assert.throws(() => transport.send({ id: 2, method: 'Browser.close' }), { code: 'BROWSER_LOGIN_FAILED' });
    const disconnected = new Promise<string | undefined>((resolve) => {
      transport.onclose = resolve;
    });
    transport.close();
    assert.equal(await disconnected, 'Local browser connection closed.');
    assert.deepEqual(server.messages, [{ id: 1, method: 'Browser.getVersion' }]);
  } finally {
    await server.close();
  }
});

test('local CDP discovery refuses a remote endpoint and HTTP redirects before opening a socket', async () => {
  for (const redirect of [false, true]) {
    const server = await fakeCdp((_req, res) => {
      if (redirect) res.writeHead(302, { location: 'https://remote.invalid/private-value' }).end();
      else res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://remote.invalid/private-value' }));
    });
    try {
      await assert.rejects(connectLocalCdpTransport(server.origin, new AbortController().signal, 1000));
      assert.equal(server.upgrades(), 0);
    } finally {
      await server.close();
    }
  }
});

test('CDP WebSocket refuses handshake redirects and hides the raw endpoint', async () => {
  const server = await fakeCdp(undefined, (socket) => {
    socket.end(
      'HTTP/1.1 302 Found\r\nLocation: ws://remote.invalid/private-value\r\nContent-Length: 0\r\n\r\n',
    );
  });
  try {
    await assert.rejects(
      connectLocalCdpTransport(server.origin, new AbortController().signal, 1000),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes('private-value'), false);
        return true;
      },
    );
    assert.equal(server.upgrades(), 1);
  } finally {
    await server.close();
  }
});

test('connection timeout ends after handshake while explicit abort still disconnects the active transport', async () => {
  const server = await fakeCdp();
  const abort = new AbortController();
  try {
    const transport = await connectLocalCdpTransport(server.origin, abort.signal, 100);
    let closed = false;
    const disconnected = new Promise<void>((resolve) => {
      transport.onclose = () => {
        closed = true;
        resolve();
      };
    });
    await delay(140);
    assert.equal(closed, false);
    abort.abort();
    await disconnected;
    assert.equal(closed, true);
  } finally {
    await server.close();
  }
});
