import { z } from 'zod';

/**
 * Canonical identifier grammar shared by every contract.
 *
 * Kebab-case ids (letters, digits, hyphens; must start alphanumeric) are used
 * for events, matches, providers, tenants, manifests and every referenced
 * entity inside a manifest. Stable entity ids additionally encode whether
 * they identify the ball or a player on a specific team.
 */

export const KEBAB_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const kebabId = z.string().regex(KEBAB_ID_PATTERN, {
  error: 'must be a lowercase kebab id like "synthetic-derby-01"',
});

export const nonEmptyId = z.string().min(1, { error: 'must not be empty' });

/** Ball or player identity. Ball is exactly "ball"; players are "home-XX"/"away-XX". */
export const ENTITY_ID_PATTERN = /^(?:ball|(?:home|away)-[a-z0-9]+)$/;

export const entityId = z.string().regex(ENTITY_ID_PATTERN, {
  error: 'must be "ball" or a player id like "home-08" / "away-04"',
});

export type EntityId = z.infer<typeof entityId>;

export function isBallEntity(id: EntityId): boolean {
  return id === 'ball';
}

/** Which side a player entity belongs to; the ball belongs to neither. */
export function entityTeam(id: EntityId): 'home' | 'away' | null {
  if (id.startsWith('home-')) return 'home';
  if (id.startsWith('away-')) return 'away';
  return null;
}

/** Team reference used by events and state. */
export const teamId = z.enum(['home', 'away']);

export type TeamId = z.infer<typeof teamId>;

/** Content hashes referenced by manifest inputs and approvals. */
export const SOURCE_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const sourceHash = z.string().regex(SOURCE_HASH_PATTERN, {
  error: 'must look like "sha256:" followed by 64 lowercase hex characters',
});

export type SourceHash = z.infer<typeof sourceHash>;

/** ISO-8601 UTC instant (wall-clock ingestion/audit times only — never match time). */
export const utcTimestamp = z.iso.datetime({ offset: false });

/** BCP-47-style language tag used by localized claims. */
export const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const languageTag = z.string().regex(LANGUAGE_TAG_PATTERN, {
  error: 'must be a language tag like "en" or "pt-BR"',
});
