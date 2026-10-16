'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatMatchClock, formatMatchClockTenths } from '@/lib/clock';
import {
  advancePlayhead,
  eventAtPlayhead,
  playheadFraction,
  resetPlayhead,
  stepFrame,
  type PlaybackSpeed,
} from '@/lib/playback';
import { sceneTimeline } from '@/lib/scene-client';
import type { SceneData } from '@/lib/scene-data';
import {
  createFrameCache,
  SceneRuntimeContext,
  type CameraMode,
  type ReplayEngine,
} from './scene/scene-context';
import { LivingReplayCanvas, type SceneQuality } from './scene/living-replay';
import { Fallback2D } from './scene/fallback-2d';

/**
 * The Living Replay stage (KYN-05 shell, KYN-06 engine).
 *
 * ONE shared playheadMs owner: the transport loop in this component advances
 * a plain engine object inside requestAnimationFrame — never React state per
 * frame. The 3D scene, the 2D fallback, the clock, the scrubber and the
 * event chip all read the same authoritative value. Units are explicit at
 * every boundary: the slider carries MILLISECONDS (min/max/value/step);
 * fractions exist only inside playheadFraction/fractionToPlayhead.
 *
 * Interaction state (play/pause, speed, camera, selection, view) is React
 * state mirrored into the engine; match truth always comes from the reducer
 * timeline, never from this component.
 */

const CAMERA_MODES: readonly { id: CameraMode; label: string; hint: string }[] = [
  { id: 'broadcast', label: 'Broadcast', hint: 'Main wash camera following the play' },
  { id: 'overhead', label: 'Overhead', hint: 'Tactical top-down view of the whole pitch' },
  { id: 'follow', label: 'Follow', hint: 'Track the selected player (default: the decoy run)' },
  { id: 'orbit', label: 'Free orbit', hint: 'Drag to orbit, wheel to zoom' },
];

const SPEED_LABELS: Record<PlaybackSpeed, string> = {
  0.25: '0.25×',
  0.5: '0.5×',
  1: '1×',
  2: '2×',
};

type LensId = 'fan' | 'analyst' | 'accessible';

export interface ReplayStageProps {
  readonly scene: SceneData;
}

