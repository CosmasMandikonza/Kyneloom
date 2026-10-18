'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMatchClockTenths } from '@/lib/clock';
import {
  describeSpatialState,
  transcriptEntries,
  type TranscriptEntry,
} from '@/lib/lens-selectors';
import type { EvidenceProjection } from '@/lib/evidence-data';
import type { SceneData } from '@/lib/scene-data';
import { createSpeechController, type SpeechController } from './speech';

/**
 * The Accessible panel (KYN-11): a complete non-visual equivalent of the
 * moment, driven by the SAME authoritative timeline. Spatial descriptions
 * are GENERATED from the current sampled state (pure selector, unit
 * tested) — never hardcoded narration. The transcript lists every source
 * event with its id and actor plus the verified measurement and its
 * interpretation, each classified. Browser speech synthesis (feature
 * detected, honestly labeled as the device engine) is optional.
 *
 * Updates run at a BOUNDED cadence (500 ms + engine revision), and the
 * live region announces only changes — assistive tech is never flooded
 * per animation frame.
 */

export interface AccessiblePanelProps {
  readonly scene: SceneData;
  readonly evidence: EvidenceProjection;
  /** Live engine reference (playhead read at bounded cadence). */
  readonly engine: { playheadMs: number };
  /** Mirrored playback state for the transport label. */
  readonly playing: boolean;
  readonly selectedEntityId: string | null;
  readonly getFrame: (t: number) => Parameters<typeof describeSpatialState>[0]['frame'];
  readonly onSeek: (ms: number) => void;
  readonly onTogglePlay: () => void;
  readonly onStep: (direction: 1 | -1) => void;
  /** Current view (3D scene or 2D tactical). */
  readonly view: '3d' | '2d';
  /** Explicit opt-in for the lens-recommended 2D tactical view. */
  readonly onUse2D: () => void;
}

const KIND_LABELS: Record<TranscriptEntry['kind'], string> = {
  event: 'EVENT',
  measurement: 'MEASUREMENT',
  interpretation: 'INTERPRETATION',
};

