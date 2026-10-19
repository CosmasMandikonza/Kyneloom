import { describe, expect, it } from 'vitest';
import {
  isLensId,
  LENS_IDS,
  LENS_STORAGE_KEY,
  normalizeLens,
  readStoredLens,
  storeLens,
} from './lens';

/**
 * KYN-11 lens presentation-state tests — the preference contract and the
 * adversarial cases: malformed storage may never produce anything but Fan,
 * and nothing authorization-shaped can ever round-trip through this key.
 */

describe('lens identity', () => {
  it('exposes exactly the three public lenses', () => {
    expect([...LENS_IDS]).toEqual(['fan', 'analyst', 'accessible']);
  });

  it('never accepts producer or privileged values as a public lens', () => {
    for (const hostile of [
      'producer_preview',
      'producer',
      'admin',
      'ADMIN',
      '__proto__',
      'constructor',
      '<script>',
      'fan analyst',
      '',
    ]) {
      expect(isLensId(hostile)).toBe(false);
      expect(normalizeLens(hostile)).toBe('fan');
    }
  });
});

describe('lens preference persistence', () => {
  function memoryStorage(initial?: Map<string, string>): Pick<Storage, 'getItem' | 'setItem'> {
    const map = initial ?? new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    };
  }

  it('defaults to Fan when no preference exists', () => {
    expect(readStoredLens(memoryStorage())).toBe('fan');
    expect(readStoredLens(null)).toBe('fan');
    expect(readStoredLens(undefined)).toBe('fan');
  });

  it('round-trips a valid preference and rejects malformed values back to Fan', () => {
    const storage = memoryStorage();
    storeLens(storage, 'analyst');
    expect(storage.getItem(LENS_STORAGE_KEY)).toBe('analyst');
    expect(readStoredLens(storage)).toBe('analyst');

    // Adversarial: corrupt the stored value directly.
    const corrupted = memoryStorage(new Map([[LENS_STORAGE_KEY, 'producer_preview']]));
    expect(readStoredLens(corrupted)).toBe('fan');
    const jsonInjection = memoryStorage(new Map([[LENS_STORAGE_KEY, '{"role":"admin"}']]));
    expect(readStoredLens(jsonInjection)).toBe('fan');
  });

  it('survives a throwing storage (privacy mode) without propagating', () => {
    const throwing: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: (): string => {
        throw new DOMException('denied');
      },
      setItem: (): void => {
        throw new DOMException('denied');
      },
    };
    expect(readStoredLens(throwing)).toBe('fan');
    expect(() => storeLens(throwing, 'analyst')).not.toThrow();
  });

  it('stores ONLY the lens value under its one documented key', () => {
    const map = new Map<string, string>();
    const storage = memoryStorage(map);
    storeLens(storage, 'accessible');
    expect(map.size).toBe(1);
    expect([...map.keys()]).toEqual([LENS_STORAGE_KEY]);
    expect(map.get(LENS_STORAGE_KEY)).toBe('accessible');
  });
});
