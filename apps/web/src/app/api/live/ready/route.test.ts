import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LiveMatchService } from '@/lib/live/service';
import { GET } from './route';

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
  it('503 when no session is active; 200 + cloud-fed mode after beginExternalSession', async () => {
    const service = LiveMatchService.get();
    service.stop();
    const stopped = await GET();
    expect(stopped.status).toBe(503);
    const stoppedBody = (await stopped.json()) as { ok: boolean; mode: string };
    expect(stoppedBody.ok).toBe(false);
    expect(stoppedBody.mode).toBe('none');

    service.beginExternalSession('ready-gen');
    const ready = await GET();
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as {
      ok: boolean;
      mode: string;
      azureRuntime: { active: boolean };
    };
    expect(readyBody.ok).toBe(true);
    expect(readyBody.mode).toBe('cloud-fed');
    expect(readyBody.azureRuntime.active).toBe(false); // runtime seam not started in this test

    service.endExternalSession('test complete');
    const ended = await GET();
    expect(ended.status).toBe(503);
  });
});
