import { describe, expect, it } from 'vitest';
import {
  canonicalAssetLocation,
  describeAssetLocation,
  isAssetUrlWithinScopes,
  parseAssetScope,
  type AssetScope,
} from './asset-scope';

/**
 * KYN-16 final review, blocker 2 — the tenant asset allowlist must authorize
 * by PARSED, CANONICALIZED location, never by raw string prefix. WHATWG URL
 * normalization resolves `../` (and its percent-encoded forms) BEFORE any
 * comparison happens, so a URL that literally starts with the tenant prefix
 * but resolves into another tenant's directory is refused. Every vector here
 * was verified against Node's WHATWG parser when the module was written.
 */

const PREFIX = 'https://assets.kyneloom.local/tenants/demo-org/';

function scopes(...prefixes: readonly string[]): readonly AssetScope[] {
  return prefixes.map((prefix) => {
    const scope = parseAssetScope(prefix);
    if (scope === null) throw new Error(`test bug: scope prefix ${prefix} did not parse`);
    return scope;
  });
}

describe('parseAssetScope — configured prefixes', () => {
  it('canonicalizes a tenant directory prefix', () => {
    const scope = parseAssetScope(PREFIX);
    expect(scope).toEqual({
      origin: 'https://assets.kyneloom.local',
      segments: ['tenants', 'demo-org'],
    });
  });

  it('rejects non-https, credentialed and root-less prefixes (fail closed)', () => {
    expect(parseAssetScope('http://assets.kyneloom.local/tenants/demo-org/')).toBeNull();
    expect(parseAssetScope('https://user:pass@assets.kyneloom.local/tenants/demo-org/')).toBeNull();
    expect(parseAssetScope('https://assets.kyneloom.local/')).toBeNull();
    expect(parseAssetScope('not a url')).toBeNull();
  });
});

describe('canonicalAssetLocation — resolution before comparison', () => {
  it('resolves dot segments the way the WHATWG parser does', () => {
    expect(
      canonicalAssetLocation('https://assets.kyneloom.local/tenants/demo-org/../other-org/s.svg'),
    ).toEqual({
      origin: 'https://assets.kyneloom.local',
      segments: ['tenants', 'other-org', 's.svg'],
    });
  });

  it('rejects non-https, credentials and fragments outright', () => {
    expect(
      canonicalAssetLocation('http://assets.kyneloom.local/tenants/demo-org/a.svg'),
    ).toBeNull();
    expect(
      canonicalAssetLocation('https://u:p@assets.kyneloom.local/tenants/demo-org/a.svg'),
    ).toBeNull();
    expect(
      canonicalAssetLocation('https://assets.kyneloom.local/tenants/demo-org/a.svg#frag'),
    ).toBeNull();
    expect(canonicalAssetLocation('://broken')).toBeNull();
  });

  it('a traversal that escapes the tenant dir entirely still parses — scope comparison refuses it', () => {
    // ../ resolves ABOVE the scope; the location itself is canonical
    // (/tenants/a.svg), so rejection happens in the scope comparison — the
    // same fail-closed outcome, one step later.
    const location = canonicalAssetLocation(
      'https://assets.kyneloom.local/tenants/demo-org/../a.svg',
    );
    expect(location).toEqual({
      origin: 'https://assets.kyneloom.local',
      segments: ['tenants', 'a.svg'],
    });
    expect(
      isAssetUrlWithinScopes(
        'https://assets.kyneloom.local/tenants/demo-org/../a.svg',
        scopes(PREFIX),
      ),
    ).toBe(false);
  });
});

