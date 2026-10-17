'use client';

import { formatMatchClockTenths } from '@/lib/clock';
import type { EvidenceProjection } from '@/lib/evidence-data';

/**
 * Evidence X-Ray source inspector (KYN-08): compact, contextual, honest.
 * Shows exactly how the measurement was calculated (plain language + the
 * authoritative fields), the original source frame IDs on demand, and the
 * interpretation boundary — the measured distance change is a calculated
 * fact; the tactical reading is a hypothesis. Collapsible; frame navigation
 * seeks the transport WITHOUT touching camera mode or player selection
 * (the caller restores the playhead on return).
 */

export interface EvidenceInspectorProps {
  readonly evidence: EvidenceProjection;
  readonly open: boolean;
  readonly sourcesExpanded: boolean;
  readonly onToggleSources: () => void;
  readonly onCollapse: () => void;
  readonly onSeek: (ms: number) => void;
  readonly onReturn: (ms: number) => void;
  /** Playhead when the inspector opened — the "return to replay" target. */
  readonly returnMs: number;
}

export function EvidenceInspector({
  evidence,
  open,
  sourcesExpanded,
  onToggleSources,
  onCollapse,
  onSeek,
  onReturn,
  returnMs,
}: EvidenceInspectorProps) {
  if (!open) return null;

  if (evidence.status !== 'verified') {
    return (
      <aside
        className="inspector"
        data-inspector="open"
        aria-label="Evidence unavailable"
        data-evidence-status="unverified"
      >
        <header className="inspector__head">
          <span className="mono inspector__title">EVIDENCE X-RAY</span>
          <button type="button" className="inspector__close" onClick={onCollapse}>
            <span className="visually-hidden">Close inspector</span>×
          </button>
        </header>
        <p className="inspector__unavailable" role="status">
          Measurement withheld — verification failed. {evidence.reason}
        </p>
        <p className="inspector__fine">
          A verified number is never displayed after its source dependencies fail re-verification.
        </p>
      </aside>
    );
  }

  const e = evidence.evidence;
  return (
    <aside
      className="inspector"
      data-inspector="open"
      aria-label="Evidence inspector"
      data-evidence-status="verified"
    >
      <header className="inspector__head">
        <span className="mono inspector__title">EVIDENCE X-RAY</span>
        <button
          type="button"
          className="inspector__return"
          onClick={() => onReturn(returnMs)}
          title={`Return to ${formatMatchClockTenths(returnMs)} and resume replay`}
        >
          Back to replay
        </button>
        <button type="button" className="inspector__close" onClick={onCollapse}>
          <span className="visually-hidden">Close inspector</span>×
        </button>
      </header>

      <p className="inspector__sentence" data-testid="evidence-sentence">
        At the beginning of the interval, <strong>{e.defenderId}</strong> and{' '}
        <strong>{e.strikerId}</strong> were <strong>{e.separationBeforeM.toFixed(3)} metres</strong>{' '}
        apart. At the end, they were <strong>{e.separationAfterM.toFixed(3)} metres</strong> apart.
        The measured increase was <strong>{e.deltaM.toFixed(3)} metres</strong>.
      </p>

      <dl className="inspector__facts mono">
        <div>
          <dt>Interval</dt>
          <dd>
            {formatMatchClockTenths(e.fromMs)} → {formatMatchClockTenths(e.toMs)}
          </dd>
        </div>
        <div>
          <dt>Change</dt>
          <dd data-testid="evidence-delta">
            {e.separationBeforeM.toFixed(3)} m → {e.separationAfterM.toFixed(3)} m (+
            {e.deltaM.toFixed(3)} m)
          </dd>
        </div>
        <div>
          <dt>Provenance</dt>
          <dd data-testid="evidence-provenance">
            {e.basis} · {e.classification} · {e.algorithmVersion}
          </dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd data-testid="evidence-verification">verified · fingerprint {e.inputFingerprint}</dd>
        </div>
      </dl>

      <button
        type="button"
        className="inspector__sources"
        aria-expanded={sourcesExpanded}
        onClick={onToggleSources}
      >
        {sourcesExpanded ? 'Hide source frames' : 'Show source frames'}
      </button>
      {sourcesExpanded ? (
        <div className="inspector__frames" data-testid="evidence-frames">
          <p className="inspector__frames-caption">
            Before @ {formatMatchClockTenths(e.fromMs)} — exact samples
          </p>
          <ul className="mono">
            <li>
              {e.defenderId} · {e.beforeSourceFrameIds[0]}
            </li>
            <li>
              {e.strikerId} · {e.beforeSourceFrameIds[1]}
            </li>
          </ul>
          <p className="inspector__frames-caption">
            After @ {formatMatchClockTenths(e.toMs)} — exact samples
          </p>
          <ul className="mono">
            <li>
              {e.defenderId} · {e.afterSourceFrameIds[0]}
            </li>
            <li>
              {e.strikerId} · {e.afterSourceFrameIds[1]}
            </li>
          </ul>
          <div className="inspector__frame-nav">
            <button type="button" onClick={() => onSeek(e.fromMs)}>
              Go to before frame
            </button>
            <button type="button" onClick={() => onSeek(e.toMs)}>
              Go to after frame
            </button>
          </div>
        </div>
      ) : null}

      <p className="inspector__interpretation" data-testid="evidence-interpretation">
        <span className="mono inspector__interpretation-tag">INTERPRETATION</span>
        {evidence.interpretation.text}
      </p>
    </aside>
  );
}
