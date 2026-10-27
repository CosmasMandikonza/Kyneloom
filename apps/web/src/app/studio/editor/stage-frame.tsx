'use client';

import { useEffect, useRef, useState } from 'react';
import type { MomentProposal } from '@kyneloom/contracts';
import type { ReplayEngine } from '@/app/explore/scene/scene-context';
import type { ReactNode } from 'react';

/**
 * KYN-17 — the stage wrap: the real R3F stage plus the production framing
 * chrome (safe-frame guides, the shot live at the playhead, the selected-shot
 * state). Guides and chips are view affordances over the unchanged stage.
 */
export function StageFrame({
  children,
  proposal,
  engineRef,
  selectedShotId,
  draftDirty,
}: {
  readonly children: ReactNode;
  readonly proposal: MomentProposal;
  readonly engineRef: { readonly current: ReplayEngine | null };
  readonly selectedShotId: string | null;
  readonly draftDirty: boolean;
}) {
  const [guides, setGuides] = useState(false);
  const [liveShotId, setLiveShotId] = useState<string | null>(null);
  const shotRef = useRef<HTMLSpanElement>(null);

  // Which shot's interval contains the playhead (throttled DOM-read loop —
  // React state only when the answer CHANGES).
  const tracksRef = useRef(proposal.cameraTracks);
  tracksRef.current = proposal.cameraTracks;
  const startRef = useRef(proposal.timeRangeMs[0]);
  startRef.current = proposal.timeRangeMs[0];
  useEffect(() => {
    let raf = 0;
    let last = 0;
    let lastId: string | null = null;
    const loop = (now: number): void => {
      if (now - last > 120) {
        last = now;
        const engine = engineRef.current;
        if (engine !== null) {
          const offset = engine.playheadMs - startRef.current;
          const live =
            tracksRef.current.find((track) => offset >= track.startMs && offset <= track.endMs) ??
            null;
          if ((live?.id ?? null) !== lastId) {
            lastId = live?.id ?? null;
            setLiveShotId(lastId);
          }
          if (shotRef.current !== null) {
            shotRef.current.textContent = live === null ? '—' : live.id;
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engineRef]);

  return (
    <div className="studio-stage" data-stage-frame="">
      {children}
      <div className="studio-stage__hud" aria-hidden="true">
        <span className="studio-stage__chip mono" data-live-shot-chip="">
          SHOT <span ref={shotRef}>—</span>
        </span>
        {selectedShotId !== null ? (
          <span
            className="studio-stage__chip studio-stage__chip--selected mono"
            data-selected-shot-chip={selectedShotId}
          >
            SELECTED {selectedShotId}
          </span>
        ) : null}
        {draftDirty ? (
          <span className="studio-stage__chip studio-stage__chip--draft mono">
            DRAFT PREVIEW — UNCOMPILED EDITS
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className={`studio-stage__guides${guides ? ' studio-stage__guides--on' : ''}`}
        aria-pressed={guides}
        onClick={() => setGuides((current) => !current)}
        title="Toggle broadcast safe-frame guides (view only)"
        data-safe-frame-toggle=""
      >
        Safe frames
      </button>
      {guides ? (
        <div className="studio-stage__safe" aria-hidden="true">
          <span className="studio-stage__safe-action" />
          <span className="studio-stage__safe-title" />
        </div>
      ) : null}
      <span className="visually-hidden" data-live-shot-value={liveShotId ?? ''} />
    </div>
  );
}
