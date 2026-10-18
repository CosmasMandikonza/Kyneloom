'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { formatMatchClock, formatMatchClockTenths } from '@/lib/clock';
import {
  advancePlayhead,
  eventAtPlayhead,
  playheadFraction,
  resetPlayhead,
  stepFrame,
  type PlaybackSpeed,
} from '@/lib/playback';
import { sceneTimeline, tracksToSamples } from '@/lib/scene-client';
import type { SceneData } from '@/lib/scene-data';
import {
  createFrameCache,
  SceneRuntimeContext,
  type CameraMode,
  type ReplayEngine,
} from './scene/scene-context';
import { LivingReplayCanvas, type SceneQuality } from './scene/living-replay';
import { XrayOverlay, type XrayPhase, SCENE_OPEN_INSPECTOR_EVENT } from './scene/xray-overlay';
import { EvidenceInspector } from './evidence-inspector';
import { validateEvidenceProjection, type EvidenceProjection } from '@/lib/evidence-data';
import { MEASURED_INTERVAL_MS } from '@/lib/moment-catalog';
import { pitchToThree } from '@kyneloom/contracts';
import { LENS_IDS, readStoredLens, storeLens, type LensId } from '@/lib/lens';
import { Fallback2D } from './scene/fallback-2d';
import { LensDock } from './lens-dock';
import { AnalystRail } from './analyst-rail';
import { AccessiblePanel } from './accessible-panel';

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
  { id: 'broadcast', label: 'Broadcast', hint: 'Main wash camera following the play (1)' },
  { id: 'overhead', label: 'Overhead', hint: 'Tactical top-down view of the whole pitch (2)' },
  { id: 'follow', label: 'Follow', hint: 'Track the selected player (default: the decoy run) (3)' },
  {
    id: 'goalkeeper',
    label: 'Goalkeeper',
    hint: "Frame the play from the engaged keeper's actual position (4)",
  },
  { id: 'orbit', label: 'Free orbit', hint: 'Drag to orbit, wheel or pinch to zoom (5)' },
  {
    id: 'directed',
    label: 'Directed',
    hint: 'Guided cinematic sequence — The Invisible Assist (6)',
  },
];

const SPEED_LABELS: Record<PlaybackSpeed, string> = {
  0.25: '0.25×',
  0.5: '0.5×',
  1: '1×',
  2: '2×',
};

/** Pointer/touch hit tolerance around the projected measured segments. */
const HIT_TOLERANCE_PX = 14;

/** DOM bridge event for projected player selection (see handler below). */
const SCENE_SELECT_EVENT = 'kyneloom:scene-select';

function distanceToSegmentPx(
  px: number,
  py: number,
  seg: { x1: number; y1: number; x2: number; y2: number },
): number {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - seg.x1, py - seg.y1);
  const t = Math.max(0, Math.min(1, ((px - seg.x1) * dx + (py - seg.y1) * dy) / lengthSq));
  return Math.hypot(px - (seg.x1 + t * dx), py - (seg.y1 + t * dy));
}

export interface ReplayStageProps {
  readonly scene: SceneData;
  readonly evidence: EvidenceProjection;
  /**
   * KYN-10: title of the catalog chapter this replay was opened at, or null
   * for the default entry. Presentational only — the playhead already came
   * from the server-validated scene.initialFocusMs.
   */
  readonly chapterTitle?: string | null;
}

/**
 * Boundary guard: a payload that fails rehydration validation disables the
 * stage truthfully (explicit notice, no transport) rather than playing a
 * plausible-but-false replay built from invented defaults.
 */
export function ReplayStage({ scene, evidence, chapterTitle }: ReplayStageProps) {
  let timeline: ReturnType<typeof sceneTimeline> | null = null;
  let invalidReason: string | null = null;
  try {
    timeline = sceneTimeline(scene);
  } catch (error) {
    invalidReason = error instanceof Error ? error.message : 'unknown validation failure';
  }
  if (timeline === null) {
    return (
      <section className="stage" aria-label="Living Replay stage">
        <div className="fallback2d" data-scene-invalid={invalidReason}>
          <p className="stage__status mono" role="alert">
            SCENE UNAVAILABLE · the replay payload failed validation, so the 3D and 2D views are
            disabled rather than showing invented data.
          </p>
        </div>
      </section>
    );
  }
  return (
    <ReplayStageInner
      scene={scene}
      evidence={evidence}
      timeline={timeline}
      chapterTitle={chapterTitle ?? null}
    />
  );
}

