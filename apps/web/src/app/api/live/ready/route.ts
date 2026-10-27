import { NextResponse } from 'next/server';
import { LiveMatchService } from '@/lib/live/service';
import { azureRuntimeStatus } from '@/lib/live/azure-runtime';

/**
 * KYN-14 — WORKER READINESS (not process liveness). 200 only when a real
 * stream session is active: the local producer running, or a cloud-fed
 * session with a successful receive (not merely a subscription attempt).
 * This is the Container App
 * readiness probe: an HTTP 200 from the process alone is NOT proof that
 * Event Hubs consumption began (review C3).
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const service = LiveMatchService.get();
  const running = service.status.running;
  const azure = azureRuntimeStatus();
  const ready = running && (!service.isExternalSession || azure.active);
  const body = {
    ok: ready,
    mode: service.isExternalSession ? 'cloud-fed' : running ? 'local' : 'none',
    azureRuntime: azure,
  };
  return NextResponse.json(body, {
    status: ready ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
