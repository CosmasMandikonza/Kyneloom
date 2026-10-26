'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MomentProposal } from '@kyneloom/contracts';
import type { ReplayEngine } from '@/app/explore/scene/scene-context';
import { formatMatchClock, formatMatchClockTenths } from '@/lib/clock';
import type { SceneData } from '@/lib/scene-data';
import type { StudioSelection } from './selection';

/**
 * KYN-17 — the professional multitrack timeline.
 *
 * One axis, one clock: every clip's position derives from its REAL timecode
 * (moment-window offsets converted to absolute match ms exactly once here).
 * The playhead is the STAGE's own engine playhead — polled in a rAF loop
 * with direct DOM writes (the transport law: no per-frame React renders) —
 * and scrubbing writes back through the same engine law the stage controls
 * use. Drag handles commit ONE history command on release; the inspector's
 * numeric fields are the precise accessible alternative.
 */

export interface TimelineProps {
  readonly proposal: MomentProposal;
  readonly scene: SceneData;
  readonly engineRef: { readonly current: ReplayEngine | null };
  readonly selection: StudioSelection | null;
  readonly hiddenIds: ReadonlySet<string>;
  readonly onSelect: (selection: StudioSelection | null) => void;
  readonly onTrimOverlay: (overlayId: string, startMs: number, endMs: number) => void;
  readonly onTrimShot: (trackId: string, startMs: number, endMs: number) => void;
  readonly captionClaimId: (overlayId: string) => string | null;
}

const LANE_HEIGHT = 38;
const MIN_PX_PER_MS = 0.06; // whole moment on a narrow screen
const MAX_PX_PER_MS = 1.2;

interface DragState {
  readonly kind: 'overlay-start' | 'overlay-end' | 'shot-start' | 'shot-end';
  readonly id: string;
  readonly grabOffsetMs: number;
  readonly originStart: number;
  readonly originEnd: number;
}

