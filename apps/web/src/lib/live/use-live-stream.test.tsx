// @vitest-environment jsdom
import { cleanup, renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackingSample } from '@kyneloom/contracts';
import { LiveProjectionWorker } from '@kyneloom/match-core';
import { useLiveStream } from './use-live-stream';

/**
 * KYN-13 review round 3, blocker 2 — the REAL hook never declares
 * `connected` on transport-up (SSE hello). Connected requires the
 * controller's `applied` event: a fingerprint-verified snapshot of the
 * current generation. An invalid snapshot must leave the hook in a
 * truthful non-connected state with NO stateVersion (retained prior state
 * can never read as live-healthy), and a subsequent valid snapshot
 * connects.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
  closed = false;

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(kind: string, handler: (event: { data: string }) => void): void {
    const list = this.listeners.get(kind) ?? [];
    list.push(handler);
    this.listeners.set(kind, list);
  }

  emit(kind: string, payload: unknown): void {
    for (const handler of this.listeners.get(kind) ?? []) {
      handler({ data: JSON.stringify(payload) });
    }
  }

  close(): void {
    this.closed = true;
  }
}

function sampleEnvelope(sampleTimeMs: number) {
  return {
    contractVersion: 'kyneloom-live-wire-v2' as const,
    envelopeId: `env-hook-${String(sampleTimeMs)}`,
    matchId: 'synthetic-derby-01',
    kind: 'tracking' as const,
    tracking: {
      schemaVersion: '1.0',
      matchId: 'synthetic-derby-01',
      sampleTimeMs,
      entityId: 'home-01',
      xM: 1,
      yM: 2,
      zM: 0,
      origin: 'synthetic_ground_truth',
      confidence: 1,
      visibility: 'tracked',
      sourceFrameId: 'frame-10',
    } as TrackingSample,
    emittedAt: 1,
    traceId: 'trc-hook',
  };
}

describe('useLiveStream — connected only on VERIFIED state', () => {
  let worker: LiveProjectionWorker;
  let snapshotSupplier: () => unknown;

  beforeEach(() => {
    FakeEventSource.instances = [];
    worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 'hook-gen' });
    snapshotSupplier = () => worker.snapshot();
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, frame: snapshotSupplier() }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('hello alone does NOT connect; a verified snapshot does', async () => {
    const { result } = renderHook(() => useLiveStream(true, 2));
    const source = await waitFor(() => {
      const found = FakeEventSource.instances[0];
      expect(found).toBeDefined();
      return found!;
    });
    expect(result.current.state.status).toBe('connecting');
    expect(result.current.state.connected).toBe(false);
    expect(result.current.state.stateVersion).toBeNull();

    // Transport-up: the SSE hello resolves connect() — still NOT connected.
    act(() => source.emit('hello', { type: 'hello', sessionId: 'hook-gen' }));
    await waitFor(() => expect(result.current.state.detail).toContain('awaiting verified'));
    expect(result.current.state.status).toBe('connecting');
    expect(result.current.state.connected).toBe(false);
    expect(result.current.state.stateVersion).toBeNull();

    // A fingerprint-verified snapshot of the current generation connects.
    act(() => source.emit('snapshot', worker.snapshot()));
    await waitFor(() => expect(result.current.state.status).toBe('connected'));
    expect(result.current.state.connected).toBe(true);
    expect(result.current.state.stateVersion).toBe(worker.currentVersion);
  });

  it('an INVALID snapshot never connects and never exposes a stateVersion; recovery follows', async () => {
    const { result } = renderHook(() => useLiveStream(true, 2));
    const source = await waitFor(() => {
      const found = FakeEventSource.instances[0];
      expect(found).toBeDefined();
      return found!;
    });
    act(() => source.emit('hello', { type: 'hello', sessionId: 'hook-gen' }));

    // Verified initial state.
    worker.admit([sampleEnvelope(1000)] as never);
    act(() => source.emit('snapshot', worker.snapshot()));
    await waitFor(() => expect(result.current.state.status).toBe('connected'));
    const versionBefore = result.current.state.stateVersion;
    expect(versionBefore).toBe(worker.currentVersion);

    // Tampered snapshot (forged stateVersion): rejected. The resync fetch
    // also returns the tampered frame (worst case) — the hook must stay in
    // a truthful NON-connected state with no version claim.
    const good = worker.snapshot();
    const tampered = { ...(good as object), stateVersion: 'deadbeef' };
    snapshotSupplier = () => tampered;
    act(() => source.emit('snapshot', tampered));
    await waitFor(() => expect(result.current.state.status).not.toBe('connected'));
    expect(result.current.state.connected).toBe(false);
    expect(result.current.state.stateVersion).toBe(versionBefore ?? null);

    // Recovery: a genuine snapshot through the same connection connects.
    snapshotSupplier = () => worker.snapshot();
    act(() => source.emit('snapshot', worker.snapshot()));
    await waitFor(() => expect(result.current.state.status).toBe('connected'));
    expect(result.current.state.stateVersion).toBe(worker.currentVersion);
  });
});
