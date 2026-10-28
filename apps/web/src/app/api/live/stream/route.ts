import { NextResponse } from 'next/server';
import { LiveMatchService } from '@/lib/live/service';
import { azureModeRequested } from '@/lib/live/azure-adapters';
import { azureRuntimeStatus } from '@/lib/live/azure-runtime';
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

  // PUBLIC auto-start ONLY for the initial idle demo (review round 5): an
  // intentional operator STOP must stay stopped — a viewer's EventSource
  // reconnect can never reverse the operator's decision by hitting this
  // endpoint. Only an explicitly issued start() (the authorized control
  // route) clears the operator-stopped state.
  // KYN-14: in AZURE mode (full adapter env contract present) the local
  // producer NEVER auto-starts — envelopes arrive from Event Hubs via the
  // in-process ingestion worker, and a second producer would violate the
  // one-authoritative-producer law.
  const azureMode = azureModeRequested(process.env);
  if (!service.status.running && !service.isOperatorStopped && !azureMode) {
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
  // This connection's GENERATION. The loop's lifetime is bound to it: an
  // immediate operator restart (stop+start within one poll interval) leaves
  // `running` true again before the next check, but the session id has
  // rotated — this subscriber belongs to the dead generation and will never
  // receive a new-generation snapshot (those are queued only at subscribe).
  // Closing truthfully forces the browser's EventSource reconnect, which
  // resubscribes and adopts the new generation via hello+snapshot.
  const generation = service.status.sessionId;

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
        // The connection's OWN generation (captured at subscribe above) —
        // a live read here could already name a replacement generation.
        sessionId: generation,
        transport: 'local-sse',
        subscriberId,
      });
      // Deterministic reconnect cadence for the browser's EventSource retry.
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      try {
        while (Date.now() - startedAt < MAX_STREAM_MS) {
          // GENERATION GUARD FIRST — before reading or transmitting ANY
          // subscriber frame (review round 4): an immediate restart can
          // enqueue NEW-generation deltas into this (still-registered) old
          // subscriber's queue before its next poll. Draining first would
          // transmit foreign-generation frames on a retired socket. The
          // check and the drain/send below are one synchronous block, so no
          // broadcast can interleave between them; after every await the
          // guard re-runs before anything is sent.
          if (
            (azureMode && !azureRuntimeStatus().active) ||
            !service.status.running ||
            service.status.sessionId !== generation
          ) {
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
          const frames = service.drain(subscriberId, 8);
          for (const frame of frames) send(frame);
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
