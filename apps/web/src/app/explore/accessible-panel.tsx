'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatMatchClockTenths } from '@/lib/clock';
import { eventAtPlayhead } from '@/lib/playback';
import {
  describeSpatialState,
  transcriptEntries,
  type TranscriptEntry,
} from '@/lib/lens-selectors';
import type { EvidenceProjection } from '@/lib/evidence-data';
import type { SceneData } from '@/lib/scene-data';
import { createSpeechController, type SpeechController } from './speech';

/**
 * The Accessible panel (KYN-11 + KYN-20): a complete non-visual equivalent
 * of the moment, driven by the SAME authoritative timeline. Spatial
 * descriptions are GENERATED from the current sampled state (pure selector,
 * unit tested) — never hardcoded narration. The transcript lists every
 * source event with its id and actor plus the verified measurement and its
 * interpretation, each classified, with an HONEST unavailable entry when no
 * verified measurement exists. Browser speech synthesis (feature detected,
 * honestly labeled as the device engine) is optional and strictly opt-in:
 * the follow-narration mode speaks only meaningful source-event transitions
 * while playing, and deliberate seeks cancel stale narration.
 *
 * Updates run at a BOUNDED cadence (500 ms + engine revision), and the
 * live region announces only changes — assistive tech is never flooded
 * per animation frame. The active transcript entry follows the shared
 * playhead (aria-current) without stealing focus or scrolling.
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
  const [narrationStatus, setNarrationStatus] = useState('');
  /** Opt-in follow mode: narrate meaningful transitions while playing. */
  const [following, setFollowing] = useState(false);
  /** The transcript entry the shared playhead is currently at. */
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);

  // Live refs so the bounded sync interval never needs re-creating.
  const followingRef = useRef(false);
  const playingRef = useRef(playing);
  const rateRef = useRef(rate);
  useEffect(() => {
    followingRef.current = following;
  }, [following]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);

  /**
   * Concise live-announcement channel (review round): ONE short
   * role="status" line, throttled and deduplicated. Meaningful changes
   * only — source-event transitions during playback and deliberate
   * navigation (seek/step). The verbose spatial description is a readable,
   * NON-live region: screen readers are never flooded with the whole
   * paragraph twice a second.
   */
  const [announcement, setAnnouncement] = useState('');
  const [announcementCount, setAnnouncementCount] = useState(0);
  const lastAnnouncedRef = useRef('');
  const lastAnnouncedAtRef = useRef(0);
  /** Current source-event key the sync loop last saw (shared with seeks). */
  const lastEventKeyRef = useRef('');
  const announce = useCallback((text: string, options?: { force?: boolean }): void => {
    if (text === lastAnnouncedRef.current) return; // deduplicate
    // Deliberate navigation may force through the throttle; playback-drift
    // announcements never can.
    if (options?.force !== true && Date.now() - lastAnnouncedAtRef.current < 1200) return;
    lastAnnouncedRef.current = text;
    lastAnnouncedAtRef.current = Date.now();
    setAnnouncement(text);
    setAnnouncementCount((count) => count + 1);
  }, []);

  const transcript = useMemo(() => transcriptEntries(scene, evidence), [scene, evidence]);

  /** Narrate through the controller (single utterance; cancels in flight — never a queue). */
  const narrate = useCallback((text: string): void => {
    const controller = speechRef.current;
    if (controller === null || !controller.supported) return;
    controller.setRate(rateRef.current);
    controller.speak(text);
  }, []);

  // Bounded-cadence spatial description: recomputed from the sampled state
  // at most every 500 ms (and on transport revisions), written directly to
  // the DOM — no React re-render per frame. The container is deliberately
  // NOT a live region; announcements go through the throttled channel.
  useEffect(() => {
    let lastText = '';
    let firstSync = true;
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
      // Active transcript entry = the last entry at/before the playhead
      // (state written only on change; no scrolling, no focus stealing).
      let activeId: string | null = null;
      for (const entry of transcript) {
        if (entry.atMs <= t) activeId = entry.id;
        else break;
      }
      setActiveEntryId((current) => (current === activeId ? current : activeId));
      // Source-event transitions are the meaningful playback changes worth
      // announcing — concise, never the whole spatial paragraph.
      const active = eventAtPlayhead(t, scene.events);
      const key = active === null ? 'open' : `${active.phase}:${active.event.eventId}`;
      if (key !== lastEventKeyRef.current && !firstSync) {
        lastEventKeyRef.current = key;
        const line =
          active === null
            ? `Open play at ${formatMatchClockTenths(t)}`
            : active.phase === 'active'
              ? `${active.event.label} by ${active.event.actorId} at ${formatMatchClockTenths(t)}`
              : `Next: ${active.event.label} by ${active.event.actorId}`;
        announce(line);
        // Follow narration speaks the SAME concise line — only while
        // following AND playing; a single utterance that cancels any in
        // flight, so the queue can never grow or overlap.
        if (followingRef.current && playingRef.current) narrate(line);
      } else if (firstSync) {
        lastEventKeyRef.current = key;
      }
    };
    sync();
    firstSync = false;
    const interval = window.setInterval(sync, 500);
    return () => window.clearInterval(interval);
  }, [announce, engine, getFrame, scene, selectedEntityId, transcript, narrate]);

  // Optional browser speech synthesis — created on demand, destroyed on
  // unmount/lens exit so no voice outlives the panel. Exiting the panel
  // also ends follow mode (the state dies with the component).
  useEffect(() => {
    return () => {
      speechRef.current?.destroy();
      speechRef.current = null;
    };
  }, []);

  const ensureController = (): SpeechController | null => {
    if (speechRef.current === null) {
      speechRef.current = createSpeechController(window);
    }
    return speechRef.current;
  };

  const speakCurrent = (): void => {
    const controller = ensureController();
    if (controller === null || !controller.supported) return;
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
    setNarrationStatus('Narration started');
  };

  /** Deliberate transcript seek: cancel stale narration, then (if following) speak the destination. */
  const seekToEntry = (entry: TranscriptEntry): void => {
    speechRef.current?.stop();
    onSeek(entry.atMs);
    const active = eventAtPlayhead(entry.atMs, scene.events);
    lastEventKeyRef.current = active === null ? 'open' : `${active.phase}:${active.event.eventId}`;
    const line = `Jumped to ${formatMatchClockTenths(entry.atMs)} — ${entry.title.split(' · ')[0]}`;
    announce(line, { force: true });
    if (followingRef.current) narrate(line);
  };

  const toggleFollowing = (): void => {
    const controller = ensureController();
    if (!following) {
      // Explicit user start (never autoplay): narrate the current concise
      // state once; transitions take over from here while playing.
      if (controller !== null && controller.supported) {
        const t = engine.playheadMs;
        const active = eventAtPlayhead(t, scene.events);
        narrate(
          `Following narration. ${
            active === null
              ? `Open play at ${formatMatchClockTenths(t)}`
              : `${active.event.label} by ${active.event.actorId} at ${formatMatchClockTenths(t)}`
          }`,
        );
        setNarrationStatus('Following narration');
      }
      setFollowing(true);
    } else {
      controller?.stop();
      setFollowing(false);
      setNarrationStatus('Narration stopped');
    }
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
        {/* Readable, continuously updated — deliberately NOT a live region:
            screen readers browse it on demand while the concise channel
            below carries meaningful announcements. */}
        <div
          ref={descriptionRef}
          className="a11y__description"
          data-testid="spatial-description"
          role="region"
          aria-labelledby="a11y-desc-title"
        />
        <p
          className="visually-hidden"
          role="status"
          data-testid="live-announcement"
          data-count={announcementCount}
        >
          {announcement}
        </p>
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
              <button
                type="button"
                className="a11y__btn"
                aria-pressed={following}
                data-testid="follow-narration"
                onClick={toggleFollowing}
                title="Narrate source-event transitions while playing"
              >
                {following ? 'Following — stop' : 'Follow narration'}
              </button>
              <button type="button" className="a11y__btn" onClick={speakCurrent}>
                Speak current state
              </button>
              <button
                type="button"
                className="a11y__btn"
                onClick={() => {
                  speechRef.current?.pause();
                  setNarrationStatus('Narration paused');
                }}
              >
                Pause
              </button>
              <button
                type="button"
                className="a11y__btn"
                onClick={() => {
                  speechRef.current?.resume();
                  setNarrationStatus('Narration resumed');
                }}
              >
                Resume
              </button>
              <button
                type="button"
                className="a11y__btn"
                onClick={() => {
                  speechRef.current?.stop();
                  setNarrationStatus('Narration stopped');
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
              {narrationStatus}
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
          {transcript.map((entry) => {
            const isActive = entry.id === activeEntryId;
            return (
              <li
                key={entry.id}
                className={`a11y__entry a11y__entry--${entry.kind}${isActive ? ' a11y__entry--active' : ''}`}
                data-active={isActive ? 'true' : undefined}
              >
                <button
                  type="button"
                  className="a11y__entry-seek"
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => seekToEntry(entry)}
                  title={`Seek to ${formatMatchClockTenths(entry.atMs)}`}
                >
                  <span className="mono a11y__entry-kind">{KIND_LABELS[entry.kind]}</span>
                  <span className="a11y__entry-title">{entry.title}</span>
                  {/* Provenance id for EVERY entry kind: events cite their
                      source id; the measurement cites its input fingerprint
                      (or its honest unavailable marker); interpretation
                      cites its fixed selector identity. */}
                  <span className="mono a11y__entry-id">{entry.id}</span>
                </button>
                <p className="a11y__entry-desc">{entry.description}</p>
              </li>
            );
          })}
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
