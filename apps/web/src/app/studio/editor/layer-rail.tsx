'use client';

import type { MomentProposal } from '@kyneloom/contracts';
import type { SceneData } from '@/lib/scene-data';
import { formatMatchClock } from '@/lib/clock';
import type { StudioSelection } from './selection';
import { captionClaimIdFor } from './selection';

/**
 * KYN-17 — the compact scene/layers rail: every editable object as a native
 * selectable list row, grouped by kind, with PREVIEW-ONLY visibility toggles
 * (view state — the compiled document is untouched and nothing hidden is
 * ever saved).
 */
export interface LayerRailProps {
  readonly proposal: MomentProposal;
  readonly scene: SceneData;
  readonly selection: StudioSelection | null;
  readonly hiddenIds: ReadonlySet<string>;
  readonly onSelect: (selection: StudioSelection | null) => void;
  readonly onToggleVisibility: (id: string) => void;
  readonly onSeekTo: (absoluteMs: number) => void;
}

export function LayerRail({
  proposal,
  scene,
  selection,
  hiddenIds,
  onSelect,
  onToggleVisibility,
  onSeekTo,
}: LayerRailProps) {
  const [startMs, endMs] = proposal.timeRangeMs;
  const momentEvents = scene.events.filter(
    (event) => event.occurredAtMs >= startMs && event.occurredAtMs <= endMs,
  );
  const dataOverlays = proposal.overlays.filter((overlay) => overlay.kind !== 'caption');
  const captions = proposal.overlays.filter((overlay) => overlay.kind === 'caption');

  const row = (
    id: string,
    kind: StudioSelection['kind'],
    label: string,
    meta: string,
    selected: boolean,
    hidden: boolean,
    seekMs: number | null,
    extra?: { readonly claimId?: string },
  ): React.ReactNode => (
    <li key={`${kind}-${id}`} className="studio-rail__row" data-layer-id={id}>
      <button
        type="button"
        className={`studio-rail__select${selected ? ' studio-rail__select--selected' : ''}`}
        aria-pressed={selected}
        onClick={() => {
          if (selected) {
            onSelect(null);
          } else if (kind === 'caption' && extra?.claimId !== undefined) {
            onSelect({ kind: 'caption', id, claimId: extra.claimId });
          } else if (kind === 'shot') {
            onSelect({ kind: 'shot', id });
          } else if (kind === 'overlay') {
            onSelect({ kind: 'overlay', id });
          } else {
            onSelect({ kind: 'event', id });
          }
        }}
      >
        <span className="studio-rail__label">{label}</span>
        <span className="studio-rail__meta mono">{meta}</span>
      </button>
      {seekMs === null ? null : (
        <button
          type="button"
          className="studio-rail__seek mono"
          onClick={() => onSeekTo(seekMs)}
          title={`Move the playhead to ${formatMatchClock(seekMs)}`}
        >
          ▸<span className="visually-hidden">Seek to {formatMatchClock(seekMs)}</span>
        </button>
      )}
      <button
        type="button"
        className={`studio-rail__eye${hidden ? ' studio-rail__eye--hidden' : ''}`}
        aria-pressed={hidden}
        onClick={() => onToggleVisibility(id)}
        title={
          hidden
            ? 'Hidden in the PREVIEW only — never saved, compile ignores it'
            : 'Hide from the preview only (not saved)'
        }
      >
        <span className="visually-hidden">Toggle preview visibility for {label}</span>
        {hidden ? '○' : '◉'}
      </button>
    </li>
  );

  return (
    <nav className="studio-rail" aria-label="Moment layers" data-layer-rail="">
      <section className="studio-rail__group">
        <h3 className="studio-rail__group-title mono">CAMERA SHOTS</h3>
        <ul className="studio-rail__list">
          {proposal.cameraTracks.map((track) =>
            row(
              track.id,
              'shot',
              track.id,
              `${track.keyframes.length} kf · ${((track.endMs - track.startMs) / 1000).toFixed(1)} s`,
              selection?.kind === 'shot' && selection.id === track.id,
              hiddenIds.has(track.id),
              startMs + track.startMs,
            ),
          )}
        </ul>
      </section>
      <section className="studio-rail__group">
        <h3 className="studio-rail__group-title mono">BROADCAST OVERLAYS</h3>
        <ul className="studio-rail__list">
          {dataOverlays.map((overlay) =>
            row(
              overlay.id,
              'overlay',
              overlay.kind,
              overlay.evidenceIds.join(', '),
              selection?.kind === 'overlay' && selection.id === overlay.id,
              hiddenIds.has(overlay.id),
              startMs + overlay.startMs,
            ),
          )}
        </ul>
      </section>
      <section className="studio-rail__group">
        <h3 className="studio-rail__group-title mono">EDITORIAL CAPTIONS</h3>
        <ul className="studio-rail__list">
          {captions.map((overlay) => {
            const claimId = captionClaimIdFor(overlay, proposal.claims);
            return row(
              overlay.id,
              'caption',
              'caption',
              claimId === null ? 'no claim bound' : claimId,
              selection?.kind === 'caption' && selection.id === overlay.id,
              hiddenIds.has(overlay.id),
              startMs + overlay.startMs,
              { claimId: claimId ?? undefined },
            );
          })}
        </ul>
      </section>
      <section className="studio-rail__group">
        <h3 className="studio-rail__group-title mono">SOURCE EVENTS</h3>
        <ul className="studio-rail__list">
          {momentEvents.map((event) =>
            row(
              event.eventId,
              'event',
              event.label,
              `${event.actorId} · ${formatMatchClock(event.occurredAtMs)}`,
              selection?.kind === 'event' && selection.id === event.eventId,
              false,
              event.occurredAtMs,
            ),
          )}
        </ul>
      </section>
      <p className="studio-rail__note">
        Visibility toggles affect the PREVIEW only — they are view state, never saved, and the
        compiler ignores them.
      </p>
    </nav>
  );
}
