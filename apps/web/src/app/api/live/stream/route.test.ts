import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LiveMatchService } from '@/lib/live/service';
import { GET } from './route';

/**
 * KYN-13 review round 3, blocker 1 — an IMMEDIATE authorized restart
 * (stop + start completing between SSE polling intervals) must never
 * strand an already-connected subscriber in the dead generation: every
 * existing connection is closed truthfully (a disconnected status frame,
 * then stream end), forcing the browser's EventSource reconnect, which
 * resubscribes and adopts the NEW generation via hello + snapshot.
 */

interface SseEvent {
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

function parseEvents(chunk: string, buffer: { text: string }): SseEvent[] {
  buffer.text += chunk;
  const events: SseEvent[] = [];
  for (;;) {
    const boundary = buffer.text.indexOf('\n\n');
    if (boundary === -1) break;
    const raw = buffer.text.slice(0, boundary);
    buffer.text = buffer.text.slice(boundary + 2);
    let kind = 'message';
    let data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event: ')) kind = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (kind === 'message' || data === '') continue; // comments/keep-alives
    try {
      events.push({ kind, data: JSON.parse(data) as Record<string, unknown> });
    } catch {
      /* malformed — ignore */
    }
  }
  return events;
}

async function openStream(): Promise<{
  next: (ms: number) => Promise<SseEvent | null>;
}> {
  const response = await GET(new Request('http://127.0.0.1/api/live/stream?speed=4'));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const buffer = { text: '' };
  const queue: SseEvent[] = [];
  let done = false;
  const pull = async (): Promise<void> => {
    const read = await reader.read();
    if (read.done) {
      done = true;
      return;
    }
    queue.push(...parseEvents(decoder.decode(read.value, { stream: true }), buffer));
  };
  return {
    next: async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (queue.length > 0) return queue.shift()!;
        if (done) return null;
        if (Date.now() > deadline) throw new Error('timed out waiting for an SSE event');
        await Promise.race([pull(), new Promise((r) => setTimeout(r, 50))]);
      }
    },
  };
}

async function drainUntil(
  stream: Awaited<ReturnType<typeof openStream>>,
  predicate: (event: SseEvent) => boolean,
  timeoutMs: number,
): Promise<SseEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const event = await stream.next(deadline - Date.now());
    if (event !== null && predicate(event)) return event;
    if (event === null) throw new Error('stream ended before the expected event');
    if (Date.now() > deadline) throw new Error('expected SSE event not observed');
  }
}

const archiveDir = path.join(process.cwd(), '.live-archive');

afterAll(() => {
  rmSync(archiveDir, { recursive: true, force: true });
});

describe('immediate restart between poll intervals (two existing SSE viewers)', () => {
  it('closes both existing connections truthfully; a fresh connection adopts the new generation', async () => {
    const service = LiveMatchService.get();
    service.stop();
    await service.start({ sessionId: 'gen-a', speed: 4 });
    const generationA = service.status.sessionId;
    expect(generationA).toBe('gen-a');

    // TWO existing viewers on open connections.
    const viewer1 = await openStream();
    const viewer2 = await openStream();
    const hello1 = await drainUntil(viewer1, (e) => e.kind === 'hello', 10_000);
    const hello2 = await drainUntil(viewer2, (e) => e.kind === 'hello', 10_000);
    expect(hello1.data.sessionId).toBe('gen-a');
    expect(hello2.data.sessionId).toBe('gen-a');
    await drainUntil(viewer1, (e) => e.kind === 'snapshot', 10_000);
    await drainUntil(viewer2, (e) => e.kind === 'snapshot', 10_000);

    // The IMMEDIATE operator restart: stop + start with no waiting between
    // (may complete between the route's 120 ms polls — the stranding case).
    service.stop();
    await service.start({ sessionId: 'gen-b', speed: 4 });
    expect(service.status.sessionId).toBe('gen-b');

    // Both existing connections must be closed TRUTHFULLY: disconnected
    // status frame(s) — stop()'s queued frame and/or the loop's
    // generation-check frame — then end-of-stream (forcing the browser's
    // EventSource reconnect). No new-generation snapshot/delta is ever
    // delivered on the dead connection.
    for (const viewer of [viewer1, viewer2]) {
      const status = await drainUntil(viewer, (e) => e.kind === 'status', 10_000);
      expect(status.data.status).toBe('disconnected');
      for (;;) {
        const tail = await viewer.next(10_000);
        if (tail === null) break; // stream ended
        expect(tail.kind).toBe('status');
        expect(tail.data.status).toBe('disconnected');
      }
    }

    // A fresh connection adopts the NEW generation.
    const viewer3 = await openStream();
    const hello3 = await drainUntil(viewer3, (e) => e.kind === 'hello', 10_000);
    expect(hello3.data.sessionId).toBe('gen-b');
    const snapshot3 = await drainUntil(viewer3, (e) => e.kind === 'snapshot', 10_000);
    expect(snapshot3.data.sessionId).toBe('gen-b');
    service.stop();
  });
});
