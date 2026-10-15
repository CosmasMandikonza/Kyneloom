import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectSceneCapabilities } from './capabilities';

describe('detectSceneCapabilities', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a server environment without touching browser APIs', () => {
    // Simulate server rendering: no window at all.
    const originalWindow = globalThis.window;
    vi.stubGlobal('window', undefined);
    expect(detectSceneCapabilities()).toEqual({
      environment: 'server',
      webgl: false,
      prefersReducedMotion: false,
      devicePixelRatio: 1,
    });
    vi.stubGlobal('window', originalWindow);
  });

  it('reports a browser with WebGL when context creation succeeds', () => {
    const canvasStub = {
      getContext: (type: string) => (type === 'webgl2' ? {} : null),
    };
    vi.stubGlobal('window', {
      devicePixelRatio: 2,
      matchMedia: () => ({ matches: true }),
      document: { createElement: () => canvasStub },
    });
    expect(detectSceneCapabilities()).toEqual({
      environment: 'browser',
      webgl: true,
      prefersReducedMotion: true,
      devicePixelRatio: 2,
    });
  });

  it('reports no WebGL when context creation returns null', () => {
    const canvasStub = { getContext: () => null };
    vi.stubGlobal('window', {
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false }),
      document: { createElement: () => canvasStub },
    });
    const capabilities = detectSceneCapabilities();
    expect(capabilities.environment).toBe('browser');
    expect(capabilities.webgl).toBe(false);
  });

  it('treats a throwing getContext as no WebGL rather than crashing', () => {
    const canvasStub = {
      getContext: () => {
        throw new Error('context blocked');
      },
    };
    vi.stubGlobal('window', {
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false }),
      document: { createElement: () => canvasStub },
    });
    expect(detectSceneCapabilities().webgl).toBe(false);
  });

  it('falls back to pixel ratio 1 and no reduced motion when APIs are missing', () => {
    const canvasStub = { getContext: () => null };
    vi.stubGlobal('window', {
      devicePixelRatio: 0,
      document: { createElement: () => canvasStub },
    });
    expect(detectSceneCapabilities()).toEqual({
      environment: 'browser',
      webgl: false,
      prefersReducedMotion: false,
      devicePixelRatio: 1,
    });
  });
});
