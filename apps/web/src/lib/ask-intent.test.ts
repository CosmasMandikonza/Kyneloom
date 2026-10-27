import { describe, expect, it } from 'vitest';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildCompilerSource } from '@/lib/moment-compiler-service';
import { buildCompileCorpus, compileMomentProposal } from '@kyneloom/moment-compiler';
import {
  ASK_RESOLVER_LABEL,
  MAX_PROMPT_LENGTH,
  resolveAskIntent,
  resolveAskMoment,
  SUPPORTED_INTENTS,
} from './ask-intent';

/**
 * KYN "Ask Kyneloom" — the bounded deterministic intent resolver against the
 * REAL fixture and REAL compiler. Proves: classification determinism, goal
 * answers cite actual fixture event ids, off-ball answers keep hypotheses as
 * hypotheses, unsupported input is refused (never silently substituted), and
 * stale source references cannot produce verified artifacts.
 */

describe('resolveAskIntent — pure deterministic classification', () => {
  it('classifies the three supported families and refuses everything else', () => {
    expect(resolveAskIntent('Show me how the off-ball run opened space')).toEqual({
      kind: 'supported',
      intentId: 'off-ball-run',
    });
    expect(resolveAskIntent('Show the build-up to the goal')).toEqual({
      kind: 'supported',
      intentId: 'goal-buildup',
    });
    expect(resolveAskIntent('Give me a wide broadcast view')).toEqual({
      kind: 'supported',
      intentId: 'broadcast-wide',
    });
    expect(resolveAskIntent('Who is the manager of Manchester United?').kind).toBe('unsupported');
    expect(resolveAskIntent('   ').kind).toBe('unsupported');
  });

  it('is deterministic: identical input yields identical output', () => {
    const prompt = 'Show me how the off-ball run opened space';
    expect(resolveAskIntent(prompt)).toEqual(resolveAskIntent(prompt));
  });

  it('SUPPORTED_INTENTS examples all resolve to their own intent', () => {
    for (const intent of SUPPORTED_INTENTS) {
      expect(resolveAskIntent(intent.example)).toEqual({ kind: 'supported', intentId: intent.id });
    }
    expect(MAX_PROMPT_LENGTH).toBe(280);
  });
});