export function Timeline({
  proposal,
  scene,
  engineRef,
  selection,
  hiddenIds,
  onSelect,
  onTrimOverlay,
  onTrimShot,
  captionClaimId,
}: TimelineProps) {
  const [pxPerMs, setPxPerMs] = useState(0.09);
  const [dragPreview, setDragPreview] = useState<{
    readonly id: string;
    readonly startMs: number;
    readonly endMs: number;
  } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timecodeRef = useRef<HTMLSpanElement>(null);

  const [startMs, endMs] = proposal.timeRangeMs;
  const windowMs = endMs - startMs;
  const widthPx = Math.max(320, windowMs * pxPerMs);

  // Lanes: camera shots (one clip per directed track), source events from the
  // scene payload (read-only markers), overlays by kind, captions last.
  const dataOverlays = proposal.overlays.filter((overlay) => overlay.kind !== 'caption');
  const captions = proposal.overlays.filter((overlay) => overlay.kind === 'caption');
  const momentEvents = useMemo(
    () =>
      scene.events.filter((event) => event.occurredAtMs >= startMs && event.occurredAtMs <= endMs),
    [scene.events, startMs, endMs],
  );

  // Playhead sync: read the stage engine, write DOM directly.
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (now: number): void => {
      if (now - last > 60) {
        last = now;
        const engine = engineRef.current;
        if (engine !== null) {
          const offset = engine.playheadMs - startMs;
          const clamped = Math.max(0, Math.min(windowMs, offset));
          if (playheadRef.current !== null) {
            playheadRef.current.style.left = `${(clamped * pxPerMs).toFixed(1)}px`;
          }
          if (timecodeRef.current !== null) {
            timecodeRef.current.textContent = formatMatchClockTenths(startMs + clamped);
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engineRef, startMs, windowMs, pxPerMs]);

  const seek = (clientX: number): void => {
    const engine = engineRef.current;
    const lanes = lanesRef.current;
    if (engine === null || lanes === null) return;
    const rect = lanes.getBoundingClientRect();
    const offset = (clientX - rect.left) / pxPerMs;
    engine.playheadMs = Math.round(startMs + Math.max(0, Math.min(windowMs, offset)));
    engine.revision += 1;
  };

  const onScrubPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('[data-clip]')) return;
    seek(event.clientX);
    const onMove = (move: PointerEvent): void => seek(move.clientX);
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const beginDrag = (event: React.PointerEvent, drag: DragState): void => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = drag;
    const onMove = (move: PointerEvent): void => {
      const current = dragRef.current;
      if (current === null) return;
      const lanes = lanesRef.current;
      if (lanes === null) return;
      const rect = lanes.getBoundingClientRect();
      const ms = Math.round((move.clientX - rect.left) / pxPerMs);
      const delta = ms - current.grabOffsetMs;
      let nextStart = current.originStart;
      let nextEnd = current.originEnd;
      if (current.kind === 'overlay-start' || current.kind === 'shot-start') {
        nextStart = Math.max(0, Math.min(current.originEnd - 100, current.originStart + delta));
      } else {
        nextEnd = Math.max(
          current.originStart + 100,
          Math.min(windowMs, current.originEnd + delta),
        );
      }
      setDragPreview({ id: current.id, startMs: nextStart, endMs: nextEnd });
    };
    const onUp = (): void => {
      const current = dragRef.current;
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (current !== null) {
        setDragPreview((preview) => {
          if (preview !== null && preview.id === current.id) {
            if (current.kind.startsWith('overlay-')) {
              onTrimOverlay(current.id, preview.startMs, preview.endMs);
            } else {
              onTrimShot(current.id, preview.startMs, preview.endMs);
            }
          }
          return null;
        });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const clipTimes = (id: string, originStart: number, originEnd: number) => {
    if (dragPreview !== null && dragPreview.id === id) {
      return { startMs: dragPreview.startMs, endMs: dragPreview.endMs };
    }
    return { startMs: originStart, endMs: originEnd };
  };

  const rulerTicks = useMemo(() => {
    const targetPx = 90;
    const stepMs = [250, 500, 1000, 2000, 5000].find((step) => step * pxPerMs >= targetPx);
    if (stepMs === undefined) return [];
    const ticks: number[] = [];
    for (let t = 0; t <= windowMs; t += stepMs) ticks.push(t);
    return ticks;
  }, [windowMs, pxPerMs]);

  const isSelected = (kind: StudioSelection['kind'], id: string): boolean =>
    selection !== null && selection.kind === kind && selection.id === id;

  const laneLabel = (label: string, hint?: string) => (
    <div className="studio-tl__lane-label" title={hint}>
      <span className="mono">{label}</span>
    </div>
  );

  return (
    <section className="studio-tl" aria-label="Moment timeline" data-timeline="">
      <header className="studio-tl__head">
        <h2 className="studio-tl__title">Timeline</h2>
        <span className="mono studio-tl__clock" data-timeline-timecode="" ref={timecodeRef}>
          {formatMatchClock(startMs)}
        </span>
        <span className="mono studio-tl__span">
          {formatMatchClock(startMs)}–{formatMatchClock(endMs)} · {(windowMs / 1000).toFixed(1)} s
        </span>
        <div className="studio-tl__zoom" role="group" aria-label="Timeline zoom">
          <button
            type="button"
            className="studio-tl__zoom-btn"
            onClick={() => setPxPerMs((v) => Math.max(MIN_PX_PER_MS, v / 1.5))}
            title="Zoom out"
          >
            <span className="visually-hidden">Zoom out</span>−
          </button>
          <button
            type="button"
            className="studio-tl__zoom-btn"
            onClick={() => setPxPerMs((v) => Math.min(MAX_PX_PER_MS, v * 1.5))}
            title="Zoom in"
          >
            <span className="visually-hidden">Zoom in</span>+
          </button>
        </div>
      </header>
      <div className="studio-tl__scroll" data-timeline-scroll="">
        <div
          className="studio-tl__lanes"
          ref={lanesRef}
          style={{ width: `${widthPx}px` }}
          onPointerDown={onScrubPointerDown}
          role="presentation"
        >
          {/* Ruler */}
          <div className="studio-tl__ruler" aria-hidden="true">
            {rulerTicks.map((tick) => (
              <span key={tick} className="studio-tl__tick" style={{ left: `${tick * pxPerMs}px` }}>
                <span className="mono studio-tl__tick-label">
                  {formatMatchClock(startMs + tick)}
                </span>
              </span>
            ))}
          </div>

          {/* CAMERA lane */}
          <div className="studio-tl__lane" style={{ height: `${LANE_HEIGHT}px` }}>
            {laneLabel('CAMERA', 'Directed camera shots')}
            <div className="studio-tl__lane-body">
              {proposal.cameraTracks.map((track) => {
                const times = clipTimes(track.id, track.startMs, track.endMs);
                const selected = isSelected('shot', track.id);
                return (
                  <div
                    key={track.id}
                    data-clip="camera"
                    data-selected={selected ? 'true' : undefined}
                    data-hidden={hiddenIds.has(track.id) ? 'true' : undefined}
                    className={`studio-tl__clip studio-tl__clip--camera${selected ? ' studio-tl__clip--selected' : ''}`}
                    style={{
                      left: `${times.startMs * pxPerMs}px`,
                      width: `${Math.max(24, (times.endMs - times.startMs) * pxPerMs)}px`,
                    }}
                  >
                    <button
                      type="button"
                      className="studio-tl__clip-select"
                      onClick={() => onSelect({ kind: 'shot', id: track.id })}
                      aria-pressed={selected}
                      title={`${track.id} · ${track.keyframes.length} keyframes`}
                    >
                      <span className="studio-tl__clip-name mono">{track.id}</span>
                      <span className="studio-tl__clip-meta mono">{track.keyframes.length} kf</span>
                    </button>
                    <span
                      className="studio-tl__handle studio-tl__handle--start"
                      role="slider"
                      tabIndex={0}
                      aria-label={`Start of shot ${track.id} in milliseconds`}
                      aria-valuenow={times.startMs}
                      aria-valuemin={0}
                      aria-valuemax={windowMs}
                      onPointerDown={(event) =>
                        beginDrag(event, {
                          kind: 'shot-start',
                          id: track.id,
                          grabOffsetMs: times.startMs,
                          originStart: track.startMs,
                          originEnd: track.endMs,
                        })
                      }
                    />
                    <span
                      className="studio-tl__handle studio-tl__handle--end"
                      role="slider"
                      tabIndex={0}
                      aria-label={`End of shot ${track.id} in milliseconds`}
                      aria-valuenow={times.endMs}
                      aria-valuemin={0}
                      aria-valuemax={windowMs}
                      onPointerDown={(event) =>
                        beginDrag(event, {
                          kind: 'shot-end',
                          id: track.id,
                          grabOffsetMs: times.endMs,
                          originStart: track.startMs,
                          originEnd: track.endMs,
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* EVENTS lane (read-only source markers) */}
          <div className="studio-tl__lane" style={{ height: '28px' }}>
            {laneLabel('EVENTS', 'Accepted source events inside the moment (read-only)')}
            <div className="studio-tl__lane-body">
              {momentEvents.map((event) => (
                <button
                  key={event.eventId}
                  type="button"
                  data-clip="event"
                  data-selected={isSelected('event', event.eventId) ? 'true' : undefined}
                  className={`studio-tl__event${event.kind === 'goal' ? ' studio-tl__event--goal' : ''}${isSelected('event', event.eventId) ? ' studio-tl__event--selected' : ''}`}
                  style={{ left: `${(event.occurredAtMs - startMs) * pxPerMs}px` }}
                  onClick={() => onSelect({ kind: 'event', id: event.eventId })}
                  title={`${event.label} · ${event.actorId} · ${formatMatchClock(event.occurredAtMs)} (${event.eventId})`}
                >
                  <span className="visually-hidden">
                    {event.label} {event.actorId} at {formatMatchClock(event.occurredAtMs)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* OVERLAYS lane */}
          <div className="studio-tl__lane" style={{ height: `${LANE_HEIGHT}px` }}>
            {laneLabel('OVERLAYS', 'Evidence-bound broadcast overlays')}
            <div className="studio-tl__lane-body">
              {dataOverlays.map((overlay) => {
                const times = clipTimes(overlay.id, overlay.startMs, overlay.endMs);
                const selected = isSelected('overlay', overlay.id);
                return (
                  <div
                    key={overlay.id}
                    data-clip="overlay"
                    data-selected={selected ? 'true' : undefined}
                    data-hidden={hiddenIds.has(overlay.id) ? 'true' : undefined}
                    className={`studio-tl__clip studio-tl__clip--overlay${selected ? ' studio-tl__clip--selected' : ''}`}
                    style={{
                      left: `${times.startMs * pxPerMs}px`,
                      width: `${Math.max(24, (times.endMs - times.startMs) * pxPerMs)}px`,
                    }}
                  >
                    <button
                      type="button"
                      className="studio-tl__clip-select"
                      onClick={() => onSelect({ kind: 'overlay', id: overlay.id })}
                      aria-pressed={selected}
                      title={`${overlay.id} · ${overlay.kind} · evidence ${overlay.evidenceIds.join(', ')}`}
                    >
                      <span className="studio-tl__clip-name mono">{overlay.kind}</span>
                      <span className="studio-tl__clip-meta mono">
                        {((times.endMs - times.startMs) / 1000).toFixed(1)} s
                      </span>
                    </button>
                    <span
                      className="studio-tl__handle studio-tl__handle--start"
                      role="slider"
                      tabIndex={0}
                      aria-label={`Start of overlay ${overlay.id} in milliseconds`}
                      aria-valuenow={times.startMs}
                      aria-valuemin={0}
                      aria-valuemax={windowMs}
                      onPointerDown={(event) =>
                        beginDrag(event, {
                          kind: 'overlay-start',
                          id: overlay.id,
                          grabOffsetMs: times.startMs,
                          originStart: overlay.startMs,
                          originEnd: overlay.endMs,
                        })
                      }
                    />
                    <span
                      className="studio-tl__handle studio-tl__handle--end"
                      role="slider"
                      tabIndex={0}
                      aria-label={`End of overlay ${overlay.id} in milliseconds`}
                      aria-valuenow={times.endMs}
                      aria-valuemin={0}
                      aria-valuemax={windowMs}
                      onPointerDown={(event) =>
                        beginDrag(event, {
                          kind: 'overlay-end',
                          id: overlay.id,
                          grabOffsetMs: times.endMs,
                          originStart: overlay.startMs,
                          originEnd: overlay.endMs,
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* CAPTIONS lane */}
          <div className="studio-tl__lane" style={{ height: `${LANE_HEIGHT}px` }}>
            {laneLabel('CAPTIONS', 'Editorial hypothesis captions (number-free)')}
            <div className="studio-tl__lane-body">
              {captions.map((overlay) => {
                const times = clipTimes(overlay.id, overlay.startMs, overlay.endMs);
                const claimId = captionClaimId(overlay.id);
                const selected = selection?.kind === 'caption' && selection.id === overlay.id;
                return (
                  <div
                    key={overlay.id}
                    data-clip="caption"
                    data-selected={selected ? 'true' : undefined}
                    data-hidden={hiddenIds.has(overlay.id) ? 'true' : undefined}
                    className={`studio-tl__clip studio-tl__clip--caption${selected ? ' studio-tl__clip--selected' : ''}`}
                    style={{
                      left: `${times.startMs * pxPerMs}px`,
                      width: `${Math.max(24, (times.endMs - times.startMs) * pxPerMs)}px`,
                    }}
                  >
                    <button
                      type="button"
                      className="studio-tl__clip-select"
                      onClick={() =>
                        claimId !== null
                          ? onSelect({ kind: 'caption', id: overlay.id, claimId })
                          : onSelect({ kind: 'overlay', id: overlay.id })
                      }
                      aria-pressed={selected}
                      title={`${overlay.id} · editorial caption${claimId === null ? ' (no hypothesis claim shares its evidence)' : ''}`}
                    >
                      <span className="studio-tl__clip-name mono">caption</span>
                      <span className="studio-tl__clip-meta mono">
                        {((times.endMs - times.startMs) / 1000).toFixed(1)} s
                      </span>
                    </button>
                    <span
                      className="studio-tl__handle studio-tl__handle--start"
                      role="slider"
                      tabIndex={0}
                      aria-label={`Start of caption ${overlay.id} in milliseconds`}
                      aria-valuenow={times.startMs}
                      aria-valuemin={0}
                      aria-valuemax={windowMs}
                      onPointerDown={(event) =>
                        beginDrag(event, {
                          kind: 'overlay-start',
                          id: overlay.id,
                          grabOffsetMs: times.startMs,
                          originStart: overlay.startMs,
                          originEnd: overlay.endMs,
                        })
                      }
                    />
                    <span
                      className="studio-tl__handle studio-tl__handle--end"
                      role="slider"
                      tabIndex={0}
                      aria-label={`End of caption ${overlay.id} in milliseconds`}
                      aria-valuenow={times.endMs}
                      aria-valuemin={0}
                      aria-valuemax={windowMs}
                      onPointerDown={(event) =>
                        beginDrag(event, {
                          kind: 'overlay-end',
                          id: overlay.id,
                          grabOffsetMs: times.endMs,
                          originStart: overlay.startMs,
                          originEnd: overlay.endMs,
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* AUDIO lane — honest unavailability */}
          <div className="studio-tl__lane studio-tl__lane--unavailable" style={{ height: '22px' }}>
            {laneLabel('AUDIO')}
            <div className="studio-tl__lane-body">
              <p className="studio-tl__unavailable mono">
                AUDIO · UNAVAILABLE — no audio track exists in the manifest contract
              </p>
            </div>
          </div>

          <div className="studio-tl__playhead" ref={playheadRef} aria-hidden="true" />
        </div>
      </div>
      <p className="studio-tl__hint">
        Drag clip edges to trim (committed on release) · click empty lane space to scrub · inspector
        fields are the precise keyboard path
      </p>
    </section>
  );
}