export function ReplayStage({ scene }: ReplayStageProps) {
  const modeGroupId = useId();
  const lensGroupId = useId();
  const speedGroupId = useId();

  const momentWindow = useMemo(
    () => ({ startMs: scene.windowMs[0], endMs: scene.windowMs[1] }),
    [scene.windowMs],
  );

  const timeline = useMemo(() => sceneTimeline(scene), [scene]);
  const getFrame = useMemo(
    () => createFrameCache(timeline, scene.ballEntityId),
    [timeline, scene.ballEntityId],
  );

  const engineRef = useRef<ReplayEngine>({
    window: momentWindow,
    playheadMs: scene.initialFocusMs,
    playing: false,
    speed: 1,
    reducedMotion: false,
    revision: 0,
  });
  const engine = engineRef.current;

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [camera, setCamera] = useState<CameraMode>('broadcast');
  const [lens, setLens] = useState<LensId>('fan');
  const [view, setView] = useState<'3d' | '2d'>('3d');
  const [selected, setSelected] = useState<string | null>(null);
  const [quality, setQuality] = useState<SceneQuality>('high');

  const clockRef = useRef<HTMLSpanElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const eventRef = useRef<HTMLSpanElement>(null);
  const scrubbingRef = useRef(false);

  // Environment: reduced motion + coarse pointer → lighter quality tier.
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const coarse = window.matchMedia('(pointer: coarse)');
    const apply = (): void => {
      engine.reducedMotion = reduced.matches;
      if (reduced.matches) {
        setPlaying(false);
        setSpeed(1);
      }
      setQuality(coarse.matches ? 'low' : 'high');
    };
    apply();
    reduced.addEventListener('change', apply);
    coarse.addEventListener('change', apply);
    return () => {
      reduced.removeEventListener('change', apply);
      coarse.removeEventListener('change', apply);
    };
  }, [engine]);

  // Mirror discrete UI state into the engine object (no per-frame re-render).
  useEffect(() => {
    engine.playing = playing;
    engine.speed = speed;
    engine.revision += 1;
  }, [playing, speed, engine]);

  const setPlayhead = useCallback(
    (ms: number): void => {
      engine.playheadMs = Math.min(momentWindow.endMs, Math.max(momentWindow.startMs, ms));
      engine.revision += 1;
    },
    [engine, momentWindow.endMs, momentWindow.startMs],
  );

  const togglePlaying = useCallback((): void => {
    setPlaying((current) => {
      if (!current && engineRef.current.playheadMs >= momentWindow.endMs) {
        engineRef.current.playheadMs = momentWindow.startMs;
      }
      return !current;
    });
  }, [momentWindow.endMs, momentWindow.startMs]);

  // The single transport loop: advances playheadMs and syncs DOM displays.
  // React state is untouched here.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastUiSync = 0;
    const loop = (now: number): void => {
      const elapsed = now - last;
      last = now;
      if (engine.playing) {
        const advanced = advancePlayhead(engine.playheadMs, elapsed, engine.speed, momentWindow);
        engine.playheadMs = advanced.playheadMs;
        if (advanced.atEnd) setPlaying(false);
      }
      if (now - lastUiSync > 90) {
        lastUiSync = now;
        const t = engine.playheadMs;
        if (clockRef.current !== null) clockRef.current.textContent = formatMatchClockTenths(t);
        if (!scrubbingRef.current && sliderRef.current !== null) {
          sliderRef.current.value = String(t);
        }
        if (fillRef.current !== null) {
          fillRef.current.style.width = `${(playheadFraction(t, momentWindow) * 100).toFixed(2)}%`;
        }
        if (eventRef.current !== null) {
          const active = eventAtPlayhead(t, scene.events);
          eventRef.current.textContent = active
            ? `${active.phase === 'active' ? '' : 'next · '}${active.event.label} — ${active.event.actorId} (${formatMatchClock(active.event.occurredAtMs)})`
            : 'open play';
          eventRef.current.dataset.goal =
            active?.phase === 'active' && active.event.isGoal ? 'true' : 'false';
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, scene.events, momentWindow]);

  // Keyboard transport on the stage: arrows step frames, space toggles play.
  const onStageKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest('button, input, a, select')) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      setPlayhead(stepFrame(engine.playheadMs, event.key === 'ArrowRight' ? 1 : -1, momentWindow));
    } else if (event.key === ' ') {
      event.preventDefault();
      togglePlaying();
    }
  };

  const onSelect = useCallback((entityId: string | null): void => {
    setSelected(entityId);
  }, []);

  const runtime = useMemo(
    () => ({ scene, engine, getFrame, selected: { entityId: selected }, onSelect }),
    [scene, engine, getFrame, selected, onSelect],
  );

  const onSliderInput = (event: React.FormEvent<HTMLInputElement>): void => {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) setPlayhead(value);
  };

  const applyLens = (nextLens: LensId): void => {
    setLens(nextLens);
    if (nextLens === 'fan') {
      setView('3d');
      setCamera('broadcast');
    } else if (nextLens === 'analyst') {
      setView('3d');
      setCamera('overhead');
    } else {
      // Accessible lens: the same timeline, no WebGL dependency.
      setView('2d');
    }
  };

  const selectedPlayer =
    selected !== null ? scene.players.find((player) => player.entityId === selected) : undefined;

  return (
    <SceneRuntimeContext.Provider value={runtime}>
      <section
        className="stage"
        aria-label="Living Replay stage"
        onKeyDown={onStageKeyDown}
        tabIndex={-1}
      >
        {/* The canvas region. data-scene-mount marks where the R3F Canvas goes. */}
        <div className="stage__canvas scene-stage" data-scene-mount="">
          {view === '3d' ? (
            <LivingReplayCanvas runtime={runtime} cameraMode={camera} quality={quality} />
          ) : (
            <Fallback2D runtime={runtime} reason="user-choice" />
          )}

          {/* Floating match context — top left */}
          <div className="stage__context" aria-label="Match context">
            <span className="mono stage__clock" ref={clockRef}>
              {formatMatchClockTenths(scene.initialFocusMs)}
            </span>
            <span className="stage__context-divider" aria-hidden="true" />
            <span>
              {scene.teams.home} vs {scene.teams.away}
            </span>
            <span className="chip chip--synthetic">Synthetic</span>
          </div>

          {/* Camera / lens — top right */}
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
                  title={mode.hint}
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
              {(
                [
                  { id: 'fan', label: 'Fan', hint: 'Broadcast presentation' },
                  { id: 'analyst', label: 'Analyst', hint: 'Tactical overhead view' },
                  {
                    id: 'accessible',
                    label: 'Accessible',
                    hint: '2D tactical view, no WebGL dependency',
                  },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={lens === option.id}
                  title={option.hint}
                  className="stage__mode-btn stage__mode-btn--lens"
                  onClick={() => applyLens(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* Scene status — bottom right, minimal */}
          <p className="stage__status mono" aria-label="Scene status">
            SCENE&nbsp;LIVE · seed {scene.seed}
          </p>
          <div className="stage__loading-slot" aria-hidden="true" />
        </div>

        {/* Transport bar — below the stage, keyboard and touch friendly */}
        <div className="stage__transport" aria-label="Playback controls">
          <div className="stage__transport-row">
            <button
              type="button"
              className="stage__play"
              aria-pressed={playing}
              onClick={togglePlaying}
              title={playing ? 'Pause (space)' : 'Play (space)'}
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
            <button
              type="button"
              className="stage__step"
              onClick={() => setPlayhead(stepFrame(engine.playheadMs, -1, momentWindow))}
              title="Step back one 100 ms frame (←)"
            >
              <span className="visually-hidden">Step back one frame</span>
              <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                <path d="M9 1 L4 6 L9 11 Z M3 1 L2 1 L2 11 L3 11 Z" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              className="stage__step"
              onClick={() => setPlayhead(stepFrame(engine.playheadMs, 1, momentWindow))}
              title="Step forward one 100 ms frame (→)"
            >
              <span className="visually-hidden">Step forward one frame</span>
              <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                <path d="M3 1 L8 6 L3 11 Z M10 1 L11 1 L11 11 L10 11 Z" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              className="stage__step stage__step--reset"
              onClick={() => {
                setPlaying(false);
                setPlayhead(resetPlayhead(momentWindow, scene.checkpointMs));
              }}
              title="Deterministic reset to the confirmed 22-player checkpoint"
            >
              <span className="visually-hidden">Reset to checkpoint</span>⏮
            </button>
            <div
              className="stage__speed"
              role="radiogroup"
              aria-labelledby={`${speedGroupId}-label`}
            >
              <span id={`${speedGroupId}-label`} className="visually-hidden">
                Playback speed
              </span>
              {([0.25, 0.5, 1, 2] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={speed === option}
                  className="stage__speed-btn"
                  onClick={() => setSpeed(option)}
                >
                  {SPEED_LABELS[option]}
                </button>
              ))}
            </div>
          </div>

          <div className="stage__scrub">
            <span className="mono stage__scrub-edge">{formatMatchClock(momentWindow.startMs)}</span>
            <div className="stage__scrub-track">
              <span
                className="stage__scrub-fill"
                ref={fillRef}
                style={{ width: '0%' }}
                aria-hidden="true"
              />
              <input
                ref={sliderRef}
                type="range"
                className="stage__slider"
                aria-label="Moment playhead"
                min={momentWindow.startMs}
                max={momentWindow.endMs}
                step={10}
                defaultValue={scene.initialFocusMs}
                onInput={onSliderInput}
                onKeyDown={(event) => {
                  // Keyboard parity with the global transport shortcuts: the
                  // native range step is 10 ms (fine for pointer scrubbing) —
                  // arrows should step whole 100 ms frames, and space toggles
                  // playback even while the scrubber holds focus.
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    setPlayhead(
                      stepFrame(
                        engine.playheadMs,
                        event.key === 'ArrowRight' ? 1 : -1,
                        momentWindow,
                      ),
                    );
                  } else if (event.key === ' ') {
                    event.preventDefault();
                    togglePlaying();
                  }
                }}
                onPointerDown={() => {
                  scrubbingRef.current = true;
                }}
                onPointerUp={() => {
                  scrubbingRef.current = false;
                }}
                onBlur={() => {
                  scrubbingRef.current = false;
                }}
              />
              {scene.events.map((event) => (
                <span
                  key={event.eventId}
                  className={
                    event.kind === 'goal'
                      ? 'stage__event-mark stage__event-mark--goal'
                      : 'stage__event-mark'
                  }
                  style={{
                    left: `${(playheadFraction(event.occurredAtMs, momentWindow) * 100).toFixed(2)}%`,
                  }}
                  title={`${event.label} · ${event.actorId} · ${formatMatchClock(event.occurredAtMs)}`}
                />
              ))}
            </div>
            <span className="mono stage__scrub-edge">{formatMatchClock(momentWindow.endMs)}</span>
          </div>

          <div className="stage__transport-row stage__transport-row--meta">
            <span className="stage__event-chip mono" ref={eventRef} aria-live="polite">
              open play
            </span>
            {selectedPlayer !== undefined ? (
              <span className="stage__selection chip chip--evidence">
                {selectedPlayer.entityId} · {scene.teams[selectedPlayer.team]} #
                {selectedPlayer.shirtNumber}
                <button
                  type="button"
                  className="stage__selection-clear"
                  onClick={() => onSelect(null)}
                >
                  <span className="visually-hidden">Clear selection</span>×
                </button>
              </span>
            ) : (
              <span className="stage__hint">Click a player to follow their run</span>
            )}
            <button
              type="button"
              className="stage__view-toggle"
              aria-pressed={view === '2d'}
              onClick={() => setView(view === '3d' ? '2d' : '3d')}
              title="Switch between the 3D scene and the accessible 2D tactical view"
            >
              {view === '3d' ? '2D view' : '3D view'}
            </button>
          </div>
        </div>
      </section>
    </SceneRuntimeContext.Provider>
  );
}