export function AccessiblePanel({
  scene,
  evidence,
  engine,
  playing,
  selectedEntityId,
  getFrame,
  onSeek,
  onTogglePlay,
  onStep,
  view,
  onUse2D,
}: AccessiblePanelProps) {
  const descriptionRef = useRef<HTMLDivElement>(null);
  const speechRef = useRef<SpeechController | null>(null);
  const [rate, setRate] = useState(1);
  const [lastAnnouncement, setLastAnnouncement] = useState('');

  const transcript = useMemo(() => transcriptEntries(scene, evidence), [scene, evidence]);

  // Bounded-cadence spatial description: recomputed from the sampled state
  // at most every 500 ms (and on transport revisions), written directly to
  // the DOM — no React re-render per frame.
  useEffect(() => {
    let lastText = '';
    const sync = (): void => {
      const t = engine.playheadMs;
      const description = describeSpatialState({
        scene,
        frame: getFrame(t),
        playheadMs: t,
        selectedEntityId,
      });
      const text = `${description.summary} ${description.details.join(' ')}`;
      if (text !== lastText && descriptionRef.current !== null) {
        lastText = text;
        descriptionRef.current.dataset.playhead = String(t);
        // Keep the DOM light: summary line + detail list rebuilt only on change.
        const existing = descriptionRef.current;
        existing.replaceChildren();
        const summaryP = document.createElement('p');
        summaryP.className = 'a11y__summary';
        summaryP.textContent = description.summary;
        existing.append(summaryP);
        const ul = document.createElement('ul');
        ul.className = 'a11y__details';
        for (const detail of description.details) {
          const li = document.createElement('li');
          li.textContent = detail;
          ul.append(li);
        }
        existing.append(ul);
      }
    };
    sync();
    const interval = window.setInterval(sync, 500);
    return () => window.clearInterval(interval);
  }, [engine, getFrame, scene, selectedEntityId]);

  // Optional browser speech synthesis — created on demand, destroyed on
  // unmount/lens exit so no voice outlives the panel.
  useEffect(() => {
    return () => {
      speechRef.current?.destroy();
      speechRef.current = null;
    };
  }, []);

  const speakCurrent = (): void => {
    if (speechRef.current === null) {
      speechRef.current = createSpeechController(window);
    }
    const controller = speechRef.current;
    if (!controller.supported) return;
    const t = engine.playheadMs;
    const description = describeSpatialState({
      scene,
      frame: getFrame(t),
      playheadMs: t,
      selectedEntityId,
    });
    const text = `${description.summary} ${description.details.slice(0, 3).join(' ')}`;
    controller.setRate(rate);
    controller.speak(text);
    setLastAnnouncement('Narration started');
  };

  const speechSupported = useMemo(() => {
    // Feature-detect without retaining the engine until first use.
    return (
      typeof window !== 'undefined' &&
      window.speechSynthesis !== undefined &&
      window.SpeechSynthesisUtterance !== undefined
    );
  }, []);

  return (
    <aside
      className="a11y"
      data-testid="accessible-panel"
      aria-label="Accessible moment description"
    >
      <header className="a11y__head">
        <span className="mono a11y__title">ACCESSIBLE VIEW</span>
        <span className="mono a11y__clock">{formatMatchClockTenths(engine.playheadMs)}</span>
      </header>

      <section className="a11y__section" aria-labelledby="a11y-desc-title">
        <h3 id="a11y-desc-title" className="a11y__heading">
          Spatial description
        </h3>
        <div
          ref={descriptionRef}
          className="a11y__description"
          data-testid="spatial-description"
          aria-live="polite"
          aria-atomic="false"
        />
      </section>

      <section className="a11y__section" aria-labelledby="a11y-audio-title">
        <h3 id="a11y-audio-title" className="a11y__heading">
          Narration
        </h3>
        {speechSupported ? (
          <div className="a11y__audio" data-testid="audio-controls">
            <p className="a11y__fine">
              Device speech synthesis (browser-local; the Azure narration pipeline is not
              implemented yet).
            </p>
            <div className="a11y__audio-controls">
              <button type="button" className="a11y__btn" onClick={speakCurrent}>
                Speak current state
              </button>
              <button
                type="button"
                className="a11y__btn"
                onClick={() => {
                  speechRef.current?.repeat();
                }}
              >
                Repeat
              </button>
              <button
                type="button"
                className="a11y__btn"
                onClick={() => {
                  speechRef.current?.stop();
                  setLastAnnouncement('Narration stopped');
                }}
              >
                Stop
              </button>
              <label className="a11y__rate">
                <span className="visually-hidden">Narration rate</span>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.25}
                  value={rate}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setRate(next);
                    speechRef.current?.setRate(next);
                  }}
                  aria-valuetext={`${rate.toFixed(2)} times normal speed`}
                />
                <span className="mono a11y__rate-value">{rate.toFixed(2)}×</span>
              </label>
            </div>
            <p className="visually-hidden" role="status">
              {lastAnnouncement}
            </p>
          </div>
        ) : (
          <p className="a11y__fine" data-testid="audio-unavailable">
            Speech synthesis is not available in this browser — the written description and
            transcript below carry the complete experience. (Audio production belongs to a later
            pipeline.)
          </p>
        )}
      </section>

      <section className="a11y__section" aria-labelledby="a11y-transcript-title">
        <h3 id="a11y-transcript-title" className="a11y__heading">
          Transcript
        </h3>
        <ol className="a11y__transcript" data-testid="transcript">
          {transcript.map((entry) => (
            <li key={entry.id} className={`a11y__entry a11y__entry--${entry.kind}`}>
              <button
                type="button"
                className="a11y__entry-seek"
                onClick={() => onSeek(entry.atMs)}
                title={`Seek to ${formatMatchClockTenths(entry.atMs)}`}
              >
                <span className="mono a11y__entry-kind">{KIND_LABELS[entry.kind]}</span>
                <span className="a11y__entry-title">{entry.title}</span>
                {entry.kind === 'event' ? (
                  <span className="mono a11y__entry-id">{entry.id}</span>
                ) : null}
              </button>
              <p className="a11y__entry-desc">{entry.description}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="a11y__section a11y__section--transport" aria-label="Playback">
        <div className="a11y__transport">
          <button
            type="button"
            className="a11y__btn"
            onClick={() => onStep(-1)}
            title="Step back one source frame"
          >
            ◀ Frame
          </button>
          <button type="button" className="a11y__btn a11y__btn--primary" onClick={onTogglePlay}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            type="button"
            className="a11y__btn"
            onClick={() => onStep(1)}
            title="Step forward one source frame"
          >
            Frame ▶
          </button>
        </div>
        {view !== '2d' ? (
          <button type="button" className="a11y__btn a11y__btn--wide" onClick={onUse2D}>
            Switch to the 2D tactical view
          </button>
        ) : null}
      </section>
    </aside>
  );
}
