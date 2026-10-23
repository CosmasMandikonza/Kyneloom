'use client';

import type { LiveConnectionStatus } from '@kyneloom/match-core';
import type { LiveStreamState } from '@/lib/live/use-live-stream';

/**
 * KYN-13 — the stream status treatment (mission §7). Compact, cinematic,
 * no dashboard telemetry over the stadium. The green LIVE dot appears ONLY
 * when the genuine streaming connection is established AND fresh state has
 * been applied (defined health rule) — a locally played fixture is labeled
 * "Recorded replay", never LIVE.
 */

const STATUS_LABEL: Record<LiveConnectionStatus, string> = {
  connecting: 'Connecting',
  connected: 'Connected — synthetic stream',
  reconnecting: 'Reconnecting',
  degraded: 'Degraded — tracking unavailable',
  resynchronizing: 'Resynchronizing',
  disconnected: 'Disconnected',
};

export function LiveStatusChip({
  live,
  liveHealthy,
}: {
  readonly live: LiveStreamState;
  readonly liveHealthy: boolean;
}): React.JSX.Element | null {
  const degraded =
    live.status === 'connected' && (!live.trackingAvailable || live.trackingCount === 0);
  const status: LiveConnectionStatus = degraded ? 'degraded' : live.status;
  return (
    <div
      className="livechip"
      data-live-status={status}
      data-testid="live-status"
      role="status"
      aria-live="polite"
    >
      <span
        className={`livechip__dot${liveHealthy ? ' livechip__dot--live' : ''}`}
        aria-hidden="true"
      />
      <span className="livechip__label mono">{STATUS_LABEL[status]}</span>
      {live.stateVersion !== null ? (
        <span className="livechip__meta mono" aria-hidden="true">
          v{live.stateVersion.slice(0, 6)}·{String(live.seq)}
        </span>
      ) : null}
    </div>
  );
}

/** Mode selector: recorded fixture vs connected stream (a real choice). */
export function LiveModeButtons({
  liveActive,
  onToggle,
  disabled,
}: {
  readonly liveActive: boolean;
  readonly onToggle: (next: boolean) => void;
  readonly disabled: boolean;
}): React.JSX.Element {
  return (
    <div className="stage__mode-group" role="group" aria-label="Viewing mode">
      <button
        type="button"
        className="stage__mode-btn"
        aria-pressed={!liveActive}
        disabled={disabled}
        title="The committed, fully verified fixture — offline, deterministic"
        onClick={() => onToggle(false)}
      >
        Recorded replay
      </button>
      <button
        type="button"
        className="stage__mode-btn stage__mode-btn--live"
        aria-pressed={liveActive}
        disabled={disabled}
        title="Connect to the live synthetic stream — real streaming delivery of the same source"
        onClick={() => onToggle(true)}
        data-testid="live-mode-toggle"
      >
        Live synthetic stream
      </button>
    </div>
  );
}