describe('isAssetUrlWithinScopes — the review reproducer and friends', () => {
  it('accepts a permitted in-tenant asset (subdirectories included)', () => {
    const scope = scopes(PREFIX);
    expect(isAssetUrlWithinScopes(`${PREFIX}badges/measured.svg`, scope)).toBe(true);
    expect(isAssetUrlWithinScopes(`${PREFIX}deep/nested/arrow.svg`, scope)).toBe(true);
    // The https default port normalizes away — same canonical origin.
    expect(
      isAssetUrlWithinScopes('https://assets.kyneloom.local:443/tenants/demo-org/a.svg', scope),
    ).toBe(true);
  });

  it('rejects the ../ reproducer that literally starts with the prefix', () => {
    const scope = scopes(PREFIX);
    const crafted = 'https://assets.kyneloom.local/tenants/demo-org/../other-org/secret.svg';
    // The OLD check passed exactly this string test:
    expect(crafted.startsWith(PREFIX)).toBe(true);
    // The canonical check sees tenants/other-org and refuses:
    expect(isAssetUrlWithinScopes(crafted, scope)).toBe(false);
  });

  it('rejects percent-encoded dot segments in every casing the parser resolves', () => {
    const scope = scopes(PREFIX);
    for (const encoded of [
      'https://assets.kyneloom.local/tenants/demo-org/%2e%2e/other-org/secret.svg',
      'https://assets.kyneloom.local/tenants/demo-org/%2E%2E/other-org/secret.svg',
      'https://assets.kyneloom.local/tenants/demo-org/.%2e/other-org/secret.svg',
    ]) {
      expect(encoded.startsWith(PREFIX)).toBe(true);
      expect(isAssetUrlWithinScopes(encoded, scope)).toBe(false);
    }
  });

  it('rejects lookalike prefixes at a non-segment boundary', () => {
    const scope = scopes(PREFIX);
    const lookalike = 'https://assets.kyneloom.local/tenants/demo-org-evil/secret.svg';
    expect(lookalike.startsWith(PREFIX.slice(0, -1))).toBe(true); // 'demo-org' is a string prefix of 'demo-org-evil'
    expect(isAssetUrlWithinScopes(lookalike, scope)).toBe(false);
  });

  it('rejects host and userinfo variations', () => {
    const scope = scopes(PREFIX);
    expect(
      isAssetUrlWithinScopes('https://evil.kyneloom.local/tenants/demo-org/secret.svg', scope),
    ).toBe(false);
    expect(
      isAssetUrlWithinScopes(
        'https://user@assets.kyneloom.local/tenants/demo-org/secret.svg',
        scope,
      ),
    ).toBe(false);
    expect(
      isAssetUrlWithinScopes('https://assets.kyneloom.local/tenants/other-org/secret.svg', scope),
    ).toBe(false);
  });

  it('requires an actual asset segment below the scope directory', () => {
    const scope = scopes(PREFIX);
    expect(isAssetUrlWithinScopes('https://assets.kyneloom.local/tenants/demo-org', scope)).toBe(
      false,
    );
    expect(isAssetUrlWithinScopes('https://assets.kyneloom.local/tenants/demo-org/', scope)).toBe(
      false,
    );
  });

  it('authorizes against any one of several configured scopes', () => {
    const multi = scopes(PREFIX, 'https://cdn.kyneloom.local/tenants/demo-org/assets/');
    expect(isAssetUrlWithinScopes(`${PREFIX}a.svg`, multi)).toBe(true);
    expect(
      isAssetUrlWithinScopes('https://cdn.kyneloom.local/tenants/demo-org/assets/a.svg', multi),
    ).toBe(true);
    expect(
      isAssetUrlWithinScopes('https://cdn.kyneloom.local/tenants/other-org/a.svg', multi),
    ).toBe(false);
  });
});

describe('describeAssetLocation — actionable error text', () => {
  it('names the resolved directory and stays safe for unparseable input', () => {
    expect(
      describeAssetLocation('https://assets.kyneloom.local/tenants/demo-org/../other-org/s.svg'),
    ).toBe('https://assets.kyneloom.local/tenants/other-org/s.svg');
    expect(describeAssetLocation('://broken')).toBe('unparseable or unsafe URL');
  });
});