describe('resolveAskMoment — grounding + compilation against the real fixture', () => {
  it('a goal request cites an ACTUAL fixture event id and its real timestamp', async () => {
    const outcome = await resolveAskMoment('Show the build-up to the goal');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.intentId).toBe('goal-buildup');
    expect(outcome.sourceEventIds.length).toBe(1);
    const eventId = outcome.sourceEventIds[0]!;
    // The cited id exists in the authoritative source events and IS a goal.
    const golden = await loadGoldenMatch();
    const source = buildCompilerSource(golden);
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const event = source.snapshot.context.events.find((candidate) => candidate.eventId === eventId);
    expect(event).toBeDefined();
    expect(event?.kind).toBe('goal');
    // The BUILD-UP plays: focus is the candidate window START, never the
    // goal instant itself (which would skip what was asked for).
    const goldenB = await loadGoldenMatch();
    const sourceB = buildCompilerSource(goldenB);
    if (!sourceB.ok) return;
    const corpusB = buildCompileCorpus(sourceB.snapshot.context);
    expect(outcome.focusPlayheadMs).toBe(corpusB.golden.timeRangeMs[0]);
    expect(outcome.focusPlayheadMs).toBeLessThan(event!.occurredAtMs);
    // Provenance typing: the goal event id is a REAL source event id, and no
    // evidence/claim id leaks into the source-event field.
    expect(outcome.sourceEventIds).toEqual([eventId]);
    expect(outcome.evidenceIds).toEqual([]);
    expect(outcome.claimIds).toEqual([]);
    expect(outcome.result.ok).toBe(true);
  });

  it('an off-ball request uses verified evidence and never upgrades the hypothesis to proven causation', async () => {
    const outcome = await resolveAskMoment('Show me how the off-ball run opened space');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.intentId).toBe('off-ball-run');
    // Typed provenance: ev-separation is EVIDENCE, the reading is a CLAIM —
    // neither may appear as a source event id.
    expect(outcome.evidenceIds).toContain('ev-separation');
    expect(outcome.claimIds.length).toBeGreaterThanOrEqual(1);
    expect(outcome.sourceEventIds).toEqual([]);
    expect(outcome.explanation).toMatch(/verified measurement|separation/iu);
    const note = outcome.evidenceNote + ' ' + outcome.explanation;
    expect(note).toMatch(/hypothesis|likely/iu);
    expect(note).not.toMatch(/proves|proven causation|caused the/iu);
    expect(outcome.resolver).toBe(ASK_RESOLVER_LABEL);
  });

  it('review round: every cited id belongs to its AUTHORITATIVE set, typed correctly', async () => {
    const golden = await loadGoldenMatch();
    const source = buildCompilerSource(golden);
    if (!source.ok) return;
    const corpus = buildCompileCorpus(source.snapshot.context);
    const eventIds = new Set(source.snapshot.context.events.map((event) => event.eventId));
    const evidenceIds = new Set(corpus.golden.evidence.map((entry) => entry.id));
    const claimIds = new Set(corpus.golden.claims.map((claim) => claim.id));
    for (const prompt of [
      'Show me how the off-ball run opened space',
      'Show the build-up to the goal',
      'Give me a wide broadcast view',
    ]) {
      const outcome = await resolveAskMoment(prompt);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      for (const id of outcome.sourceEventIds) expect(eventIds.has(id)).toBe(true);
      for (const id of outcome.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
      for (const id of outcome.claimIds) expect(claimIds.has(id)).toBe(true);
      // The sets are disjoint by TYPE: no id appears in the wrong field.
      for (const id of outcome.sourceEventIds) {
        expect(evidenceIds.has(id)).toBe(false);
        expect(claimIds.has(id)).toBe(false);
      }
    }
  });

  it('review round: the off-ball answer NEVER prints undefined; measured text is compiler-verified, hypothesis qualified', async () => {
    const outcome = await resolveAskMoment('Show me how the off-ball run opened space');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const text = `${outcome.explanation} ${outcome.evidenceNote}`;
    // The calculated claim carries no proposal `text` (the contract forbids
    // it) — the answer must quote the TYPED verified scalar instead.
    expect(text).not.toContain('undefined');
    expect(outcome.explanation).toMatch(/changed by \d+\.\d{3} m/u);
    expect(outcome.explanation).toContain('re-verified at compile time');
    // Deterministic across calls, and the hypothesis stays qualified.
    const again = await resolveAskMoment('Show me how the off-ball run opened space');
    expect(again.ok && again.explanation).toBe(outcome.explanation);
    expect(text).toMatch(/hypothesis|likely/iu);
    expect(text).not.toMatch(/proves/iu);
  });

  it('a wide view resolves to the broadcast-sweep proposal — a DIFFERENT validated manifest than the directed cut', async () => {
    const wide = await resolveAskMoment('Give me a wide broadcast view');
    const directed = await resolveAskMoment('Show the build-up to the goal');
    expect(wide.ok && directed.ok).toBe(true);
    if (!wide.ok || !directed.ok) return;
    expect(wide.result.ok && directed.result.ok).toBe(true);
    if (!wide.result.ok || !directed.result.ok) return;
    expect(wide.result.manifestHash).not.toBe(directed.result.manifestHash);
    expect(wide.explanation).not.toBe(directed.explanation);
  });

  it('deterministic: the same prompt twice yields identical grounded outcomes', async () => {
    const first = await resolveAskMoment('Show the build-up to the goal');
    const second = await resolveAskMoment('Show the build-up to the goal');
    expect(second).toEqual(first);
  });

  it('unsupported input is REFUSED with guidance — never silently substituted', async () => {
    const outcome = await resolveAskMoment('What is the referee\u2019s name?');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('unsupported');
    expect(outcome.message).toContain('nothing was substituted');
    expect(outcome.supportedExamples.length).toBe(3);
  });

  it('a stale source reference cannot produce a verified artifact (basedOn is the current revision)', async () => {
    const outcome = await resolveAskMoment('Show the build-up to the goal');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.result.ok) return;
    const golden = await loadGoldenMatch();
    const source = buildCompilerSource(golden);
    if (!source.ok) return;
    const corpus = buildCompileCorpus(source.snapshot.context);
    // The resolver's proposals are built from the CURRENT source revision,
    // and the deterministic compiler rejects any stale reference outright —
    // a bumped basedOn cannot produce a verified artifact.
    expect(corpus.golden.basedOn.reducerRevision).toBe(source.snapshot.context.reducerRevision);
    const stale: typeof corpus.golden = {
      ...corpus.golden,
      basedOn: {
        reducerRevision: source.snapshot.context.reducerRevision + 7,
        sourceHash: corpus.golden.basedOn.sourceHash,
      },
    };
    const staleResult = compileMomentProposal(stale, source.snapshot.context);
    expect(staleResult.ok).toBe(false);
    if (staleResult.ok) return;
    expect(staleResult.errors[0]?.code).toBe('stale_revision');
    expect(outcome.result.inputFingerprint).toBeTruthy();
  });
});
