'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { formatMatchClock } from '@/lib/clock';
import type { MomentCatalogEntry } from '@/lib/moment-catalog';
import { exploreHrefFor } from '@/lib/moment-catalog';
import type { PreviewRecord } from './previews';
import { createTiltController } from './tilt';

/**
 * KYN-10 MomentCard — a chapter of the accepted sequence as a cinematic
 * portal. Pointer-relative tilt/spring depth is ADAPTED from React Bits
 * TiltedCard (pinned commit 310fc73; see tilt.ts for the full source/
 * license record): motion values + refs only, the rAF loop stops when the
 * springs settle, reduced motion renders a fully static card, and touch
 * devices never depend on hover — the whole card is one semantic Link.
 */

export interface MomentCardProps {
  readonly entry: MomentCatalogEntry;
  readonly preview: PreviewRecord | null;
}

/** One grounded fact line per card, from the catalog's computed facts. */
function factLine(entry: MomentCatalogEntry): string | null {
  const facts = entry.facts;
  if (facts.separationM !== undefined) {
    return `defender–striker gap ${facts.separationM.toFixed(3)} m`;
  }
  if (facts.runnerSpeedMps !== undefined) {
    return `home-11 at ${facts.runnerSpeedMps.toFixed(3)} m/s`;
  }
  if (facts.passDistanceM !== undefined) {
    return `pass ${facts.passDistanceM.toFixed(3)} m in ${facts.passDurationS?.toFixed(1) ?? '—'} s`;
  }
  if (facts.shotDistanceM !== undefined) {
    return `${facts.shotDistanceM.toFixed(3)} m to goal`;
  }
  if (facts.ballDistanceM !== undefined) {
    return `ball ${facts.ballDistanceM.m.toFixed(2)} m from ${facts.ballDistanceM.entityId}`;
  }
  if (facts.ballAt !== undefined && facts.scoreLine !== undefined) {
    return `ball ${facts.ballAt.xM.toFixed(1)}, ${facts.ballAt.yM.toFixed(1)} m · ${facts.scoreLine}`;
  }
  return null;
}

export function MomentCard({ entry, preview }: MomentCardProps) {
  const tiltRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = tiltRef.current;
    if (el === null) return;
    const link = el.closest('a');
    if (link === null) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const controller = createTiltController(el, undefined, reduced);

    let onMove: ((event: PointerEvent) => void) | null = null;
    if (finePointer && !reduced) {
      onMove = (event: PointerEvent): void => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        controller.pointer(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          ((event.clientY - rect.top) / rect.height) * 2 - 1,
        );
      };
      link.addEventListener('pointermove', onMove, { passive: true });
    }

    const onEnter = (): void => controller.setEngaged(true);
    const onLeave = (): void => {
      controller.setEngaged(false);
      controller.pointer(0, 0);
    };
    const onFocus = (): void => {
      if (link.matches(':focus-visible')) controller.setEngaged(true);
    };
    link.addEventListener('pointerenter', onEnter);
    link.addEventListener('pointerleave', onLeave);
    link.addEventListener('focus', onFocus);
    link.addEventListener('blur', onLeave);

    const observer = new IntersectionObserver(
      (entries) => {
        controller.setVisible(entries.some((item) => item.isIntersecting));
      },
      { rootMargin: '80px' },
    );
    observer.observe(el);

    return () => {
      observer.disconnect();
      controller.destroy();
      link.removeEventListener('pointerenter', onEnter);
      link.removeEventListener('pointerleave', onLeave);
      link.removeEventListener('focus', onFocus);
      link.removeEventListener('blur', onLeave);
      if (onMove !== null) link.removeEventListener('pointermove', onMove);
    };
  }, []);

  const clock = formatMatchClock(entry.focusMs);
  const fact = factLine(entry);

  return (
    <Link
      href={exploreHrefFor(entry)}
      className="mcard"
      data-catalog-id={entry.catalogId}
      data-focus-ms={entry.focusMs}
      data-preview={preview !== null ? 'rendered' : 'unavailable'}
      aria-label={`Chapter ${entry.chapter}: ${entry.title}, ${clock} — open the Living Replay at this moment`}
    >
      <div className="mcard__frame">
        <div className="mcard__tilt" ref={tiltRef}>
          <div className="mcard__media">
            {preview !== null ? (
              <img
                className="mcard__image"
                src={preview.src}
                alt={`Scene preview: the Living Replay paused at ${clock}, ${preview.camera} camera framing`}
                width={preview.width}
                height={preview.height}
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="mcard__image mcard__image--missing" aria-hidden="true">
                <span className="mono">PREVIEW NOT GENERATED</span>
              </div>
            )}
            <div className="mcard__scrim" aria-hidden="true" />
            <div className="mcard__glare" aria-hidden="true" />
            <span className="mcard__clock mono">{clock}</span>
            <span className="mcard__index mono" aria-hidden="true">
              {String(entry.chapter).padStart(2, '0')}
            </span>
            <div className="mcard__overlay">
              <span className="mcard__tag">{entry.tag}</span>
              <h3 className="mcard__title">{entry.title}</h3>
              <p className="mcard__hook">{entry.hook}</p>
              {fact !== null ? <span className="mcard__fact mono">{fact}</span> : null}
              <span className="mcard__enter" aria-hidden="true">
                Enter the scene ↗
              </span>
            </div>
          </div>
          <div className="mcard__meta mono">
            <span className="mcard__meta-id">{entry.eventId ?? 'open play'}</span>
            <span>
              {entry.playerFocusId !== null ? entry.playerFocusId : 'whole pitch'}
              {preview !== null ? ` · ${preview.camera} cam` : ''}
            </span>
            <span className="mcard__meta-src">synthetic</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
