'use client';

import { useEffect, useState } from 'react';
import type { ContractValidationError, MomentProposal } from '@kyneloom/contracts';
import type { SceneData } from '@/lib/scene-data';
import { SHOT_PRESETS } from '@/lib/studio/presets';
import { formatMatchClock } from '@/lib/clock';
import type { StudioSelection } from './selection';

/**
 * KYN-17 — the contextual inspector. Every control edits the TYPED draft
 * through validated operations (exact field-path errors render inline); the
 * numeric fields commit on blur/Enter, which keeps every commit ONE undoable
 * command. Read-only sections (evidence, events) are provenance, not inputs.
 */
export interface InspectorProps {
  readonly proposal: MomentProposal;
  readonly scene: SceneData;
  readonly selection: StudioSelection | null;
  readonly editErrors: readonly ContractValidationError[];
  readonly onSetShotInterval: (trackId: string, startMs: number, endMs: number) => void;
  readonly onSetKeyframeTime: (trackId: string, index: number, tMs: number) => void;
  readonly onSetKeyframePose: (
    trackId: string,
    index: number,
    pose: {
      readonly position?: readonly [number, number, number];
      readonly target?: readonly [number, number, number];
      readonly fovDeg?: number;
    },
  ) => void;
  readonly onAddKeyframe: (trackId: string, atMs: number) => void;
  readonly onRemoveKeyframe: (trackId: string, index: number) => void;
  readonly onApplyPreset: (trackId: string, presetId: string) => void;
  readonly onSetOverlayInterval: (overlayId: string, startMs: number, endMs: number) => void;
  readonly onSetCaptionText: (claimId: string, text: string) => void;
  readonly onSetCaptionDisclosure: (claimId: string, disclosure: string) => void;
  readonly onSeekTo: (absoluteMs: number) => void;
}

