/**
 * Canonical tenant asset scoping (KYN-16 review, final pass — blocker 2).
 *
 * String-prefix authorization (`url.startsWith(prefix)`) accepts traversal:
 * `https://host/tenants/demo-org/../other-org/x.svg` literally starts with
 * the demo-org prefix but resolves into another tenant's directory. This
 * module authorizes by PARSED, CANONICALIZED location instead:
 *
 * 1. parse with the standard WHATWG URL parser (rejects malformed input);
 * 2. require exactly `https:` — no other scheme;
 * 3. reject credentials and fragments outright;
 * 4. decode the pathname and reject ANY `..` segment (catches %2e%2e and
 *    mixed-case encodings that the parser keeps literal);
 * 5. require the origin to EQUAL a configured origin (no lookalike hosts);
 * 6. require every configured path SEGMENT to match exactly at a directory
 *    boundary (no `demo-org-evil` prefix tricks), with at least one further
 *    segment naming an actual asset.
 *
 * The contracts `assetUrl` gate stays the first line (https-only, no
 * credentials/fragments at schema level); this is the compiler-side tenant
 * authorization on top of it — deterministic and directly unit-testable.
 */

/** A canonicalized authorized asset directory. */
export interface AssetScope {
  readonly origin: string;
  /** Non-empty, decoded, exact path segments (no leading/trailing empties). */
  readonly segments: readonly string[];
}

function decodeSegments(pathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  return decoded.split('/').filter((segment) => segment.length > 0);
}

/** Canonicalize a configured prefix; null when it is not a usable https dir. */
export function parseAssetScope(prefix: string): AssetScope | null {
  let parsed: URL;
  try {
    parsed = new URL(prefix);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  const segments = decodeSegments(parsed.pathname);
  if (segments === null || segments.length === 0) return null;
  return { origin: parsed.origin, segments };
}

/**
 * Where the parsed URL canonically lives, or null when it must be rejected
 * before comparison (malformed, non-https, credentials, fragment, or any
 * dot-segment — encoded or not).
 */
export function canonicalAssetLocation(
  url: string,
): { readonly origin: string; readonly segments: readonly string[] } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.hash !== '') return null;
  const segments = decodeSegments(parsed.pathname);
  if (segments === null) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  if (segments.length === 0) return null;
  return { origin: parsed.origin, segments };
}

/** True only when the canonical resolved location is INSIDE one of the scopes. */
export function isAssetUrlWithinScopes(url: string, scopes: readonly AssetScope[]): boolean {
  const location = canonicalAssetLocation(url);
  if (location === null) return false;
  for (const scope of scopes) {
    if (location.origin !== scope.origin) continue;
    if (location.segments.length <= scope.segments.length) continue;
    let inside = true;
    for (let index = 0; index < scope.segments.length; index += 1) {
      if (location.segments[index] !== scope.segments[index]) {
        inside = false;
        break;
      }
    }
    if (inside) return true;
  }
  return false;
}

/** Describe a location for actionable error messages (no credentials exist at this point). */
export function describeAssetLocation(url: string): string {
  const location = canonicalAssetLocation(url);
  return location === null
    ? 'unparseable or unsafe URL'
    : `${location.origin}${location.segments.map((s) => `/${s}`).join('')}`;
}
