import { NextResponse } from 'next/server';
import { LiveMatchService } from '@/lib/live/service';
import { azureRuntimeStatus } from '@/lib/live/azure-runtime';

/**
 * KYN-13 — operational status + latency telemetry for the local transport
 * (consumer-facing health, message rate, quarantine/archive counts). When
 * the Azure worker is deployed this reports the same shape from the real
 * Event Hubs/Web PubSub pipeline, plus the KYN-14 cloud-runtime
 * diagnostics (replay/ingestion truthfulness). Read-only; PROCESS
 * liveness only — worker READINESS is /api/live/ready.
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const service = LiveMatchService.get();
  return NextResponse.json(
    {
      ok: true,
      status: service.status,
      mode: service.isExternalSession ? 'cloud-fed' : 'local',
      azureRuntime: azureRuntimeStatus(),
      latency: service.latencySamples().slice(-50),
      integrityFingerprint: service.integrityFingerprint(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
