/** Studio DCC Bridge 1.1 的本机协议；只向回环插件传输文件，不发送网页凭证。 */
import { TripoError, object, text } from '../contracts/errors.ts';

const targets = [
  ['blender', 60600, 'fbx', 'blender', 'embedded'],
  ['unity', 60610, 'fbx', 'blender', 'zip'],
  ['unreal', 60620, 'fbx', 'blender', 'zip'],
  ['3ds_max', 60630, 'fbx', '3dsmax', 'embedded'],
  ['maya', 60640, 'fbx', '3dsmax', 'embedded'],
  ['godot', 60650, 'fbx', 'blender', 'zip'],
  ['cocos', 60660, 'fbx', 'blender', 'zip'],
  ['zbrush', 60670, 'obj', 'blender', 'embedded'],
  ['metatailor', 60680, 'fbx', 'blender', 'zip'],
  ['roblox', 60690, 'fbx', 'blender', 'zip'],
  ['sketchup', 60700, 'glb', 'blender', 'embedded'],
] as const;
export const dccTargets = targets.map(([name, port, format, fbx_preset, texture_packaging]) => ({
  name,
  port,
  export: {
    format,
    fbx_preset,
    texture_packaging,
    ...(name === 'metatailor' ? {} : { export_orientation: '-y' }),
    export_vertex_colors: name === 'zbrush',
  },
  ...(name === 'sketchup' ? { maximum_faces: 50000 } : {}),
}));
export type DccMessage = { type: string; payload: Record<string, unknown> };
type Predicate = (message: DccMessage) => boolean;
type Pending = {
  check: Predicate;
  resolve: (message: DccMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** 缓存提前抵达的 file_loaded，区分收到文件和真正导入；未知结果不自动重发。 */
export class DccConnection {
  private socket: WebSocket;
  private queue: DccMessage[] = [];
  private pending?: Pending;
  private failure?: Error;
  private heartbeat?: NodeJS.Timeout;
  private sent = false;
  private constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('message', (event) => this.receive(event.data));
    this.socket.addEventListener('error', () => this.fail('DCC_CONNECTION', 'Local DCC connection failed.'));
    this.socket.addEventListener('close', () => this.fail('DCC_CONNECTION', 'Local DCC connection closed.'));
  }
  static async open(port: number, timeout: number) {
    const connection = new DccConnection(port);
    try {
      await connection.opened(timeout);
      const ack = connection.next((m) => m.type === 'handshake_ack', timeout);
      connection.send({
        type: 'handshake',
        payload: { clientName: 'Tripo Studio CLI', protocolVersion: '1.1.0' },
      });
      const message = await ack;
      if (message.payload.success !== true)
        throw new TripoError(
          'DCC_HANDSHAKE',
          'The local DCC plugin rejected the handshake.',
          'not_submitted',
        );
      connection.heartbeat = setInterval(() => {
        if (connection.socket.readyState === WebSocket.OPEN) connection.send({ type: 'ping' });
      }, 5000);
      return { connection, peer: message.payload };
    } catch (error) {
      connection.close();
      throw error;
    }
  }
  private opened(timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener('open', onOpen);
        this.socket.removeEventListener('error', onError);
        this.socket.removeEventListener('close', onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(
          new TripoError(
            'DCC_CONNECTION',
            'Start the selected DCC Bridge plugin before connecting.',
            'not_submitted',
          ),
        );
      };
      const timer = setTimeout(onError, timeout);
      this.socket.addEventListener('open', onOpen, { once: true });
      this.socket.addEventListener('error', onError, { once: true });
      this.socket.addEventListener('close', onError, { once: true });
    });
  }
  private fail(code: string, message: string) {
    this.failure = new TripoError(code, message, this.sent ? 'unknown' : 'not_submitted');
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = undefined;
    }
  }
  private receive(data: unknown) {
    try {
      const decoded =
        typeof data === 'string'
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString('utf8')
            : '';
      if (decoded.length > 65536) throw new Error('Oversized acknowledgement');
      const raw = object(JSON.parse(decoded)),
        message = { type: text(raw.type), payload: object(raw.payload) };
      if (message.type === 'pong') return;
      if (this.pending?.check(message)) {
        const pending = this.pending;
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.resolve(message);
      } else {
        this.queue.push(message);
        if (this.queue.length > 32) this.queue.shift();
      }
    } catch {
      this.fail('DCC_PROTOCOL', 'Invalid acknowledgement from the local DCC plugin.');
    }
  }
  next(check: Predicate, timeout: number): Promise<DccMessage> {
    const index = this.queue.findIndex(check);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail('DCC_TIMEOUT', 'DCC acknowledgement timed out; inspect the target before resending.'),
        timeout,
      );
      this.pending = { check, resolve, reject, timer };
    });
  }
  send(header: unknown, bytes?: Buffer) {
    const json = Buffer.from(JSON.stringify(header));
    if (bytes) this.sent = true;
    try {
      this.socket.send(bytes ? Buffer.concat([json, bytes]) : json);
    } catch {
      this.fail('DCC_CONNECTION', 'DCC connection ended before the acknowledgement.');
    }
  }
  close() {
    clearInterval(this.heartbeat);
    this.socket.close();
  }
}

/** 与网页相同的 5 MiB 分块。每块必须匹配 fileId/fileIndex；失败与缺回执均不盲目重传。 */
export async function transferDcc(
  connection: Pick<DccConnection, 'next' | 'send'>,
  file: { bytes: Buffer; id: string; name: string; type: string },
  timeout: number,
  waitImport: boolean,
) {
  const chunkSize = 5 * 1024 * 1024,
    total = Math.ceil(file.bytes.length / chunkSize);
  for (let index = 0; index < total; index++) {
    const bytes = file.bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
    const result = connection.next(
      (m) =>
        m.payload.fileId === file.id &&
        (m.type === 'file_transfer_error' ||
          (m.type === 'file_transfer_ack' && m.payload.fileIndex === index)),
      timeout,
    );
    connection.send(
      {
        type: 'file_transfer',
        payload: {
          chunkIndex: index,
          chunkSize: bytes.length,
          chunkTotal: total,
          fileId: file.id,
          fileName: file.name,
          fileType: file.type,
        },
      },
      bytes,
    );
    const ack = await result;
    if (ack.type === 'file_transfer_error' || ack.payload.success !== true)
      throw new TripoError('DCC_TRANSFER', 'DCC plugin rejected the file chunk.', 'unknown', {
        file_id: file.id,
        chunk: index,
        plugin: ack.payload,
      });
  }
  if (!waitImport) return { transferred: true, imported: null, chunks: total };
  // 网页定义 file_loaded；本机 Bridge 的较新实现使用 import_complete，同样是实际导入终态。
  const loaded = await connection.next(
    (m) =>
      m.payload.fileId === file.id &&
      ['file_loaded', 'import_complete', 'file_transfer_error'].includes(m.type),
    timeout,
  );
  if (loaded.type === 'file_transfer_error' || loaded.payload.success !== true)
    throw new TripoError(
      'DCC_IMPORT',
      'File transferred but the DCC plugin could not import it.',
      'unknown',
      { file_id: file.id, plugin: loaded.payload },
    );
  return { transferred: true, imported: true, chunks: total };
}
