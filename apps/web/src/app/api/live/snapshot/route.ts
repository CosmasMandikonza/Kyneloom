import { NextResponse } from 'next/server';
import { LiveMatchService } from '@/lib/live/service';
import { azureModeRequested } from '@/lib/live/azure-adapters';
import { azureRuntimeStatus } from '@/lib/live/azure-runtime';

/**
 * KYN-13 — canonical snapshot endpoint (reconnect/resync path). Returns the
 * authoritative versioned snapshot frame for the public synthetic match.
 * Read-only; no credentials; no group control.
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const service = LiveMatchService.get();
  if (
    (azureModeRequested(process.env) && !azureRuntimeStatus().active) ||
    !service.status.running
  ) {
    return NextResponse.json(
      { ok: false, code: 'stream-not-running', detail: 'no live session is active' },
      { status: 503 },
    );
  }
  const frame = service.snapshotFrame();
  return NextResponse.json({ ok: true, frame }, { headers: { 'Cache-Control': 'no-store' } });
}
