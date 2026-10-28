/**
 * KYN — "Ask Kyneloom": a BOUNDED DETERMINISTIC intent resolver over the
 * authoritative synthetic fixture. Clearly labeled as such — this is NOT
 * Microsoft Foundry (KYN-15) and never claims to be. The seam is deliberate:
 * `resolveAskIntent` (pure prompt classification) plus `resolveAskMoment`
 * (evidence grounding + compilation through the REAL deterministic compiler)
 * can be replaced by an orchestrated agent later without touching the input
 * UX or the compiler boundary.
 *
 * Laws inherited from the repo:
 * - Selection is by existing source IDs and source-event kinds, never by
 *   fabricated timestamps.
 * - Only interpretations the evidence supports: an off-ball run MAY be
 *   described as likely contributing to space — never as proven causation.
 * - Every supported answer is compiled by `compileMomentProposal` against
 *   the CURRENT source revision (a stale proposal dies at compile time).
 * - Never mints approval or publication permission.
 */

import type { CompileResult } from '@kyneloom/moment-compiler';

export const ASK_ROUTE_VERSION = 'kyneloom-ask-intent-v1';
export const ASK_RESOLVER_LABEL = 'Local deterministic interpretation · Synthetic match';

export type AskIntentId = 'off-ball-run' | 'goal-buildup' | 'broadcast-wide' | 'foundry-experience';

export const SUPPORTED_INTENTS: readonly { id: AskIntentId; example: string }[] = [
  { id: 'off-ball-run', example: 'Show me how the off-ball run opened space' },
  { id: 'goal-buildup', example: 'Show the build-up to the goal' },
  { id: 'broadcast-wide', example: 'Give me a wide broadcast view' },
];

export type IntentClassification =
  { readonly kind: 'supported'; readonly intentId: AskIntentId } | { readonly kind: 'unsupported' };

/** Prompt cap: a question, not a document. */
export const MAX_PROMPT_LENGTH = 280;

const INTENT_RULES: readonly { readonly id: AskIntentId; readonly pattern: RegExp }[] = [
  // Off-ball run / separation — checked before "goal" so "run ... space" wins
  // over incidental words, and before "wide" so a spatial question asked with
  // camera words still resolves to the evidence answer.
  {
    id: 'off-ball-run',
    pattern: /off[ -]?ball|decoy|separation|opened space|created space|run\b[^.?!]*\bspace/iu,
  },
  { id: 'goal-buildup', pattern: /goal|finish|build[ -]?up|scored|scorer|assist|shot/iu },
  {
    id: 'broadcast-wide',
    pattern: /wide|broadcast|overhead|sweep|aerial|camera (view|angle)|view|angle/iu,
  },
];

/** Pure prompt classification — deterministic, no fixture access. */
export function resolveAskIntent(prompt: string): IntentClassification {
  const text = prompt.trim();
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(text)) return { kind: 'supported', intentId: rule.id };
  }
  return { kind: 'unsupported' };
}

export type AskMomentOutcome =
  | {
      readonly ok: true;
      readonly routeVersion: typeof ASK_ROUTE_VERSION;
      readonly resolver: string;
      readonly intentId: AskIntentId;
      /** ONLY accepted source event ids (authoritative eventIds). */
      readonly sourceEventIds: readonly string[];
      /** Verified evidence entries cited (e.g. ev-separation). */
      readonly evidenceIds: readonly string[];
      /** Claims cited (calculated or hypothesis). */
      readonly claimIds: readonly string[];
      /** Grounded plain-language answer; measured facts vs interpretation kept distinct. */
      readonly explanation: string;
      /** Honest limits of the evidence behind this answer. */
      readonly evidenceNote: string;
      /** Absolute playhead ms the stage should focus on. */
      readonly focusPlayheadMs: number;
      readonly result: CompileResult;
    }
  | {
      readonly ok: false;
      readonly routeVersion: typeof ASK_ROUTE_VERSION;
      readonly resolver: string;
      readonly kind: 'unsupported';
      readonly message: string;
      readonly supportedExamples: readonly string[];
    };
