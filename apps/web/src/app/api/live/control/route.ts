import { NextResponse } from 'next/server';
import { LiveMatchService } from '@/lib/live/service';
import {
  decideLiveControl,
  LIVE_CONTROL_HEADER,
  LIVE_CONTROL_TOKEN_ENV,
} from '@/lib/live/control-auth';

/**
 * KYN-13 — LOCAL OPERATOR control for the demo stream (start/stop/restart
 * with optional chaos). This is the honest way to interrupt the stream for
 * demonstrations and QA: stopping the producer genuinely ends the stream
 * (the SSE loop closes with a disconnected status frame), and restarting it
 * makes reconnecting clients resynchronize from the canonical snapshot.
 *
 * AUTHORIZATION (review gate A): mutations are FAIL CLOSED. The route is
 * disabled unless the operator provisions `KYNELOOM_LIVE_CONTROL_TOKEN` in
 * the server environment; callers must present it via the
 * `x-kyneloom-live-control` header (constant-time compare). Anonymous or
 * wrong-token requests are denied 403 and the stream is untouched — a
 * public viewer can never stop or restart the match for everyone. No
 * cookie auth (no CSRF surface); no fabricated role/tenant claims. Real
 * operator identity belongs to Issue #21. Never deploy this route without
 * the token provisioned.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const decision = decideLiveControl(
    process.env[LIVE_CONTROL_TOKEN_ENV],
    request.headers.get(LIVE_CONTROL_HEADER),
  );
  if (!decision.ok) {
    return NextResponse.json({ ok: false, code: decision.code }, { status: 403 });
  }

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
