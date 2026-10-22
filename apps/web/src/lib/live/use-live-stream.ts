'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Timeline } from '@kyneloom/match-core';
import type { MatchEvent } from '@kyneloom/contracts';
import {
  LiveSyncController,
  type LiveConnectionStatus,
  type SyncEvent,
} from '@kyneloom/match-core';
import { LocalSseTransport, type LiveTransport } from './transport';

/**
 * KYN-13 — the React hook bridging the live stream into the viewer.
 *
 * Owns NO football semantics: the LiveSyncController applies the canonical
 * rules and this hook only surfaces { status, timeline, events, version,
 * matchTimeMs } for the stage to render. The stage swaps its engine's
 * frame-cache function when `timeline` changes — the 3D renderer is never
 * remounted, and the stream connection is never recreated on lens/camera
 * changes (the hook lives above the stage internals).
 */

export interface LiveStreamState {
  readonly status: LiveConnectionStatus;
  readonly detail: string;
  readonly connected: boolean;
  readonly stateVersion: string | null;
  readonly seq: number;
  readonly matchTimeMs: number;
  readonly sourceRevision: number;
  readonly timeline: Timeline | null;
  readonly acceptedEvents: readonly MatchEvent[];
  readonly trackingCount: number;
  readonly trackingAvailable: boolean;
  readonly gapCount: number;
}

export interface UseLiveStream {
  readonly state: LiveStreamState;
  readonly disconnect: () => void;
  readonly reconnect: () => void;
}

export function useLiveStream(enabled: boolean, speed: 1 | 2 | 4 = 2): UseLiveStream {
  const [state, setState] = useState<LiveStreamState>({
    status: 'connecting',
    detail: '',
    connected: false,
    stateVersion: null,
    seq: 0,
    matchTimeMs: 0,
    sourceRevision: 0,
    timeline: null,
    acceptedEvents: [],
    trackingCount: 0,
    trackingAvailable: false,
    gapCount: 0,
  });
  const controllerRef = useRef<LiveSyncController | null>(null);
  const transportRef = useRef<LiveTransport | null>(null);
  const [nonce, setNonce] = useState(0);

  const reconnect = useCallback(() => setNonce((n) => n + 1), []);
  const disconnect = useCallback(() => {
    transportRef.current?.close();
    transportRef.current = null;
    setState((current) => ({ ...current, status: 'disconnected', connected: false }));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const transport = new LocalSseTransport(window.location.origin, speed);
    transportRef.current = transport;
    const controller = new LiveSyncController({
      fetchSnapshot: () => transport.fetchSnapshot(),
      onEvent: (event: SyncEvent) => {
        if (cancelled) return;
        if (event.type === 'status') {
          setState((current) => ({
            ...current,
            status: event.status,
            detail: event.detail,
            connected: event.status === 'connected',
          }));
        } else if (event.type === 'gap') {
          setState((current) => ({ ...current, gapCount: current.gapCount + 1 }));
        } else {
          setState((current) => ({
            ...current,
            status: 'connected',
            detail: 'synthetic stream',
            connected: true,
            stateVersion: event.stateVersion,
            seq: event.seq,
            matchTimeMs: event.matchTimeMs,
            sourceRevision: event.sourceRevision,
            timeline: event.timeline,
            acceptedEvents: event.acceptedEvents,
            trackingCount: event.trackingCount,
            trackingAvailable: event.trackingAvailable,
          }));
        }
      },
    });
    controllerRef.current = controller;

    transport.onFrame((frame) => {
      controller.applyFrame(frame);
      // Server-lifecycle status frames are authoritative for the chip: a
      // 'disconnected' from the stream means the producer genuinely stopped.
      if (
        typeof frame === 'object' &&
        frame !== null &&
        (frame as { type?: string }).type === 'status'
      ) {
        const statusFrame = frame as { status?: LiveConnectionStatus; detail?: string };
        if (statusFrame.status === 'disconnected') {
          controller.setStatus('disconnected', statusFrame.detail ?? 'stream stopped');
        }
      }
    });
    transport.onStatus((status, detail) => {
      if (status === 'reconnecting') controller.onDisconnect(detail);
    });

    void (async () => {
      try {
        await transport.connect();
        if (cancelled) return;
        controller.setStatus('connected', 'transport connected — awaiting snapshot');
      } catch {
        if (!cancelled) controller.setStatus('disconnected', 'transport failed to connect');
      }
    })();

    return () => {
      cancelled = true;
      transport.close();
    };
  }, [enabled, speed, nonce]);

  return useMemo(() => ({ state, disconnect, reconnect }), [state, disconnect, reconnect]);
}