function NumberField({
  label,
  value,
  step = 1,
  onCommit,
  title,
}: {
  readonly label: string;
  readonly value: number;
  readonly step?: number;
  readonly onCommit: (next: number) => void;
  readonly title?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);
  const commit = (): void => {
    setFocused(false);
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
    else setDraft(String(value));
  };
  return (
    <label className="studio-ins__field" title={title}>
      <span className="studio-ins__field-label mono">{label}</span>
      <input
        className="studio-ins__input mono"
        type="number"
        step={step}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

function TextField({
  label,
  value,
  rows = 2,
  onCommit,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly rows?: number;
  readonly onCommit: (next: string) => void;
  readonly hint?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  const commit = (): void => {
    setFocused(false);
    if (draft !== value) onCommit(draft);
  };
  return (
    <label className="studio-ins__field studio-ins__field--wide">
      <span className="studio-ins__field-label mono">{label}</span>
      <textarea
        className="studio-ins__textarea"
        rows={rows}
        value={draft}
        maxLength={1000}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={commit}
      />
      {hint === undefined ? null : <span className="studio-ins__hint">{hint}</span>}
    </label>
  );
}

function ErrorList({ errors }: { readonly errors: readonly ContractValidationError[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="studio-ins__errors" role="alert" data-edit-errors="">
      <p className="studio-ins__errors-title mono">REJECTED — NOTHING WAS APPLIED</p>
      <ul>
        {errors.map((error) => (
          <li key={`${error.fieldPath}-${error.message}`} className="studio-ins__error">
            <span className="mono studio-ins__error-path">{error.fieldPath}</span>
            <span>{error.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Inspector(props: InspectorProps) {
  const { proposal, scene, selection, editErrors } = props;
  const [startMs] = proposal.timeRangeMs;

  if (selection === null) {
    return (
      <section className="studio-ins" aria-label="Inspector" data-inspector="">
        <h2 className="studio-ins__title">Inspector</h2>
        <p className="studio-ins__empty">
          Select a camera shot, overlay, caption or event — in the timeline or the layers rail — to
          edit its typed properties here.
        </p>
        <ErrorList errors={editErrors} />
      </section>
    );
  }

  if (selection.kind === 'shot') {
    const track = proposal.cameraTracks.find((candidate) => candidate.id === selection.id);
    if (track === undefined) {
      return (
        <section className="studio-ins" aria-label="Inspector">
          <h2 className="studio-ins__title">Inspector</h2>
          <p className="studio-ins__empty">This shot no longer exists in the draft.</p>
        </section>
      );
    }
    return (
      <section className="studio-ins" aria-label="Inspector" data-inspector="shot">
        <h2 className="studio-ins__title">Shot · {track.id}</h2>
        <ErrorList errors={editErrors} />
        <div className="studio-ins__group">
          <h3 className="studio-ins__group-title mono">PRESET</h3>
          <div className="studio-ins__presets" role="group" aria-label="Camera preset">
            {SHOT_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="studio-ins__preset"
                aria-pressed={track.id === preset.id}
                title={preset.description}
                data-preset={preset.id}
                onClick={() => props.onApplyPreset(track.id, preset.id)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <p className="studio-ins__hint">
            Applying a preset REPLACES this shot with deterministic keyframes (the winger follow is
            baked from the run’s real samples) — one undoable command.
          </p>
        </div>
        <div className="studio-ins__group">
          <h3 className="studio-ins__group-title mono">TIMING (moment offsets, ms)</h3>
          <div className="studio-ins__row">
            <NumberField
              label="start"
              value={track.startMs}
              onCommit={(v) => props.onSetShotInterval(track.id, v, track.endMs)}
            />
            <NumberField
              label="end"
              value={track.endMs}
              onCommit={(v) => props.onSetShotInterval(track.id, track.startMs, v)}
            />
            <span className="studio-ins__readonly mono">
              {((track.endMs - track.startMs) / 1000).toFixed(1)} s
            </span>
          </div>
        </div>
        <div className="studio-ins__group">
          <h3 className="studio-ins__group-title mono">KEYFRAMES · pitch meters, z up</h3>
          <div className="studio-ins__kf-table" role="table" aria-label="Keyframes">
            <div className="studio-ins__kf-head mono" role="row">
              <span role="columnheader">t ms</span>
              <span role="columnheader">pos x</span>
              <span role="columnheader">pos y</span>
              <span role="columnheader">alt z</span>
              <span role="columnheader">tgt x</span>
              <span role="columnheader">tgt y</span>
              <span role="columnheader">tgt z</span>
              <span role="columnheader">fov</span>
              <span role="columnheader" />
            </div>
            {track.keyframes.map((kf, index) => (
              <div
                className="studio-ins__kf-row"
                role="row"
                key={`${track.id}-kf-${String(index)}-${String(kf.tMs)}`}
                data-keyframe={String(index)}
              >
                <NumberField
                  label=""
                  value={kf.tMs}
                  step={100}
                  onCommit={(v) => props.onSetKeyframeTime(track.id, index, v)}
                />
                <NumberField
                  label=""
                  value={kf.position[0]}
                  step={0.5}
                  onCommit={(v) =>
                    props.onSetKeyframePose(track.id, index, {
                      position: [v, kf.position[1]!, kf.position[2]!],
                    })
                  }
                />
                <NumberField
                  label=""
                  value={kf.position[1]}
                  step={0.5}
                  onCommit={(v) =>
                    props.onSetKeyframePose(track.id, index, {
                      position: [kf.position[0]!, v, kf.position[2]!],
                    })
                  }
                />
                <NumberField
                  label=""
                  value={kf.position[2]}
                  step={0.5}
                  title="Camera altitude — the contract floor is 0.5 m"
                  onCommit={(v) =>
                    props.onSetKeyframePose(track.id, index, {
                      position: [kf.position[0]!, kf.position[1]!, v],
                    })
                  }
                />
                <NumberField
                  label=""
                  value={kf.target[0]}
                  step={0.5}
                  onCommit={(v) =>
                    props.onSetKeyframePose(track.id, index, {
                      target: [v, kf.target[1]!, kf.target[2]!],
                    })
                  }
                />
                <NumberField
                  label=""
                  value={kf.target[1]}
                  step={0.5}
                  onCommit={(v) =>
                    props.onSetKeyframePose(track.id, index, {
                      target: [kf.target[0]!, v, kf.target[2]!],
                    })
                  }
                />
                <NumberField
                  label=""
                  value={kf.target[2]}
                  step={0.5}
                  onCommit={(v) =>
                    props.onSetKeyframePose(track.id, index, {
                      target: [kf.target[0]!, kf.target[1]!, v],
                    })
                  }
                />
                <NumberField
                  label=""
                  value={kf.fovDeg}
                  step={1}
                  title="Field of view, 20–120°"
                  onCommit={(v) => props.onSetKeyframePose(track.id, index, { fovDeg: v })}
                />
                <button
                  type="button"
                  className="studio-ins__kf-remove"
                  disabled={track.keyframes.length <= 2}
                  onClick={() => props.onRemoveKeyframe(track.id, index)}
                  title={
                    track.keyframes.length <= 2
                      ? 'A shot keeps at least two keyframes'
                      : 'Remove this keyframe'
                  }
                >
                  <span className="visually-hidden">Remove keyframe {String(index)}</span>×
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="studio-ins__add-kf"
            data-add-keyframe=""
            onClick={() => {
              const last = track.keyframes[track.keyframes.length - 1]!;
              const before = track.keyframes[track.keyframes.length - 2] ?? last;
              const at = Math.min(track.endMs, last.tMs + Math.max(100, last.tMs - before.tMs));
              props.onAddKeyframe(track.id, at);
            }}
          >
            + Add keyframe
          </button>
        </div>
      </section>
    );
  }

  if (selection.kind === 'overlay' || selection.kind === 'caption') {
    const overlay = proposal.overlays.find((candidate) => candidate.id === selection.id);
    if (overlay === undefined) {
      return (
        <section className="studio-ins" aria-label="Inspector">
          <h2 className="studio-ins__title">Inspector</h2>
          <p className="studio-ins__empty">This overlay no longer exists in the draft.</p>
        </section>
      );
    }
    const claim =
      selection.kind === 'caption'
        ? proposal.claims.find((candidate) => candidate.id === selection.claimId)
        : undefined;
    return (
      <section
        className="studio-ins"
        aria-label="Inspector"
        data-inspector={selection.kind === 'caption' ? 'caption' : 'overlay'}
      >
        <h2 className="studio-ins__title">
          {selection.kind === 'caption' ? 'Caption' : 'Overlay'} · {overlay.id}
        </h2>
        <ErrorList errors={editErrors} />
        <div className="studio-ins__group">
          <h3 className="studio-ins__group-title mono">TIMING (moment offsets, ms)</h3>
          <div className="studio-ins__row">
            <NumberField
              label="start"
              value={overlay.startMs}
              step={100}
              onCommit={(v) => props.onSetOverlayInterval(overlay.id, v, overlay.endMs)}
            />
            <NumberField
              label="end"
              value={overlay.endMs}
              step={100}
              onCommit={(v) => props.onSetOverlayInterval(overlay.id, overlay.startMs, v)}
            />
            <span className="studio-ins__readonly mono">
              {((overlay.endMs - overlay.startMs) / 1000).toFixed(1)} s ·{' '}
              {formatMatchClock(startMs + overlay.startMs)}+
            </span>
          </div>
        </div>
        <div className="studio-ins__group">
          <h3 className="studio-ins__group-title mono">PROVENANCE (read-only)</h3>
          <dl className="studio-ins__facts">
            <div>
              <dt>kind</dt>
              <dd className="mono">{overlay.kind}</dd>
            </div>
            <div>
              <dt>evidence</dt>
              <dd className="mono">{overlay.evidenceIds.join(', ')}</dd>
            </div>
            {overlay.metricRef === undefined ? null : (
              <div>
                <dt>metric</dt>
                <dd className="mono">{overlay.metricRef}</dd>
              </div>
            )}
          </dl>
          <p className="studio-ins__hint">
            Evidence binding and metric references are compiler-verified territory — a correct
            number may never be displayed under unrelated provenance.
          </p>
        </div>
        {selection.kind === 'caption' && claim !== undefined ? (
          <div className="studio-ins__group">
            <h3 className="studio-ins__group-title mono">EDITORIAL TEXT (number-free)</h3>
            <TextField
              label="caption text"
              value={claim.text ?? ''}
              rows={3}
              onCommit={(text) => props.onSetCaptionText(claim.id, text)}
              hint="The one prose channel. Numbers are verified claims — numeric tokens are rejected with the token named."
            />
            <TextField
              label="inference disclosure"
              value={claim.inferenceDisclosure ?? ''}
              rows={2}
              onCommit={(text) => props.onSetCaptionDisclosure(claim.id, text)}
              hint="Discloses what is interpretation rather than fact (rendered with the caption and recap)."
            />
          </div>
        ) : null}
        {selection.kind === 'caption' && claim === undefined ? (
          <p className="studio-ins__hint">
            No hypothesis claim shares this caption’s evidence — the compiler will reject it.
            Caption prose edits require a bound claim.
          </p>
        ) : null}
      </section>
    );
  }

  // Event: read-only source evidence.
  const event = scene.events.find((candidate) => candidate.eventId === selection.id);
  const proposalEvidence = proposal.evidence.find(
    (entry) => entry.ref === selection.id || entry.id === selection.id,
  );
  if (event === undefined) {
    return (
      <section className="studio-ins" aria-label="Inspector">
        <h2 className="studio-ins__title">Inspector</h2>
        <p className="studio-ins__empty">This event is not part of the moment window.</p>
      </section>
    );
  }
  return (
    <section className="studio-ins" aria-label="Inspector" data-inspector="event">
      <h2 className="studio-ins__title">Source event · {event.eventId}</h2>
      <ErrorList errors={editErrors} />
      <dl className="studio-ins__facts">
        <div>
          <dt>kind</dt>
          <dd className="mono">{event.kind}</dd>
        </div>
        <div>
          <dt>label</dt>
          <dd>{event.label}</dd>
        </div>
        <div>
          <dt>actor</dt>
          <dd className="mono">{event.actorId}</dd>
        </div>
        <div>
          <dt>team</dt>
          <dd className="mono">{event.teamId}</dd>
        </div>
        <div>
          <dt>clock</dt>
          <dd className="mono">
            {formatMatchClock(event.occurredAtMs)} (offset {String(event.occurredAtMs - startMs)}{' '}
            ms)
          </dd>
        </div>
        <div>
          <dt>cited as evidence</dt>
          <dd className="mono">{proposalEvidence === undefined ? 'no' : proposalEvidence.id}</dd>
        </div>
      </dl>
      <button
        type="button"
        className="studio-ins__add-kf"
        onClick={() => props.onSeekTo(event.occurredAtMs)}
      >
        ▸ Move the playhead here
      </button>
      <p className="studio-ins__hint">
        Source events are accepted reducer facts — they are the moment’s anchors, never editable
        here.
      </p>
    </section>
  );
}
