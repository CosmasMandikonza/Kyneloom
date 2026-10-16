'use client';

import { useCallback, useId, useRef, useState } from 'react';

/**
 * The Living Replay stage shell (KYN-05).
 *
 * A full-bleed, aspect-correct canvas region that KYN-06's R3F renderer will
 * mount into, plus the interaction architecture it needs: a floating camera/
 * lens selector, a scrubbable playback rail over the golden window, and a
 * scene status line. The stage deliberately renders NO fake 3D: the interior
 * states "Not implemented" and the controls that need the renderer are
 * visibly disabled with accurate reasons.
 *
 * Interaction state (mode, playhead) is local and UI-only — physical match
 * truth always comes from the reducer, never from this component.
 */

const CAMERA_MODES = [
  { id: 'broadcast', label: 'Broadcast', ready: false },
  { id: 'overhead', label: 'Overhead', ready: false },
  { id: 'follow', label: 'Follow player', ready: false },
  { id: 'orbit', label: 'Free orbit', ready: false },
] as const;

const LENSES = [
  { id: 'fan', label: 'Fan' },
  { id: 'analyst', label: 'Analyst' },
  { id: 'accessible', label: 'Accessible' },
] as const;

export interface ReplayStageProps {
  readonly windowStartLabel: string;
  readonly windowEndLabel: string;
  readonly checkpointLabel: string;
  readonly windowSpanMs: number | null;
}

export function ReplayStage({
  windowStartLabel,
  windowEndLabel,
  checkpointLabel,
  windowSpanMs,
}: ReplayStageProps) {
  const modeGroupId = useId();
  const lensGroupId = useId();
  const [camera, setCamera] = useState<string>('broadcast');
  const [lens, setLens] = useState<string>('fan');
  const [playing, setPlaying] = useState(false);
  // Playhead is a FRACTION of the moment window in [0, 1] (2-dp); every
  // consumer converts to percent/ms through one helper.
  const [playhead, setPlayhead] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);

  const scrubTo = useCallback((fraction: number) => {
    const clamped = Math.min(1, Math.max(0, fraction));
    setPlayhead(Math.round(clamped * 100) / 100);
  }, []);

  const onRailKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      scrubTo(playhead + step);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      scrubTo(playhead - step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      scrubTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      scrubTo(1);
    }
  };

  const onRailPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (rail === null) return;
    const rect = rail.getBoundingClientRect();
    scrubTo((event.clientX - rect.left) / rect.width);
  };

  const playheadPercent = `${(playhead * 100).toFixed(2)}%`;

  return (
    <section className="stage" aria-label="Living Replay stage">
      {/* The canvas region. data-scene-mount marks where the R3F Canvas goes. */}
      <div className="stage__canvas scene-stage" data-scene-mount="">
        <div className="stage__pitchlines" aria-hidden="true" />
        <div className="stage__placeholder">
          <p className="chip chip--not-implemented">Not implemented</p>
          <p className="stage__placeholder-title">Living Replay</p>
          <p className="stage__placeholder-body">
            The R3F scene (Issue #6) mounts here: 22 rigged footballers and the ball driven by
            reducer truth. This region reserves the full-bleed canvas area and its pitch proportions
            — nothing is faked.
          </p>
        </div>

        {/* Floating match context — top left */}
        <div className="stage__context" aria-label="Match context">
          <span className="mono stage__clock">{checkpointLabel}</span>
          <span className="stage__context-divider" aria-hidden="true" />
          <span>The Invisible Assist</span>
          <span className="chip chip--synthetic">Synthetic</span>
        </div>

        {/* Camera / lens status — top right */}
        <div className="stage__modes" aria-label="Camera and lens selection">
          <span id={`${modeGroupId}-label`} className="stage__mode-caption">
            Camera
          </span>
          <div
            className="stage__mode-group"
            role="radiogroup"
            aria-labelledby={`${modeGroupId}-label`}
          >
            {CAMERA_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={camera === mode.id}
                disabled={!mode.ready}
                title={
                  mode.ready
                    ? `${mode.label} camera`
                    : `${mode.label} camera arrives with the 3D renderer (Issue #6)`
                }
                className="stage__mode-btn"
                onClick={() => setCamera(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <span id={`${lensGroupId}-label`} className="stage__mode-caption">
            Lens
          </span>
          <div
            className="stage__mode-group"
            role="radiogroup"
            aria-labelledby={`${lensGroupId}-label`}
          >
            {LENSES.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={lens === option.id}
                className="stage__mode-btn stage__mode-btn--lens"
                onClick={() => setLens(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* Playback rail — bottom, floating */}
        <div className="stage__rail-wrap" aria-label="Playback controls">
          <div className="stage__rail">
            <button
              type="button"
              className="stage__play"
              aria-pressed={playing}
              disabled
              title="Playback requires the renderer's timeline sampler UI (Issue #6)"
              onClick={() => setPlaying((p) => !p)}
            >
              <span className="visually-hidden">{playing ? 'Pause' : 'Play'}</span>
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                {playing ? (
                  <>
                    <rect x="1.5" y="1" width="3" height="10" rx="1" fill="currentColor" />
                    <rect x="7.5" y="1" width="3" height="10" rx="1" fill="currentColor" />
                  </>
                ) : (
                  <path d="M2.5 1.2 L10.8 6 L2.5 10.8 Z" fill="currentColor" />
                )}
              </svg>
            </button>
            <div
              ref={railRef}
              className="stage__track"
              role="slider"
              tabIndex={0}
              aria-label="Moment playhead"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(playhead * 100)}
              aria-valuetext={`${(playhead * 100).toFixed(0)} percent of the moment window`}
              onKeyDown={onRailKey}
              onPointerDown={onRailPointer}
            >
              <div className="stage__track-progress" style={{ width: playheadPercent }} />
              <div className="stage__track-thumb" style={{ left: playheadPercent }} />
              <span className="stage__track-start mono">{windowStartLabel}</span>
              <span className="stage__track-end mono">{windowEndLabel}</span>
            </div>
            <span className="stage__window mono" aria-hidden="true">
              {windowSpanMs !== null ? `${(windowSpanMs / 1000).toFixed(0)}s window` : '—'}
            </span>
          </div>
        </div>

        {/* Scene status — bottom right, minimal */}
        <p className="stage__status mono" aria-label="Scene status">
          SCENE&nbsp;PENDING · <span aria-hidden="true">●</span> awaiting renderer
        </p>
      </div>
    </section>
  );
}
