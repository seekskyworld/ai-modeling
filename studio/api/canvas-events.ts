/** 有界 SSE 订阅支持游标续接；仅重连只读流，绝不重新运行 Canvas 或 Lab 任务。 */
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { CanvasClient } from './canvas-client.ts';
import type { StudioClient } from './client.ts';
import { object, text, sanitize, TripoError } from '../contracts/errors.ts';
import { id } from '../contracts/primitives.ts';

export const eventSchema = z
  .object({
    kind: z.enum(['agent', 'lab']),
    id: id.describe('Agent turn ID or Lab job ID.'),
    after_id: z.string().max(4096).default('').describe('Resume strictly after this event ID.'),
    wait_seconds: z.number().int().min(1).max(50).default(20),
    max_events: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

export interface EventFrame {
  event: string;
  payload: string;
}
/** 分帧跨网络块工作，CRLF 也可恰好在两个块之间拆开。 */
export function eventFrames(buffer: string): { frames: EventFrame[]; rest: string } {
  const frames: EventFrame[] = [];
  let match: RegExpExecArray | null;
  while ((match = /\r?\n\r?\n/.exec(buffer))) {
    const block = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    let event = 'message';
    const lines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
    }
    if (lines.length || event === 'end') frames.push({ event, payload: lines.join('\n') });
  }
  return { frames, rest: buffer };
}

class Collector {
  events: Record<string, unknown>[] = [];
  seen: Set<string>;
  cursor: string;
  complete = false;
  constructor(cursor: string) {
    this.cursor = cursor;
    this.seen = new Set(cursor ? [cursor] : []);
  }
  append(frame: EventFrame, onEvent?: (event: Record<string, unknown>) => void): void {
    if (frame.event === 'end') {
      this.complete = true;
      return;
    }
    if (!['message', 'error'].includes(frame.event)) return;
    let event: Record<string, unknown>;
    try {
      event = object(JSON.parse(frame.payload));
    } catch {
      throw new TripoError('CONTRACT_CHANGED', 'Unreadable event frame.');
    }
    if (frame.event === 'error')
      throw new TripoError('STUDIO_REJECTED', 'Studio event stream failed.', 'read', {
        remote_code: event.code,
      });
    if (typeof event.data === 'string') {
      try {
        event.data = JSON.parse(event.data);
      } catch {
        throw new TripoError('CONTRACT_CHANGED', 'Unreadable event data.');
      }
    }
    const next = text(event.id);
    if (event.final === true || event.eventType === 'finish') this.complete = true;
    if (next && this.seen.has(next)) return;
    if (next) {
      this.seen.add(next);
      this.cursor = next;
    }
    const safe = object(sanitize(event));
    this.events.push(safe);
    onEvent?.(safe);
  }
}
async function consume(
  response: Response,
  signal: AbortSignal,
  collector: Collector,
  maximum: number,
  onEvent?: (event: Record<string, unknown>) => void,
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  const stop = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    while (!signal.aborted && !collector.complete && collector.events.length < maximum) {
      const chunk = await reader.read();
      if (chunk.done) return;
      rest += decoder.decode(chunk.value, { stream: true });
      if (rest.length > 1024 * 1024) throw new TripoError('CONTRACT_CHANGED', 'Event exceeds 1 MiB.');
      const parsed = eventFrames(rest);
      rest = parsed.rest;
      for (const frame of parsed.frames) {
        collector.append(frame, onEvent);
        if (collector.complete || collector.events.length >= maximum) break;
      }
    }
  } catch (error) {
    if (error instanceof TripoError) throw error;
    if (!signal.aborted) throw new TripoError('NETWORK_ERROR', 'Event stream disconnected.', 'read');
  } finally {
    signal.removeEventListener('abort', stop);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** 返回已读取事件和最后游标；断线只重连订阅，不重提任务，SIGINT 由调用进程结束连接。 */
export async function readCanvasEvents(
  studio: StudioClient,
  input: unknown,
  onEvent?: (event: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const x = eventSchema.parse(input);
  const account = studio.credentials.load()?.accountRef;
  if (!account) throw new TripoError('AUTH_REQUIRED', 'Sign in to Studio first.');
  const client = new CanvasClient(studio.forAccount(account));
  const deadline = Date.now() + x.wait_seconds * 1000;
  const signal = AbortSignal.timeout(x.wait_seconds * 1000);
  const collector = new Collector(x.after_id);
  let reconnects = 0;
  let streamError: string | undefined;
  const method = x.kind === 'lab' ? 'LabService/SubscribeLabEvents' : 'CanvasService/SubscribeAgentEvents';
  while (!signal.aborted && !collector.complete && collector.events.length < x.max_events) {
    try {
      const response = await client.stream(
        `/tripo.canvas.api.agent.${method}`,
        {
          afterId: collector.cursor,
          ...(x.kind === 'lab' ? { jobId: x.id } : { turnId: x.id }),
        },
        signal,
      );
      await consume(response, signal, collector, x.max_events, onEvent);
    } catch (error) {
      if (signal.aborted) break;
      if (!(error instanceof TripoError) || error.code !== 'NETWORK_ERROR') throw error;
      streamError = error.code;
    }
    if (collector.complete || collector.events.length >= x.max_events || signal.aborted) break;
    if (reconnects >= 2) break;
    reconnects++;
    await delay(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  return {
    kind: x.kind,
    id: x.id,
    events: collector.events,
    after_id: collector.cursor,
    complete: collector.complete,
    timed_out: signal.aborted,
    reconnects,
    count: collector.events.length,
    ...(!collector.complete && streamError ? { stream_error: streamError } : {}),
  };
}
