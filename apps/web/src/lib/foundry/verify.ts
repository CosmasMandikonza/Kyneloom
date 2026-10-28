/**
 * KYN-15 — deterministic verification + plan application. The model chooses
 * a bounded edit (base + focus + editorial caption); the deterministic layer
 * applies it to the REAL corpus proposal and runs the REAL compiler. Policy:
 * numbers only from tools, causation stays hypothesis, stale sources die.
 */

import { buildCompilerSource } from '@/lib/moment-compiler-service';
import {
  buildCompileCorpus,
  compileMomentProposal,
  type CompileResult,
} from '@kyneloom/moment-compiler';
import type { DirectorPlan, ProposedClaim, VerifierFinding } from './types';

const NUMBER_IN_EDITORIAL = /\d/;

/** Deterministic claim policy (docs/21): causal objectives refused outright,
 * numbers only when typed measured, evidence ids must exist. */
export function verifyClaims(
  claims: readonly ProposedClaim[],
  verifiedEvidenceIds: readonly string[],
  allowedEventIds: readonly string[],
): VerifierFinding[] {
  const findings: VerifierFinding[] = [];
  claims.forEach((claim, index) => {
    const path = `claims[${String(index)}]`;
    if (claim.uncertainty === 'measured' && NUMBER_IN_EDITORIAL.test(claim.text)) {
      // A "measured" number in MODEL text is untrusted — only tool output
      // carries numbers. Downgrade to a finding; the claim cannot stay
      // labelled measured with model-written digits.
      findings.push({
        fieldPath: `${path}.text`,
        code: 'unsupported_number',
        message: `claim ${String(index)} states a number as measured; numbers may only come from deterministic tool output`,
      });
    }
    if (
      /(caused|made it happen|directly led)/i.test(claim.text) &&
      claim.uncertainty !== 'hypothesis'
    ) {
      findings.push({
        fieldPath: `${path}.uncertainty`,
        code: 'overstated_causation',
        message: `claim ${String(index)} asserts causation; it must be labelled hypothesis`,
      });
    }
    for (const evidenceId of claim.evidenceIds) {
      if (!verifiedEvidenceIds.includes(evidenceId)) {
        findings.push({
          fieldPath: `${path}.evidenceIds`,
          code: 'unsupported_reference',
          message: `claim ${String(index)} cites "${evidenceId}" which is not a verified evidence id`,
        });
      }
    }
    void allowedEventIds;
  });
  return findings;
}

export interface AppliedPlan {
  readonly proposal: Parameters<typeof compileMomentProposal>[0];
  readonly focusPlayheadMs: number;
  readonly result: CompileResult;
  readonly findings: readonly VerifierFinding[];
}

/** Apply the director's bounded edit and compile through the REAL compiler. */
export async function applyAndCompile(
  plan: DirectorPlan,
  claimFindings: readonly VerifierFinding[],
): Promise<AppliedPlan | null> {
  const { loadGoldenMatch } = await import('@/lib/match-fixture');
  const golden = await loadGoldenMatch();
  const source = buildCompilerSource(golden);
  if (!source.ok) return null;
  const corpus = buildCompileCorpus(source.snapshot.context);
  const entry =
    plan.baseProposalId === 'broadcast-sweep'
      ? corpus.entries.find((candidate) => candidate.id === 'broadcast-sweep')
      : corpus.entries.find((candidate) => candidate.id === 'golden');
  if (entry === undefined) return null;
  const base = entry.proposal;

  // Bounded edit 1: focus event id — must be a REAL source event.
  const findings: VerifierFinding[] = [...claimFindings];
  let focusEventId = plan.focusEventId;
  if (focusEventId !== null) {
    const event = source.snapshot.context.events.find(
      (candidate) => candidate.eventId === focusEventId,
    );
    if (event === undefined) {
      findings.push({
        fieldPath: 'plan.focusEventId',
        code: 'unsupported_reference',
        message: `focus event "${focusEventId}" does not exist in the source events`,
      });
      focusEventId = null;
    }
  }

  // Bounded edit 2: the editorial caption on the hypothesis claim — number
  // free by the contract; the deterministic editor enforces it if violated.
  let proposal = base;
  const hypothesisIndex = base.claims.findIndex((claim) => claim.status === 'hypothesis');
  if (hypothesisIndex >= 0 && plan.captionText.trim().length > 0) {
    if (NUMBER_IN_EDITORIAL.test(plan.captionText)) {
      findings.push({
        fieldPath: 'plan.captionText',
        code: 'unsupported_number',
        message: 'editorial caption contains a number; captions are number-free by contract',
      });
    } else {
      const claims = [...base.claims];
      const original = claims[hypothesisIndex]!;
      claims[hypothesisIndex] = { ...original, text: plan.captionText };
      proposal = { ...base, claims };
    }
  }

  const result = compileMomentProposal(proposal, source.snapshot.context);
  if (!result.ok) {
    for (const error of result.errors) {
      findings.push({ fieldPath: error.fieldPath, code: error.code, message: error.message });
    }
  }
  const focusEvent =
    focusEventId !== null
      ? source.snapshot.context.events.find((candidate) => candidate.eventId === focusEventId)
      : undefined;
  return {
    proposal,
    // Build-up law (PR #49 review): playback starts at the window beginning.
    focusPlayheadMs: corpus.candidate.startMs,
    result,
    findings,
    ...(focusEvent !== undefined ? {} : {}),
  };
}

/** Stale-source check: basedOn must equal the CURRENT source identity. */
export function isStaleSource(
  basedOn: { reducerRevision: number; sourceHash: string },
  current: { reducerRevision: number; sourceHash: string },
): boolean {
  return (
    basedOn.reducerRevision !== current.reducerRevision || basedOn.sourceHash !== current.sourceHash
  );
}
