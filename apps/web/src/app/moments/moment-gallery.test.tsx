// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildMomentCatalog, exploreHrefFor } from '@/lib/moment-catalog';
import { MomentGallery } from './moment-gallery';
import type { GoldenStoryFacts } from '@/lib/match-fixture';

/**
 * KYN-10 gallery mount tests (jsdom). The deep browser acceptance matrix
 * lives in scripts/visual-qa.ts; these prove the rendered contract at the
 * component level — semantic links, honest preview states, featured entry —
 * on the REAL catalog built from the committed fixture.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    return {
      matches: false,
      media: query,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
      addListener: (): void => undefined,
      removeListener: (): void => undefined,
      dispatchEvent: (): boolean => false,
      onchange: null,
    } as unknown as MediaQueryList;
  });
  // jsdom has no IntersectionObserver; the cards only use it as a visibility
  // gate (default-visible is the honest superset for these mount tests).
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

async function galleryProps(overrides: { previews?: 'none' | 'first-only' } = {}) {
  const golden = await loadGoldenMatch();
  if (!golden.ok) throw new Error('fixture unavailable');
  const catalog = buildMomentCatalog(golden);
  if (catalog === null) throw new Error('catalog null');
  const previewFor = (id: string) =>
    overrides.previews === 'first-only' && id !== catalog.chapters[0]!.catalogId
      ? null
      : {
          catalogId: id,
          src: `/moment-previews/${id}.png`,
          focusMs: 4_722_100,
          camera: 'broadcast',
          width: 1280,
          height: 704,
        };
  return {
    props: {
      featured: catalog.featured,
      chapters: catalog.chapters,
      featuredPreview: previewFor(catalog.featured.catalogId),
      chapterPreviews: catalog.chapters.map((chapter) => previewFor(chapter.catalogId)),
      motion: null,
      matchId: catalog.matchId,
      seed: golden.data.seed,
      generatorVersion: golden.data.generatorVersion,
      windowMs: catalog.windowMs,
      story: catalog.story as GoldenStoryFacts | null,
      separationMetric: catalog.separation,
      previewMethod: 'test-method',
    } as const,
    catalog,
  };
}

describe('MomentGallery (KYN-10)', () => {
  it('renders the featured moment and twelve semantic chapter links with distinct hrefs', async () => {
    const { props } = await galleryProps();
    render(<MomentGallery {...props} />);

    const featured = screen.getByRole('link', { name: /Enter the scene/i });
    expect(featured.getAttribute('href')).toBe(exploreHrefFor(props.featured));

    const cards = screen.getAllByRole('link', { name: /Chapter \d+:/i });
    expect(cards).toHaveLength(12);
    const hrefs = cards.map((card) => card.getAttribute('href'));
    expect(new Set(hrefs).size).toBe(12);
    for (const chapter of props.chapters) {
      expect(hrefs).toContain(exploreHrefFor(chapter));
    }
    // Chapter numbering runs 01–12 in order.
    for (let index = 0; index < 12; index += 1) {
      expect(cards[index]!.getAttribute('aria-label')).toContain(`Chapter ${index + 1}:`);
    }
  });

  it('labels source quality and event/open-play provenance on every card', async () => {
    const { props, catalog } = await galleryProps();
    render(<MomentGallery {...props} />);
    const eventChapters = catalog.chapters.filter((chapter) => chapter.eventId !== null);
    for (const chapter of eventChapters) {
      const card = screen
        .getAllByRole('link', { name: new RegExp(chapter.title, 'i') })
        .find((element) => element.getAttribute('data-catalog-id') === chapter.catalogId);
      expect(card).not.toBeUndefined();
      expect(within(card as HTMLElement).getByText(chapter.eventId as string)).toBeTruthy();
    }
    const syntheticLabels = screen.getAllByText('synthetic', { exact: false });
    expect(syntheticLabels.length).toBeGreaterThanOrEqual(12);
  });

  it('renders the honest unavailable state when a preview is missing (card still navigates)', async () => {
    const { props } = await galleryProps({ previews: 'first-only' });
    render(<MomentGallery {...props} />);
    const missing = document.querySelectorAll('.mcard[data-preview="unavailable"]');
    const rendered = document.querySelectorAll('.mcard[data-preview="rendered"]');
    expect(missing.length).toBe(11);
    expect(rendered.length).toBe(1);
    // Every missing card still shows the honest label AND a working link.
    for (const card of Array.from(missing)) {
      expect(card.querySelector('.mcard__image--missing')).not.toBeNull();
      expect(card.querySelector('.mcard__image--missing')?.textContent).toContain(
        'PREVIEW NOT GENERATED',
      );
      expect(card.getAttribute('href')).toMatch(/^\/explore\?moment=ia-\d+-/);
    }
  });

  it('carries per-card match-clock badges matching each chapter timestamp', async () => {
    const { props } = await galleryProps();
    render(<MomentGallery {...props} />);
    const clocks = Array.from(document.querySelectorAll('.mcard__clock')).map(
      (element) => element.textContent,
    );
    const expected = [
      '78:37',
      '78:41',
      '78:42',
      '78:43',
      '78:44',
      '78:45',
      '78:46',
      '78:47',
      '78:47',
      '78:48',
      '78:49',
      '78:51',
    ];
    expect(clocks).toEqual(expected);
  });
});
