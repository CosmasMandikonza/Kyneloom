'use client';

import { useEffect, useMemo, useRef } from 'react';
import { formatMatchClockTenths } from '@/lib/clock';
import { eventAtPlayhead } from '@/lib/playback';
import { KITS } from './footballers';
import type { SceneRuntime } from './scene-context';

/**
 * 2D tactical fallback (KYN-06): a genuine accessible alternative for
 * WebGL-less devices, context loss or asset failure — the SAME football
 * timeline, the SAME sampler, the SAME transport. Rendered as SVG driven by
 * one rAF loop that mutates circle positions directly (no React re-renders
 * per frame).
 */

const PX_PER_M = 10;
const W = 105 * PX_PER_M;
const H = 68 * PX_PER_M;

export type FallbackReason = 'webgl-unavailable' | 'context-lost' | 'asset-error' | 'user-choice';

const REASON_TEXT: Record<FallbackReason, string> = {
  'webgl-unavailable': 'WebGL is unavailable on this device — showing the 2D tactical view.',
  'context-lost': 'The 3D context was lost — showing the 2D tactical view.',
  'asset-error': 'The 3D scene failed to load — showing the 2D tactical view.',
  'user-choice': '2D tactical view.',
};

export function Fallback2D({ runtime, reason }: { runtime: SceneRuntime; reason: FallbackReason }) {
  const { scene, engine, getFrame, selected, onSelect } = runtime;
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);
  const ballRef = useRef<SVGCircleElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const players = scene.players;
  const kitColor = useMemo(() => {
    const colors = new Map<string, string>();
    for (const player of players) {
      const kit = player.isGoalkeeper
        ? player.team === 'home'
          ? KITS['home-gk']
          : KITS['away-gk']
        : KITS[player.team];
      colors.set(player.entityId, kit.shirt);
    }
    return colors;
  }, [players]);

  useEffect(() => {
    let raf = 0;
    let lastLabel = '';
    const tick = (): void => {
      const t = engine.playheadMs;
      const frame = getFrame(t);
      players.forEach((player, index) => {
        const dot = dotRefs.current[index];
        if (dot === null || dot === undefined) return;
        const sample = frame.positions.get(player.entityId);
        if (sample === undefined) {
          dot.style.display = 'none';
          return;
        }
        dot.style.display = '';
        dot.setAttribute('cx', String((sample.xM + 52.5) * PX_PER_M));
        dot.setAttribute('cy', String((sample.yM + 34) * PX_PER_M));
      });
      const ball = ballRef.current;
      if (ball !== null) {
        const sample = frame.positions.get(scene.ballEntityId);
        if (sample === undefined) {
          ball.style.display = 'none';
        } else {
          ball.style.display = '';
          ball.setAttribute('cx', String((sample.xM + 52.5) * PX_PER_M));
          ball.setAttribute('cy', String((sample.yM + 34) * PX_PER_M));
          ball.setAttribute('r', String(4 + sample.zM * 1.5));
        }
      }
      const status = statusRef.current;
      if (status !== null) {
        const event = eventAtPlayhead(t, scene.events);
        const label = `${formatMatchClockTenths(t)} · ${event ? `${event.phase === 'active' ? '' : 'next: '}${event.event.label}` : 'open play'} · ${frame.missingEntityIds.length} missing`;
        if (label !== lastLabel) {
          lastLabel = label;
          status.textContent = label;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, getFrame, players, scene.ballEntityId, scene.events]);

  return (
    <div className="fallback2d" data-scene-fallback={reason}>
      <p className="stage__status mono" role="status">
        2D TACTICAL · {REASON_TEXT[reason]}
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="fallback2d__svg"
        role="img"
        aria-label="Top-down tactical view of the 22 footballers and ball on the same replay timeline"
      >
        <rect x="0" y="0" width={W} height={H} fill="#0d3a20" />
        <g stroke="rgba(245,250,246,0.75)" strokeWidth="2" fill="none">
          <rect x="6" y="6" width={W - 12} height={H - 12} />
          <line x1={W / 2} y1="6" x2={W / 2} y2={H - 6} />
          <circle cx={W / 2} cy={H / 2} r={9.15 * PX_PER_M} />
          <rect
            x="6"
            y={(H - 40.32 * PX_PER_M) / 2}
            width={16.5 * PX_PER_M}
            height={40.32 * PX_PER_M}
          />
          <rect
            x={W - 6 - 16.5 * PX_PER_M}
            y={(H - 40.32 * PX_PER_M) / 2}
            width={16.5 * PX_PER_M}
            height={40.32 * PX_PER_M}
          />
        </g>
        {players.map((player, index) => (
          <g key={player.entityId}>
            <circle
              ref={(node) => {
                dotRefs.current[index] = node;
              }}
              r="9"
              fill={kitColor.get(player.entityId)}
              stroke={selected.entityId === player.entityId ? '#51d7bd' : 'rgba(7,19,25,0.8)'}
              strokeWidth={selected.entityId === player.entityId ? 3 : 1.5}
              onPointerDown={() =>
                onSelect(selected.entityId === player.entityId ? null : player.entityId)
              }
            >
              <title>{`${player.entityId} · ${scene.teams[player.team]} · #${player.shirtNumber}`}</title>
            </circle>
          </g>
        ))}
        <circle ref={ballRef} r="4" fill="#f2f8f6" stroke="#101e27" strokeWidth="1" />
      </svg>
      <p ref={statusRef} className="visually-hidden" aria-live="polite" />
    </div>
  );
}