function ReplayStageInner({
  scene,
  evidence,
  timeline,
  chapterTitle,
}: ReplayStageProps & { timeline: ReturnType<typeof sceneTimeline> }) {
  const speedGroupId = useId();

  const momentWindow = useMemo(
    () => ({ startMs: scene.windowMs[0], endMs: scene.windowMs[1] }),
    [scene.windowMs],
  );

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
  const [enteredFromOrb, setEnteredFromOrb] = useState(false);

  // KYN-09 handoff: arriving from the landing's orb transition (?enter=orb)
  // settles through the same damped rig — one beat of the tactical overhead
  // the fragments just assembled, then the broadcast camera. Playhead and
  // canonical checkpoint are untouched; direct /explore visits are too.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('enter') !== 'orb') return;
    setEnteredFromOrb(true);
    setCamera('overhead');
    const timer = window.setTimeout(() => setCamera('broadcast'), 1300);
    return () => window.clearTimeout(timer);
  }, []);
  // KYN-11 lens presentation state. Fan is the SSR/hydration default; the
  // remembered session preference (presentation ONLY — never positions,
  // metrics or anything authorization-shaped) is read in an effect after
  // mount, so server and client markup match. Switching a lens NEVER
  // touches the engine: no playhead, playback, camera or selection writes.
  const [lens, setLens] = useState<LensId>('fan');
  const [view, setView] = useState<'3d' | '2d'>('3d');
  useEffect(() => {
    const stored = readStoredLens(window.sessionStorage);
    if (stored !== 'fan') setLens(stored);
  }, []);
  const selectLens = useCallback((next: LensId): void => {
    setLens(next);
    storeLens(window.sessionStorage, next);
  }, []);
  const cycleLens = useCallback((): void => {
    setLens((current) => {
      const next = LENS_IDS[(LENS_IDS.indexOf(current) + 1) % LENS_IDS.length] ?? 'fan';
      storeLens(window.sessionStorage, next);
      return next;
    });
  }, []);
  const [selected, setSelected] = useState<string | null>(null);
  const [quality, setQuality] = useState<SceneQuality>('high');
  // Evidence X-Ray: validated projection only — a corrupt payload disables
  // the lens truthfully rather than drawing fabricated evidence. Validation
  // BINDS the payload to this scene's own rehydrated timeline + accepted
  // tracking (match id, identities, window, frames, fingerprint), so a
  // plausible but falsified payload is rejected, not displayed.
  const evidenceCtx = useMemo(
    () => ({ matchId: scene.matchId, timeline, tracking: tracksToSamples(scene) }),
    [scene.matchId, timeline, scene],
  );
  const evidenceSafe = useMemo(
    () => validateEvidenceProjection(evidence, evidenceCtx),
    [evidence, evidenceCtx],
  );
  const [xrayActive, setXrayActive] = useState(false);
  const [xrayPhase, setXrayPhase] = useState<XrayPhase>('both');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [inspectorReturnMs, setInspectorReturnMs] = useState(scene.initialFocusMs);
  const xrayAvailable = evidenceSafe?.status === 'verified';

  const clockRef = useRef<HTMLSpanElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const eventRef = useRef<HTMLSpanElement>(null);
  const evidenceContextRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);

  /** The verified X-Ray measurement interval (KYN-10 honesty gate). */
  const MEASURED_WINDOW = {
    startMs: MEASURED_INTERVAL_MS[0],
    endMs: MEASURED_INTERVAL_MS[1],
  } as const;

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
        // Honest evidence context: visible only while X-Ray is showing AND
        // the playhead sits outside the measured interval.
        if (evidenceContextRef.current !== null) {
          const outside = t < MEASURED_WINDOW.startMs || t > MEASURED_WINDOW.endMs;
          evidenceContextRef.current.hidden = !(xrayActiveRef.current && outside);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, scene.events, momentWindow]);

  // Keyboard transport on the stage: arrows step frames, space toggles
  // play, digits 1–6 select cameras, X toggles Evidence X-Ray, I opens the
  // inspector, Escape exits directed/orbit mode and closes the inspector.
  const onStageKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    // Escape is a GLOBAL exit: leaving the directed sequence (or free orbit)
    // must work even while a control holds focus.
    if (event.key === 'Escape') {
      if (camera === 'directed' || camera === 'orbit') {
        event.preventDefault();
        setCamera('broadcast');
      }
      if (inspectorOpen) setInspectorOpen(false);
      return;
    }
    if (event.key.toLowerCase() === 'x' && xrayAvailable) {
      event.preventDefault();
      setXrayActive((current) => !current);
    } else if (event.key.toLowerCase() === 'l') {
      // KYN-11: cycle the viewing lens (presentation only — L).
      event.preventDefault();
      cycleLens();
    } else if (event.key.toLowerCase() === 'i' && xrayActive) {
      event.preventDefault();
      setInspectorOpen((current) => {
        if (!current) setInspectorReturnMs(engineRef.current.playheadMs);
        return !current;
      });
    }
    if (target.closest('button, input, a, select')) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      setPlayhead(stepFrame(engine.playheadMs, event.key === 'ArrowRight' ? 1 : -1, momentWindow));
    } else if (event.key === ' ') {
      event.preventDefault();
      togglePlaying();
    } else if (event.key >= '1' && event.key <= '6') {
      const next = CAMERA_MODES[Number(event.key) - 1];
      if (next !== undefined && !(next.id === 'directed' && scene.directedTrack === null)) {
        event.preventDefault();
        setCamera(next.id);
      }
    }
  };

  const onSelect = useCallback((entityId: string | null): void => {
    setSelected(entityId);
  }, []);

  // Scene→inspector path: clicking/tapping the measured separation geometry
  // (or the 2D evidence line) opens the actual evidence inspector WITHOUT
  // disturbing the current selection or playhead. The 3D geometry signals
  // through a DOM CustomEvent (see xray-overlay.tsx) because updates called
  // directly from the R3F canvas's raw listeners do not reliably commit for
  // touch input; the flush keeps the commit synchronous from any listener.
  const openInspector = useCallback((): void => {
    flushSync(() => {
      setInspectorReturnMs(engineRef.current.playheadMs);
      setInspectorOpen(true);
    });
  }, []);
  useEffect(() => {
    const onSceneOpen = (): void => openInspector();
    window.addEventListener(SCENE_OPEN_INSPECTOR_EVENT, onSceneOpen);
    return () => window.removeEventListener(SCENE_OPEN_INSPECTOR_EVENT, onSceneOpen);
  }, [openInspector]);

  // Selection bridge: the capture-phase projected hit-test dispatches
  // SCENE_SELECT_EVENT; committing inside the React root with flushSync is
  // the pattern this stack reliably honors for synthetic pointer input.
  useEffect(() => {
    const onSceneSelect = (event: Event): void => {
      const entityId = (event as CustomEvent<string | null>).detail;
      flushSync(() => {
        onSelect(entityId);
      });
    };
    window.addEventListener(SCENE_SELECT_EVENT, onSceneSelect);
    return () => window.removeEventListener(SCENE_SELECT_EVENT, onSceneSelect);
  }, [onSelect]);

  // DOM hit-test path for scene→inspector: pointer/touch DOWN anywhere on
  // the canvas within HIT_TOLERANCE_PX of a projected measured segment
  // opens the inspector. A plain DOM listener in this React root commits
  // reliably for every input path (mouse, touch, synthetic test input);
  // updates raised from inside the R3F canvas's own pointer pipeline were
  // observed NOT to commit for synthetic touch on this stack. The projected
  // segments are the exact same measured geometry the 3D raycast boxes
  // wrap, so the hit area is equivalent.
  const xrayActiveRef = useRef(xrayActive);
  xrayActiveRef.current = xrayActive;
  const lastPointerdownAtRef = useRef(0);
  const lastClickDetailRef = useRef(0);
  // A "ghost click": a mouse-detail click (detail > 0 — keyboard activation
  // carries detail 0 and must never be blocked) that trails the last
  // pointerdown by a long gap. That is exactly what browsers synthesize
  // ~100–300 ms after a touch tap, and it must not drive the inspector it
  // just opened under the finger.
  const ghostClick = useCallback(
    (): boolean =>
      lastClickDetailRef.current > 0 && Date.now() - lastPointerdownAtRef.current > 150,
    [],
  );
  // KYN-11 reliable player selection: pointer/touch DOWN on the canvas
  // selects the projected-nearest player within a generous tolerance. The
  // R3F pick cylinders are raycast-accurate but only ~10 px at broadcast
  // distance — practically unclickable; this DOM-projected path (same
  // pattern as the X-Ray hit-test above, same authoritative frame) makes
  // click-to-select work for mouse, touch and synthetic test input at every
  // camera distance. Tapping empty pitch clears the selection.
  const SELECT_TOLERANCE_PX = 30;
  useEffect(() => {
    const onDownSelect = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest?.('button, input, a, select, label')) return;
      const canvas = target?.closest?.('canvas');
      if (canvas === null || canvas === undefined) return;
      const project = (
        window as unknown as {
          __kyneloomScene?: {
            visual?: {
              projectWorld?: (x: number, y: number, z: number) => readonly [number, number] | null;
            };
          };
        }
      ).__kyneloomScene?.visual?.projectWorld;
      if (project === undefined) return;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const frame = getFrame(engine.playheadMs);
      let bestId: string | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const player of scene.players) {
        const sample = frame.positions.get(player.entityId);
        if (sample === undefined) continue;
        const [wx, wy, wz] = pitchToThree({ xM: sample.xM, yM: sample.yM, zM: sample.zM });
        const screen = project(wx, wy, wz);
        const distance = screen === null ? Number.POSITIVE_INFINITY : Math.hypot(screen[0] - px, screen[1] - py);
        if (distance <= SELECT_TOLERANCE_PX && distance < bestDistance) {
          bestDistance = distance;
          bestId = player.entityId;
        }
      }
      const next =
        bestId === null ? null : selected === bestId ? null : bestId;
      // Route through a DOM CustomEvent: updates called directly from
      // native capture-phase listeners do not reliably commit on this
      // stack for synthetic pointer input — the same finding that shaped
      // the KYN-08 scene→inspector path. The bridge below flushes inside
      // the React root.
      window.dispatchEvent(new CustomEvent(SCENE_SELECT_EVENT, { detail: next }));
    };
    document.addEventListener('pointerdown', onDownSelect, { capture: true });
    return () => document.removeEventListener('pointerdown', onDownSelect, { capture: true });
  }, [engine, getFrame, onSelect, scene.players, selected]);

  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      // Every real interaction begins with a pointerdown; browsers
      // synthesize a trailing click AFTER a touch tap with a long gap and
      // no pointerdown of its own — that ghost must not drive the
      // inspector (see ghostClick()).
      lastPointerdownAtRef.current = Date.now();
      lastClickDetailRef.current = 0;
      if (!xrayActiveRef.current) return;
      const target = event.target as Element | null;
      // Real controls win over scene hit-testing — a tap on a button must
      // never be reinterpreted as a geometry click.
      if (target?.closest?.('button, input, a, select, label')) return;
      const canvas = target?.closest?.('canvas');
      if (canvas === null || canvas === undefined) return;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const probe = (
        window as unknown as {
          __kyneloomXray?: {
            hitSegmentsScreen(): { x1: number; y1: number; x2: number; y2: number }[];
          };
        }
      ).__kyneloomXray;
      for (const seg of probe?.hitSegmentsScreen() ?? []) {
        if (distanceToSegmentPx(px, py, seg) <= HIT_TOLERANCE_PX) {
          openInspector();
          return;
        }
      }
    };
    const onClick = (event: MouseEvent): void => {
      lastClickDetailRef.current = event.detail;
    };
    // Capture phase: downstream code (the R3F pipeline, browser touch
    // handling) may stop native propagation before document bubble phase;
    // capture guarantees this listener sees every pointer/touch down.
    document.addEventListener('pointerdown', onDown, { capture: true });
    document.addEventListener('click', onClick, { capture: true });
    return () => {
      document.removeEventListener('pointerdown', onDown, { capture: true });
      document.removeEventListener('click', onClick, { capture: true });
    };
  }, [openInspector]);

  const runtime = useMemo(
    () => ({ scene, engine, getFrame, selected: { entityId: selected }, onSelect }),
    [scene, engine, getFrame, selected, onSelect],
  );

  // Clearly-labeled QA/debug hook (not user-facing): the presentation-side
  // state Playwright needs for the KYN-11 lens invariants.
  useEffect(() => {
    const hook = window as unknown as Record<string, unknown>;
    hook['__kyneloomLens'] = {
      lens: (): string => lens,
      playheadMs: (): number => engine.playheadMs,
      selected: (): string | null => selected,
      camera: (): string => camera,
      view: (): string => view,
    };
    return () => {
      delete hook['__kyneloomLens'];
    };
  }, [lens, engine, selected, camera, view]);

  const onSliderInput = (event: React.FormEvent<HTMLInputElement>): void => {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) setPlayhead(value);
  };

  // KYN-11 invariant: lens switching has NO applyLens side effects anymore —
  // no camera reset, no forced 2D, no playhead seek. The user's viewpoint,
  // transport and selection survive every switch; lens-recommended framings
  // are explicit opt-ins (the rail's camera group, the panel's 2D button).

  const selectedPlayer =
    selected !== null ? scene.players.find((player) => player.entityId === selected) : undefined;

  return (
    <SceneRuntimeContext.Provider value={runtime}>
      <section
        className="stage"
        aria-label="Living Replay stage"
        onKeyDown={onStageKeyDown}
        tabIndex={-1}
        data-enter={enteredFromOrb ? 'orb' : undefined}
      >
        {/* The canvas region. data-scene-mount marks where the R3F Canvas goes. */}
        <div className="stage__canvas scene-stage" data-scene-mount="">
          {view === '3d' ? (
            <LivingReplayCanvas runtime={runtime} cameraMode={camera} quality={quality}>
              <XrayOverlay
                evidence={evidenceSafe ?? evidence}
                state={{ active: xrayActive, phase: xrayPhase }}
              />
            </LivingReplayCanvas>
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
            {chapterTitle !== null ? (
              <span className="chip chip--evidence" data-chapter-chip={scene.initialFocusMs}>
                Chapter · {chapterTitle}
              </span>
            ) : null}
          </div>

          {/* Honest evidence context (KYN-10): the verified separation
              measurement belongs to its own interval; when the playhead is
              outside it, say so instead of letting the overlay read as if it
              belonged to the current chapter. Visibility is driven from the
              transport loop (no per-frame React renders). */}
          <div
            className="stage__evidence-context"
            ref={evidenceContextRef}
            hidden
            data-evidence-context=""
          >
            <span className="mono">
              MEASURED INTERVAL {formatMatchClock(MEASURED_WINDOW.startMs)}–
              {formatMatchClock(MEASURED_WINDOW.endMs)} · PLAYHEAD OUTSIDE IT
            </span>
            <button
              type="button"
              className="stage__evidence-context-seek"
              onClick={() => {
                setPlaying(false);
                setPlayhead(MEASURED_WINDOW.startMs);
              }}
            >
              Go to measured interval
            </button>
          </div>

          {/* KYN-11 lens chrome. Fan is scene-dominant: clock, contextual
              event chip (in the transport), ONE Explain action and the
              perspective dock. Cameras, X-Ray controls and the evidence
              rail belong to the Analyst presentation; the Accessible
              presentation adds the description/transcript/audio panel.
              None of these write the engine — lenses are presentation. */}
          {lens === 'fan' ? (
            <button
              type="button"
              className="stage__explain"
              onClick={() => selectLens('analyst')}
              title="Reveal the measured geometry and evidence at this exact instant (switches to the Analyst perspective)"
              data-testid="fan-explain"
            >
              <span className="stage__explain-glyph" aria-hidden="true">
                ◇
              </span>
              Explain this moment
            </button>
          ) : null}

          {lens === 'analyst' ? (
            <AnalystRail
              scene={scene}
              evidence={evidenceSafe ?? evidence}
              selectedEntityId={selected}
              camera={camera}
              onCamera={setCamera}
              onXray={() => {
                setXrayActive((current) => !current);
                if (!xrayActive) setInspectorOpen(false);
              }}
              onInspect={() => {
                setInspectorOpen((current) => {
                  if (!current) setInspectorReturnMs(engineRef.current.playheadMs);
                  return !current;
                });
              }}
              xrayActive={xrayActive}
              engineRef={engineRef}
              getFrame={getFrame}
            />
          ) : null}

          {lens === 'accessible' ? (
            <AccessiblePanel
              scene={scene}
              evidence={evidenceSafe ?? evidence}
              engine={engine}
              playing={playing}
              selectedEntityId={selected}
              getFrame={getFrame}
              onSeek={(ms) => {
                setPlaying(false);
                setPlayhead(ms);
              }}
              onTogglePlay={togglePlaying}
              onStep={(direction) =>
                setPlayhead(stepFrame(engine.playheadMs, direction, momentWindow))
              }
              view={view}
              onUse2D={() => setView('2d')}
            />
          ) : null}

          {/* X-Ray phase controls surface wherever the overlay is active. */}
          {xrayActive && xrayAvailable ? (
            <div className="stage__xray-phases" role="group" aria-label="Evidence X-Ray phases">
              {(['before', 'after', 'both'] as const).map((phase) => (
                <button
                  key={phase}
                  type="button"
                  className="stage__phase-btn"
                  aria-pressed={xrayPhase === phase}
                  title={
                    phase === 'before'
                      ? 'Separation at the start of the measured interval'
                      : phase === 'after'
                        ? 'Separation at the end of the measured interval'
                        : 'Show both states for comparison'
                  }
                  onClick={() => setXrayPhase(phase)}
                >
                  {phase === 'before' ? 'Before' : phase === 'after' ? 'After' : 'Both'}
                </button>
              ))}
            </div>
          ) : null}

          {camera === 'directed' ? (
            <button
              type="button"
              className="stage__exit-directed"
              onClick={() => setCamera('broadcast')}
              title="Return to the broadcast camera (Escape)"
            >
              Exit Directed Mode
            </button>
          ) : null}

          {/* The perspective dock — one control, three experiences of the
              SAME moment. Switching never touches the engine. */}
          <LensDock lens={lens} onSelect={selectLens} />

          {/* Evidence X-Ray inspector — compact, contextual, collapsible. */}
          <EvidenceInspector
            evidence={evidenceSafe ?? evidence}
            open={inspectorOpen}
            sourcesExpanded={sourcesExpanded}
            onToggleSources={() => {
              if (ghostClick()) return;
              setSourcesExpanded((current) => !current);
            }}
            onCollapse={() => {
              if (ghostClick()) return; // trailing touch ghost, not a user click
              setInspectorOpen(false);
            }}
            onSeek={(ms) => {
              if (ghostClick()) return;
              setPlaying(false);
              setPlayhead(ms);
            }}
            onReturn={(ms) => {
              if (ghostClick()) return;
              setPlayhead(ms);
              setInspectorOpen(false);
            }}
            returnMs={inspectorReturnMs}
          />
          {view === '2d' && xrayActive && evidenceSafe?.status === 'verified' ? (
            <button
              type="button"
              className="stage__xray-2d mono"
              data-xray-2d="separation"
              onClick={openInspector}
              title="Show how this number was calculated"
            >
              X-RAY · {evidenceSafe.evidence.separationBeforeM.toFixed(3)} m →{' '}
              {evidenceSafe.evidence.separationAfterM.toFixed(3)} m · measured, not interpretation
            </button>
          ) : null}

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
              <span className="stage__hint">
                Click a player to follow their run · 1–6 cameras · Esc exits directed/orbit
              </span>
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
