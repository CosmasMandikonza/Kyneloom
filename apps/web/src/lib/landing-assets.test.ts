import { describe, expect, it } from 'vitest';
import { EXPLORE_ASSETS, warmExploreAssets, type FetchLike } from './landing-assets';

/**
 * KYN-09 review gate 3 — ASSETS_READY may only mean "genuinely received".
 * 404s, network failures and aborted loads must all return false.
 */

const okFetch: FetchLike = async () => new Response('', { status: 200 });
const notFoundFetch: FetchLike = async () => new Response('missing', { status: 404 });
const blockedFetch: FetchLike = async () => {
  throw new TypeError('Failed to fetch');
};

describe('warmExploreAssets (truthful readiness)', () => {
  it('returns true only when every asset responds ok', async () => {
    expect(await warmExploreAssets(['/a.glb'], okFetch)).toBe(true);
  });

  it('a 404 asset is NOT ready', async () => {
    expect(await warmExploreAssets(['/a.glb'], notFoundFetch)).toBe(false);
  });

  it('a network failure is NOT ready', async () => {
    expect(await warmExploreAssets(['/a.glb'], blockedFetch)).toBe(false);
  });

  it('one failed asset among many poisons readiness', async () => {
    const mixed: FetchLike = async (url) =>
      url === '/good.glb' ? new Response('', { status: 200 }) : new Response('', { status: 404 });
    expect(await warmExploreAssets(['/good.glb', '/bad.glb'], mixed)).toBe(false);
  });

  it('an aborted load is NOT ready (slow asset, controller fired)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const abortingFetch: FetchLike = async () => {
      throw abortError;
    };
    expect(await warmExploreAssets(['/slow.glb'], abortingFetch)).toBe(false);
  });

  it('never throws for arbitrary fetch failures', async () => {
    const weird: FetchLike = async () => {
      throw new Error('whatever');
    };
    await expect(warmExploreAssets(['/a.glb'], weird)).resolves.toBe(false);
  });

  it('the required asset list is the player rig', () => {
    expect(EXPLORE_ASSETS).toEqual(['/models/footballer.glb']);
  });
});
