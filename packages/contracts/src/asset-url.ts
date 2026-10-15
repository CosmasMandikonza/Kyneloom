import { z } from 'zod';

/**
 * Asset-reference gate (ADR-0002 proof obligations: malicious URL rejection).
 *
 * Manifests are declarative: they reference assets by URL only where a field
 * explicitly allows it, and only over `https:` with a real hostname.
 * `javascript:`, `data:`, `file:` and every other scheme is rejected, as are
 * URLs carrying credentials or a non-empty fragment. No executable content
 * of any kind is representable in the contract schemas (strict unknown-key
 * rejection removes un modeled "script"/"command" fields).
 */
/** Structural view of the WHATWG URL constructor (Node and browsers). */
interface UrlLike {
  protocol: string;
  username: string;
  password: string;
  hash: string;
  hostname: string;
}
type UrlCtor = new (url: string) => UrlLike;

export const assetUrl = z.string().superRefine((value, ctx) => {
  const URLCtor = (globalThis as { URL?: UrlCtor }).URL;
  if (!URLCtor) {
    ctx.addIssue({ code: 'custom', message: 'URL validation unavailable in this runtime' });
    return;
  }
  let parsed: UrlLike;
  try {
    parsed = new URLCtor(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be an absolute URL' });
    return;
  }
  if (parsed.protocol !== 'https:') {
    ctx.addIssue({
      code: 'custom',
      message: `unsupported URL scheme ${JSON.stringify(parsed.protocol)}; only https: is allowed`,
    });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    ctx.addIssue({ code: 'custom', message: 'must not embed credentials' });
  }
  if (parsed.hash !== '') {
    ctx.addIssue({ code: 'custom', message: 'must not carry a fragment' });
  }
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
    ctx.addIssue({ code: 'custom', message: 'must reference a real host' });
  }
});

export type AssetUrl = z.infer<typeof assetUrl>;
