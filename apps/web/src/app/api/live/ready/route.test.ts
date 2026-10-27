import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { LiveMatchService } from '@/lib/live/service';
import { GET } from './route';
import { azureRuntimeStatus } from '@/lib/live/azure-runtime';

vi.mock('@/lib/live/azure-runtime', () => ({
  azureRuntimeStatus: vi.fn(() => ({
    active: false,
    detail: 'starting',
    replayedEnvelopes: 0,
    archivedBatches: 0,
  })),
}));

/**
 * KYN-14 review C3 — /api/live/ready is WORKER readiness, not process
 * liveness: 503 with no active session (local or cloud-fed), 200 with the
 * truthful mode reported.
 */
const archiveDir = path.join(process.cwd(), '.live-archive');

afterAll(() => {
  rmSync(archiveDir, { recursive: true, force: true });
});

describe('/api/live/ready — worker readiness', () => {
  it('partial cloud intent remains unready and is never reported as local', async () => {
    vi.mocked(azureRuntimeStatus).mockReturnValue({
      active: false,
      detail: 'incomplete Azure configuration',
      replayedEnvelopes: 0,
      archivedBatches: 0,
    });
    vi.stubEnv('KYN_EVENTHUBS_NAMESPACE', 'partial');
    try {
      const response = await GET();
      expect(response.status).toBe(503);
      expect((await response.json()).mode).toBe('cloud-fed');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('keeps the real local fixture producer ready without an Azure runtime', async () => {
    vi.mocked(azureRuntimeStatus).mockReturnValue({
      active: false,
      detail: 'local mode',
      replayedEnvelopes: 0,
      archivedBatches: 0,
    });
    const service = LiveMatchService.get();
    await service.start();
    try {
      const response = await GET();
      expect(response.status).toBe(200);
      expect((await response.json()).mode).toBe('local');
    } finally {
      service.stop();
    }
  });

  it('503 when no session is active; 200 + cloud-fed mode after beginExternalSession', async () => {
    const service = LiveMatchService.get();
    service.stop();
    const stopped = await GET();
    expect(stopped.status).toBe(503);
    const stoppedBody = (await stopped.json()) as { ok: boolean; mode: string };
    expect(stoppedBody.ok).toBe(false);
    expect(stoppedBody.mode).toBe('none');

    service.beginExternalSession('ready-gen');
    const starting = await GET();
    expect(starting.status).toBe(503);
    vi.mocked(azureRuntimeStatus).mockReturnValue({
      active: true,
      detail: 'receiving',
      replayedEnvelopes: 0,
      archivedBatches: 0,
    });
    const ready = await GET();
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as {
      ok: boolean;
      mode: string;
      azureRuntime: { active: boolean };
    };
    expect(readyBody.ok).toBe(true);
    expect(readyBody.mode).toBe('cloud-fed');
    expect(readyBody.azureRuntime.active).toBe(true);

    vi.mocked(azureRuntimeStatus).mockReturnValue({
      active: false,
      detail: 'consumer failed',
      replayedEnvelopes: 0,
      archivedBatches: 0,
    });
    expect((await GET()).status).toBe(503);

    service.endExternalSession('test complete');
    const ended = await GET();
    expect(ended.status).toBe(503);
  });
});
