'use client';

import { useEffect, useMemo } from 'react';
import { formatMatchClock } from '@/lib/clock';
import type { GoldenStoryFacts } from '@/lib/match-fixture';
import type { MomentCatalogEntry } from '@/lib/moment-catalog';
import { FeaturedMoment } from './featured-moment';
import { MomentCard } from './moment-card';
import { tiltRegistry } from './tilt';
import type { MotionRecord, PreviewRecord } from './previews';

/**
 * KYN-10 MomentGallery — the discovery surface. One honest collection: every
 * card is a real chapter of the single accepted synthetic sequence, every
 * preview is a real render of the actual scene, and every activation opens
 * the existing Living Replay at that chapter's validated timestamp.
 */

export interface MomentGalleryProps {
  readonly featured: MomentCatalogEntry;
  readonly chapters: readonly MomentCatalogEntry[];
  readonly featuredPreview: PreviewRecord | null;
  readonly chapterPreviews: readonly (PreviewRecord | null)[];
  readonly motion: MotionRecord | null;
  readonly matchId: string;
  readonly seed: number | null;
  readonly generatorVersion: string | null;
  readonly windowMs: readonly [number, number];
  readonly story: GoldenStoryFacts | null;
  readonly previewMethod: string | null;
}

/** Clearly-labeled QA hook (not user-facing) for Playwright assertions. */
function registerGalleryProbe(props: MomentGalleryProps): void {
  useEffect(() => {
    const hook = window as unknown as Record<string, unknown>;
    const previewsById = new Map(
      props.chapters.map((chapter, index) => [
        chapter.catalogId,
        props.chapterPreviews[index] ?? null,
      ]),
    );
    hook['__kyneloomMoments'] = {
      count: (): number => props.chapters.length,
      ids: (): string[] => props.chapters.map((chapter) => chapter.catalogId),
      focusMs: (): number[] => props.chapters.map((chapter) => chapter.focusMs),
      previewStatuses: (): Record<string, string> =>
        Object.fromEntries(
          props.chapters.map((chapter) => [
            chapter.catalogId,
            (previewsById.get(chapter.catalogId) ?? null) !== null ? 'rendered' : 'unavailable',
          ]),
        ),
      motionActive: (): boolean => {
        const video = document.querySelector<HTMLVideoElement>('.featured__video');
        return video !== null && !video.paused && !video.ended;
      },
      activeTiltLoops: (): number => tiltRegistry.activeLoops(),
      reducedMotion: (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
    return () => {
      delete hook['__kyneloomMoments'];
    };
  }, [props]);
}

export function MomentGallery(props: MomentGalleryProps) {
  registerGalleryProbe(props);

  const spine = useMemo(() => {
    const [start, end] = props.windowMs;
    const span = Math.max(1, end - start);
    // True position on the rail, then a monotone min-gap relaxation so
    // close beats (78:47.0 / 78:47.8) never collide on narrow rails.
    const MIN_GAP = 7.5; // rail percent
    const raw = props.chapters.map((chapter) => ({
      chapter,
      left: ((chapter.focusMs - start) / span) * 100,
      hasEvent: chapter.eventId !== null,
    }));
    let previous = -Infinity;
    for (const node of raw) {
      node.left = Math.max(node.left, previous + MIN_GAP);
      previous = node.left;
    }
    // If the relaxation pushed past the rail end, compress from the right.
    const overshoot = previous - 100;
    if (overshoot > 0) {
      let next = 100;
      for (let index = raw.length - 1; index >= 0; index -= 1) {
        raw[index]!.left = Math.min(raw[index]!.left, next);
        next = raw[index]!.left - MIN_GAP;
      }
    }
    return raw;
  }, [props.chapters, props.windowMs]);

  if (props.chapters.length === 0) {
    return null; // the server page renders the honest empty state itself
  }

  return (
    <>
      <FeaturedMoment
        entry={props.featured}
        preview={props.featuredPreview}
        motion={props.motion}
        story={props.story}
        seed={props.seed}
      />

      <section
        className="moments__collection container"
        id="chapters"
        aria-labelledby="chapters-title"
      >
        <div className="moments__collection-head">
          <h2 id="chapters-title" className="moments__collection-title">
            Twelve chapters, one measured sequence
          </h2>
          <p className="moments__collection-note">
            Each chapter is a validated timestamp of <span className="mono">{props.matchId}</span> (
            {formatMatchClock(props.windowMs[0])}–{formatMatchClock(props.windowMs[1])}) — not
            separate matches or published releases. Cards open the real 3D Living Replay at their
            own playhead.
          </p>
        </div>

        {/* Timeline spine: where each chapter sits in the window, with the
            real event beats marked. Nodes are real controls that locate the
            chapter card. */}
        <div className="moments__spine" role="group" aria-label="Chapter positions in the sequence">
          <span className="moments__spine-rail" aria-hidden="true" />
          {spine.map(({ chapter, left, hasEvent }) => (
            <button
              key={chapter.catalogId}
              type="button"
              className={`moments__spine-node mono${hasEvent ? ' moments__spine-node--event' : ''}`}
              style={{ left: `${left.toFixed(3)}%` }}
              title={`Chapter ${chapter.chapter} — ${chapter.title} · ${formatMatchClock(chapter.focusMs)}${chapter.eventId !== null ? ` · ${chapter.eventId}` : ''}`}
              aria-label={`Locate chapter ${chapter.chapter}: ${chapter.title}, ${formatMatchClock(chapter.focusMs)}`}
              onClick={(event) => {
                const card = event.currentTarget
                  .closest('.moments__collection')
                  ?.querySelector<HTMLElement>(`[data-catalog-id="${chapter.catalogId}"]`);
                card?.scrollIntoView({ block: 'center' });
                card?.focus({ preventScroll: true });
              }}
            >
              {hasEvent ? '◆' : String(chapter.chapter).padStart(2, '0')}
            </button>
          ))}
        </div>

        <ol className="moments__grid">
          {props.chapters.map((chapter, index) => (
            <li
              key={chapter.catalogId}
              className="moments__grid-item"
              style={{ '--card-index': index } as React.CSSProperties}
            >
              <MomentCard entry={chapter} preview={props.chapterPreviews[index] ?? null} />
            </li>
          ))}
        </ol>

        <p className="moments__provenance">
          Previews are real renders of the Living Replay, paused at each chapter’s validated
          timestamp with a deliberate camera · synthetic ground truth
          {props.seed !== null ? `, seed ${props.seed}` : ''}
          {props.generatorVersion !== null ? `, ${props.generatorVersion}` : ''} · no published
          release exists yet.
        </p>
      </section>
    </>
  );
}
