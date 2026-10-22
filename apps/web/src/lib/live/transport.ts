'use client';

import type { LiveFrame, LiveConnectionStatus } from '@kyneloom/match-core';

/**
 * KYN-13 — the client-level transport interface. The LOCAL implementation
 * is SSE against /api/live/stream; the AZURE implementation (when
 * provisioned) is the Web PubSub client over the negotiated connection —
 * both present this exact interface, so the viewer has ONE business logic
 * path (mission §5).
 */

export interface LiveTransport {
  /** Open the connection. Resolves once the transport link is up. */
  connect(): Promise<void>;
  /** Register the frame listener (snapshot/delta/status). */
  onFrame(listener: (frame: unknown) => void): void;
  /** Link-level lifecycle signals. */
  onStatus(listener: (status: LiveConnectionStatus, detail: string) => void): void;
  /** Fetch the current canonical snapshot (resync path). */
  fetchSnapshot(): Promise<LiveFrame | null>;
  close(): void;
}

export class LocalSseTransport implements LiveTransport {
  private source: EventSource | null = null;
  private frameListener: ((frame: unknown) => void) | null = null;
  private statusListener: ((status: LiveConnectionStatus, detail: string) => void) | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly speed: 1 | 2 | 4 = 2,
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const source = new EventSource(`${this.baseUrl}/api/live/stream?speed=${String(this.speed)}`);
      this.source = source;
      source.addEventListener('hello', () => resolve(), { once: true });
      source.onerror = () => {
        if (this.statusListener !== null) {
          this.statusListener('reconnecting', 'SSE link lost — browser auto-retry');
        }
        // EventSource retries automatically; resolve the initial connect on
        // the next hello so callers never wedge.
        source.addEventListener('hello', () => resolve(), { once: true });
      };
      for (const kind of ['snapshot', 'delta', 'status']) {
        source.addEventListener(kind, (event) => {
          try {
            const frame = JSON.parse((event as MessageEvent<string>).data);
            this.frameListener?.(frame);
          } catch {
            /* malformed frame: the sync controller's validation handles it */
          }
        });
      }
      // Software renderers can starve SSE dispatch for many seconds while the
      // recorded scene still draws — the window is generous (KYN-12 lesson).
      setTimeout(() => reject(new Error('SSE connect timeout')), 60_000);
    });
  }

  onFrame(listener: (frame: unknown) => void): void {
    this.frameListener = listener;
  }

  onStatus(listener: (status: LiveConnectionStatus, detail: string) => void): void {
    this.statusListener = listener;
  }

  async fetchSnapshot(): Promise<LiveFrame | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/live/snapshot`, { cache: 'no-store' });
      if (!res.ok) return null;
      const body = (await res.json()) as { ok: boolean; frame?: LiveFrame };
      return body.ok === true ? (body.frame ?? null) : null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.source?.close();
    this.source = null;
  }
}
