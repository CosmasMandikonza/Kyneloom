import { NextResponse } from 'next/server';
import { LiveMatchService } from '@/lib/live/service';
import type { LiveFrame } from '@kyneloom/match-core';

/**
 * KYN-13 — the local delivery transport (server→browser): Server-Sent
 * Events presenting the SAME client-level stream interface the Azure Web
 * PubSub transport presents. A subscriber receives: the canonical snapshot
 * first, then contiguous deltas; when the bounded queue had to compact or
 * drop, the service marks the subscriber for snapshot resync (the client's
 * gap detection also guards independently).
 *
 * Negotiation contract (mirrors what the Web PubSub route will do when
 * provisioned — docs/09, Issue #21 pending): this endpoint is scoped to
 * the PUBLIC synthetic demo match only; there is no publish path, no
 * credentials in the browser, and no group beyond the one synthetic match.
 */

export const dynamic = 'force-dynamic';

const POLL_MS = 120;
const MAX_STREAM_MS = 10 * 60 * 1000; // viewer re-negotiates on reconnect

export async function GET(request: Request): Promise<Response> {
  const service = LiveMatchService.get();
  const url = new URL(request.url);
  const speedParam = url.searchParams.get('speed');
  const speed =
    speedParam === '1' || speedParam === '2' || speedParam === '4'
      ? (Number(speedParam) as 1 | 2 | 4)
      : 2;

  if (!service.status.running) {
    try {
      await service.start({ speed });
    } catch (error) {
      return NextResponse.json(
        { ok: false, code: 'stream-unavailable', detail: String(error).slice(0, 160) },
        { status: 503 },
      );
    }
  }

  const subscriberId = `sub-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`;
  service.subscribe(subscriberId);
  const startedAt = Date.now();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: LiveFrame | { type: string; [key: string]: unknown }): void => {
        controller.enqueue(
          encoder.encode(`event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`),
        );
      };
      send({
        type: 'hello',
        matchId: service.matchId,
        sessionId: service.status.sessionId,
        transport: 'local-sse',
        subscriberId,
      });
      try {
        while (Date.now() - startedAt < MAX_STREAM_MS) {
          const frames = service.drain(subscriberId, 8);
          for (const frame of frames) send(frame);
          // The producer genuinely stopped (operator control / stream end):
          // tell the truth and CLOSE — reconnecting clients resynchronize.
          if (!service.status.running) {
            send({
              type: 'status',
              matchId: service.matchId,
              sessionId: service.status.sessionId,
              seq: 0,
              status: 'disconnected',
              detail: 'stream stopped — reconnect to resynchronize',
              traceId: '',
            });
            break;
          }
          // Keep-alive comment so proxies don't idle the connection.
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        send({
          type: 'status',
          matchId: service.matchId,
          sessionId: service.status.sessionId,
          seq: 0,
          status: 'disconnected',
          detail: 'stream window elapsed — reconnect',
          traceId: '',
        });
      } catch {
        // Client disconnected: nothing to fabricate, just clean up.
      } finally {
        service.unsubscribe(subscriberId);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      service.unsubscribe(subscriberId);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
