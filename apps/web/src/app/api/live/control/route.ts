import { NextResponse } from 'next/server';
import { LiveMatchService } from '@/lib/live/service';

/**
 * KYN-13 — LOCAL OPERATOR control for the demo stream (start/stop/restart
 * with optional chaos). This is the honest way to interrupt the stream for
 * demonstrations and QA: stopping the producer genuinely ends the stream
 * (the SSE loop closes with a disconnected status frame), and restarting it
 * makes reconnecting clients resynchronize from the canonical snapshot.
 *
 * Scope: the public synthetic demo only; no credentials, no publishing of
 * match state (envelopes always flow producer → worker → viewers).
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, code: 'malformed-body' }, { status: 400 });
  }
  const action = (body as { action?: unknown }).action;
  const service = LiveMatchService.get();

  if (action === 'stop') {
    service.stop();
    return NextResponse.json({ ok: true, running: service.status.running });
  }
  if (action === 'start') {
    try {
      await service.start({ speed: 4 });
    } catch (error) {
      return NextResponse.json(
        { ok: false, code: 'stream-unavailable', detail: String(error).slice(0, 160) },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: true, running: service.status.running });
  }
  if (action === 'restart') {
    service.stop();
    await service.start({ speed: 4 });
    return NextResponse.json({ ok: true, running: service.status.running });
  }
  return NextResponse.json(
    { ok: false, code: 'unsupported-action', detail: 'action must be start|stop|restart' },
    { status: 400 },
  );
}
