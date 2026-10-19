'use client';

import { useEffect, useRef } from 'react';
import { formatMatchClockTenths } from '@/lib/clock';
import { eventAtPlayhead } from '@/lib/playback';
import type { EvidenceProjection } from '@/lib/evidence-data';
import type { SceneData } from '@/lib/scene-data';
import type { CameraMode } from './scene/scene-context';

/**
 * The Analyst evidence rail (KYN-11) — a compact tactical-broadcast panel
 * beside the scene, not an analytics dashboard. Everything shown is
 * source-grounded: the verified separation metric (the same X-Ray number),
 * the current source event at the exact playhead, selected-player facts
 * with sampled coordinates and provenance, camera choice, and the X-Ray
 * affordance. Anything this fixture cannot support is stated as "not
 * available from this source" — never estimated.
 *
 * The rail is presentation only: it reads the engine through a ref-synced
 * DOM label (bounded cadence, no React re-render per frame) and never
 * writes the playhead except through the caller's explicit seek control.
 */

export interface AnalystRailProps {
  readonly scene: SceneData;
  readonly evidence: EvidenceProjection;
  readonly selectedEntityId: string | null;
  readonly camera: CameraMode;
  readonly onCamera: (mode: CameraMode) => void;
  readonly onXray: () => void;
  readonly onInspect: () => void;
  readonly xrayActive: boolean;
  readonly engineRef: Readonly<{ current: { playheadMs: number } }>;
  readonly getFrame: (t: number) => {
    positions: ReadonlyMap<
      string,
      { xM: number; yM: number; zM: number; exact: boolean; origin: string }
    >;
    velocitiesMps: ReadonlyMap<string, number>;
    missingEntityIds: readonly string[];
  };
}

const CAMERAS: readonly { id: CameraMode; label: string }[] = [
  { id: 'broadcast', label: 'Broadcast' },
  { id: 'overhead', label: 'Overhead' },
  { id: 'follow', label: 'Follow' },
  { id: 'goalkeeper', label: 'Goalkeeper' },
  { id: 'orbit', label: 'Free orbit' },
  { id: 'directed', label: 'Directed' },
];

export function AnalystRail({
  scene,
  evidence,
  selectedEntityId,
  camera,
  onCamera,
  onXray,
  onInspect,
  xrayActive,
  engineRef,
  getFrame,
}: AnalystRailProps) {
  const timeRef = useRef<HTMLSpanElement>(null);
  const eventRef = useRef<HTMLSpanElement>(null);
  /**
   * Ref on the CHANGING LEAF ONLY. Never put it on the <dl>: assigning
   * textContent to the container would delete the React-owned <dt>/<dd>
   * semantic structure (review round: facts DOM integrity).
   */
  const detailRef = useRef<HTMLSpanElement>(null);

  const selected =
    selectedEntityId !== null
      ? scene.players.find((p) => p.entityId === selectedEntityId)
      : undefined;

  // Bounded-cadence DOM sync (250 ms) — the rail mirrors the live playhead
  // without re-rendering React per frame.
  useEffect(() => {
    let lastText = '';
    const interval = window.setInterval(() => {
      const t = engineRef.current.playheadMs;
      const frame = getFrame(t);
      const active = eventAtPlayhead(t, scene.events);
      const parts: string[] = [formatMatchClockTenths(t)];
      if (timeRef.current !== null) timeRef.current.textContent = parts[0] ?? '';
      if (eventRef.current !== null) {
        eventRef.current.textContent = active
          ? `${active.phase === 'active' ? '' : 'next · '}${active.event.label} — ${active.event.actorId} (${active.event.eventId})`
          : 'open play';
      }
      if (detailRef.current !== null && selected !== undefined) {
        const pos = frame.positions.get(selected.entityId);
        const speed = frame.velocitiesMps.get(selected.entityId);
        const text =
          pos === undefined
            ? `${selected.entityId}: no tracked position at this instant`
            : `${selected.entityId}: ${pos.xM.toFixed(1)}, ${pos.yM.toFixed(1)} m${pos.exact ? '' : ' (interpolated)'} · ${speed === undefined ? 'speed n/a' : `${speed.toFixed(1)} m/s`} · ${pos.origin}`;
        if (text !== lastText) {
          lastText = text;
          detailRef.current.textContent = text;
        }
      }
    }, 250);
    return () => window.clearInterval(interval);
  }, [engineRef, getFrame, scene.events, selected]);

  const verified = evidence.status === 'verified' ? evidence.evidence : null;

  return (
    <aside className="rail" data-testid="analyst-rail" aria-label="Analysis">
      <header className="rail__head">
        <span className="mono rail__title">ANALYSIS</span>
        <span className="mono rail__clock" data-testid="rail-clock" ref={timeRef}>
          {formatMatchClockTenths(scene.initialFocusMs)}
        </span>
      </header>

      <section className="rail__section">
        <h3 className="rail__heading">Now</h3>
        <p className="rail__event">
          <span className="mono" data-testid="rail-event" ref={eventRef}>
            open play
          </span>
        </p>
        <dl className="rail__facts mono">
          <div>
            <dt>Selection</dt>
            <dd>
              {selected !== undefined
                ? `${scene.teams[selected.team]} #${selected.shirtNumber}`
                : 'none'}
            </dd>
          </div>
          <div>
            <dt>Selected detail</dt>
            <dd>
              <span data-testid="rail-selected-detail" ref={detailRef}>
                {selected !== undefined ? 'awaiting first sync' : 'select a player in the scene'}
              </span>
            </dd>
          </div>
        </dl>
      </section>

      <section className="rail__section">
        <h3 className="rail__heading">Measured separation</h3>
        {verified !== null ? (
          <>
            <p className="rail__measure mono" data-testid="rail-measure">
              {verified.separationBeforeM.toFixed(3)} → {verified.separationAfterM.toFixed(3)} m (+
              {verified.deltaM.toFixed(3)})
            </p>
            <p className="rail__fine">
              {verified.defenderId} ↔ {verified.strikerId} ·{' '}
              {formatMatchClockTenths(verified.fromMs)}–{formatMatchClockTenths(verified.toMs)} ·{' '}
              {verified.classification} · {verified.algorithmVersion}
            </p>
            <div className="rail__actions">
              <button
                type="button"
                className={`rail__btn${xrayActive ? ' rail__btn--active' : ''}`}
                aria-pressed={xrayActive}
                onClick={onXray}
              >
                {xrayActive ? 'X-Ray on' : 'Show X-Ray'}
              </button>
              <button type="button" className="rail__btn" onClick={onInspect}>
                Source evidence
              </button>
            </div>
            <p className="rail__interpretation">
              <span className="mono rail__interpretation-tag">Interpretation</span>
              {evidence.status === 'verified' ? evidence.interpretation.text : ''}
            </p>
          </>
        ) : (
          <p className="rail__unavailable" data-testid="rail-measure-unavailable">
            Not available from this source —{' '}
            {evidence.status === 'unverified' ? evidence.reason : 'verification failed'}
          </p>
        )}
      </section>

      <section className="rail__section">
        <h3 className="rail__heading">Camera</h3>
        <div className="rail__cameras" role="radiogroup" aria-label="Camera (analyst)">
          {CAMERAS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={camera === option.id}
              className="rail__camera"
              onClick={() => onCamera(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section className="rail__section rail__section--fine">
        <h3 className="rail__heading">Not available from this source</h3>
        <p className="rail__fine">
          Possession pressure, expected goals, player intent and causal probabilities are not
          provided by this fixture — they are never estimated here.
        </p>
      </section>
    </aside>
  );
}
