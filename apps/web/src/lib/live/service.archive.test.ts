import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STREAM_CONTRACT_VERSION, type StreamEnvelope } from '@kyneloom/match-core';

const temporaryRoots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('external ingestion local archive initialization', () => {
  it('a fresh external session can archive, quarantine and checkpoint without a local fixture start', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kyn14-external-'));
    temporaryRoots.push(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.resetModules(); // ARCHIVE_ROOT and the singleton must belong to this fresh container.
    const { LiveMatchService } = await import('./service');
    const service = LiveMatchService.get();
    const directory = path.join(root, '.live-archive', service.matchId);
    expect(existsSync(directory)).toBe(false);
    service.beginExternalSession('external-fresh');
    try {
      expect(existsSync(directory)).toBe(true);
      const batch: StreamEnvelope[] = [
        {
          contractVersion: STREAM_CONTRACT_VERSION,
          envelopeId: 'env-quarantined',
          matchId: service.matchId,
          kind: 'tracking',
          emittedAt: 1000,
          traceId: 'trace-fresh',
          // Deliberately absent tracking payload exercises durable quarantine.
        },
      ];
      expect(() => service.ingest(batch)).not.toThrow();
      expect(service.status.running).toBe(true);
      expect(service.status.quarantined).toBe(1);
      expect(readFileSync(path.join(directory, 'envelopes.jsonl'), 'utf-8')).toContain(
        'env-quarantined',
      );
      expect(readFileSync(path.join(directory, 'quarantine.jsonl'), 'utf-8')).toContain(
        'trace-fresh',
      );
      expect(
        JSON.parse(readFileSync(path.join(directory, 'checkpoint.json'), 'utf-8')),
      ).toMatchObject({ checkpointEnvelopeId: 'env-quarantined', sessionId: 'external-fresh' });
      expect(service.isExternalSession).toBe(true);
    } finally {
      service.endExternalSession('test complete');
    }
  });

  it('directory initialization failure cannot claim a running external session', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kyn14-blocked-'));
    temporaryRoots.push(root);
    // A file in place of the root directory reliably denies mkdir, even as root.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(root, '.live-archive'), 'not a directory');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.resetModules();
    const { LiveMatchService } = await import('./service');
    const service = LiveMatchService.get();
    expect(() => service.beginExternalSession()).toThrow();
    expect(service.status.running).toBe(false);
    expect(service.isExternalSession).toBe(false);
  });
});
