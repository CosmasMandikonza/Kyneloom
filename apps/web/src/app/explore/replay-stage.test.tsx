// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplayStage } from './replay-stage';

/**
 * KYN-05 — interaction contract of the Living Replay stage shell.
 *
 * Everything enabled must really work (lens selection, playhead scrubbing by
 * pointer AND keyboard), everything that needs the KYN-06 renderer must be
 * visibly disabled, and the canvas region the renderer mounts into must exist.
 */

function renderStage() {
  return render(
    <ReplayStage
      windowStartLabel="78:37"
      windowEndLabel="78:51"
      checkpointLabel="78:42"
      windowSpanMs={14_000}
    />,
  );
}

afterEach(() => {
  cleanup();
});

function slider(): HTMLElement {
  return screen.getByRole('slider', { name: 'Moment playhead' });
}

describe('ReplayStage stage shell', () => {
  it('renders the canvas mount region the KYN-06 renderer expects', () => {
    renderStage();
    const mount = document.querySelector('[data-scene-mount]');
    expect(mount).not.toBeNull();
    expect(screen.getByText('Living Replay')).toBeTruthy();
  });

  it('marks the scene as not implemented — never fakes a 3D scene', () => {
    renderStage();
    expect(screen.getByText('Not implemented')).toBeTruthy();
    expect(screen.getByText(/SCENE PENDING/i)).toBeTruthy();
  });
});

describe('ReplayStage truthfully disabled controls', () => {
  it('disables every camera mode until the renderer exists', () => {
    renderStage();
    const radios = screen
      .getAllByRole('radio')
      .filter((radio) =>
        ['Broadcast', 'Overhead', 'Follow player', 'Free orbit'].includes(radio.textContent ?? ''),
      );
    expect(radios).toHaveLength(4);
    for (const radio of radios) {
      expect((radio as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('disables playback until the renderer timeline sampler exists', () => {
    renderStage();
    const play = screen.getByRole('button', { name: 'Play' }) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
  });
});

describe('ReplayStage lens selection (real state)', () => {
  it('starts on Fan and moves the checked state on click', () => {
    renderStage();
    const fan = screen.getByRole('radio', { name: 'Fan' });
    const analyst = screen.getByRole('radio', { name: 'Analyst' });
    expect(fan.getAttribute('aria-checked')).toBe('true');
    expect(analyst.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(analyst);
    expect(analyst.getAttribute('aria-checked')).toBe('true');
    expect(fan.getAttribute('aria-checked')).toBe('false');
  });

  it('exposes labelled radiogroups for camera and lens', () => {
    renderStage();
    expect(screen.getByRole('radiogroup', { name: 'Camera' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Lens' })).toBeTruthy();
  });
});

describe('ReplayStage playhead (fraction of the moment window)', () => {
  it('exposes a slider over 0–100 with a percent value text', () => {
    renderStage();
    const rail = slider();
    expect(rail.getAttribute('aria-valuemin')).toBe('0');
    expect(rail.getAttribute('aria-valuemax')).toBe('100');
    expect(rail.getAttribute('aria-valuenow')).toBe('0');
    expect(rail.getAttribute('aria-valuetext')).toContain('0 percent');
  });

  it('scrubs by pointer position across the rail', () => {
    renderStage();
    const rail = slider();
    vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 44,
      width: 400,
      height: 44,
      toJSON: () => ({}),
    } as DOMRect);

    // jsdom's PointerEvent drops coordinate init data, so the pointer event is
    // dispatched as a coordinate-carrying MouseEvent of type pointerdown.
    // Real-browser pointer behavior is verified by the Playwright QA run.
    const pointerAt = (clientX: number) =>
      act(() => {
        rail.dispatchEvent(new MouseEvent('pointerdown', { clientX, bubbles: true }));
      });

    pointerAt(300);
    expect(rail.getAttribute('aria-valuenow')).toBe('75');
    expect(rail.getAttribute('aria-valuetext')).toContain('75 percent');

    pointerAt(40);
    expect(rail.getAttribute('aria-valuenow')).toBe('10');
  });

  it('moves by keyboard: arrows step 2, shift+arrow steps 10, Home/End clamp', () => {
    renderStage();
    const rail = slider();

    fireEvent.keyDown(rail, { key: 'ArrowRight' });
    expect(rail.getAttribute('aria-valuenow')).toBe('2');

    fireEvent.keyDown(rail, { key: 'ArrowRight', shiftKey: true });
    expect(rail.getAttribute('aria-valuenow')).toBe('12');

    fireEvent.keyDown(rail, { key: 'ArrowUp', shiftKey: true });
    expect(rail.getAttribute('aria-valuenow')).toBe('22');

    fireEvent.keyDown(rail, { key: 'ArrowLeft' });
    expect(rail.getAttribute('aria-valuenow')).toBe('20');

    fireEvent.keyDown(rail, { key: 'End' });
    expect(rail.getAttribute('aria-valuenow')).toBe('100');

    fireEvent.keyDown(rail, { key: 'ArrowRight' });
    expect(rail.getAttribute('aria-valuenow')).toBe('100');

    fireEvent.keyDown(rail, { key: 'Home' });
    expect(rail.getAttribute('aria-valuenow')).toBe('0');

    fireEvent.keyDown(rail, { key: 'ArrowLeft' });
    expect(rail.getAttribute('aria-valuenow')).toBe('0');
  });

  it('renders the golden window labels the reducer supplied', () => {
    renderStage();
    expect(screen.getByText('78:37')).toBeTruthy();
    expect(screen.getByText('78:51')).toBeTruthy();
    expect(screen.getByText('14s window')).toBeTruthy();
  });
});
