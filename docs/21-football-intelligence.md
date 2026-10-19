---
title: Football Intelligence (KYN-12)
status: implemented-deterministic-library
---

# 21 — Football intelligence: versioned metrics and meaningful-moment detection

> **Status:** implemented (KYN-12) as a deterministic library inside `@kyneloom/match-core` (`src/intelligence/`). No learned model, no Foundry connectivity, no probabilistic claims — every number is recomputable from accepted source frames.

## Flow (the authoritative pipeline)

```text
Accepted events + tracking → Canonical reducer → Deterministic metrics
  → Evidence-qualified tactical signals → Candidate scoring
  → Bounded read-only agent tools
```

A model can **read** numbers through the tool boundary; it can never calculate, overwrite or certify a numerical football fact (`validateClaim` adjudicates against the tool's own recomputation).

## The four metrics

| Metric | Algorithm version | Units | Verified tier requires |
|---|---|---|---|
| A · Nearest opponent | `kyneloom-nearest-opponent-v1` | metres | exact unambiguous `tracked` samples, confidence ≥ 0.9, declared synthetic-ground-truth origin; role labeling only from authoritative roster roles |
| B · Separation delta | `kyneloom-separation-v1` (the canonical KYN-04 implementation, thin adapter) | metres | the four endpoint samples additionally pass the KYN-08 source-quality gate |
| C · Passing-lane occupancy | `kyneloom-lane-occupancy-v1` | entity_count | both endpoints exact; finite segment, width/2 lateral band, in-segment projection, near-end exclusion (1.5 m), deterministic ordering |
| D · Windowed off-ball movement | `kyneloom-offball-movement-v1` | metres (+derived m/s) | ≥ 60 % grid coverage at the sampling cadence; interpolated points DOWNGRADE the result to `disclosed`, never `verified` |

**Zero is a value; missing is a status.** Unsupported results are `insufficient-evidence` with a machine-readable failure code — never a numeric 0.

## Source-quality policy (shared)

`intelligence/source-quality.ts` mirrors the Evidence X-Ray `SOURCE_QUALITY_POLICY` (KYN-08): existence (exactly one accepted sample per entity/time — ambiguity withholds), `tracked` visibility, confidence ≥ 0.9, and origin eligibility for the verified tier (today exactly `synthetic_ground_truth`; observed/mixed inputs are never mislabeled — an observed-eligible policy registers here when licensed observed data exists). Interpolation is disclosed and can only ever produce a `disclosed` result.

## MomentCandidate detection

`intelligence/candidates.ts` (`kyneloom-moment-candidates-v1`) combines **event salience** (goal 40 / shot 12 / pass 4 / correction 6 — transparent hand-chosen weights, a ranking heuristic, never a probability) with **tactical-change salience** computed by the metrics: separation deltas (2.2 pt/m beyond 4 m), movement bursts (6 pt per m/s — sustained mean ≥ 4.5 m/s **or** peak ≥ 6.75 m/s so a sprint is not diluted by recovery walking), proximity gains (4 pt beyond 3 m). Windows anchor on salient events with a 4.5 s tactical look-back, merge within 6 s, and cite every accepted event inside the final window as context.

Determinism: candidate ids are fingerprints over canonical, sorted inputs (scorer version, match, revision, window, anchors, metric refs) — never iteration order or runtime timestamps. Replaying the identical accepted input (including shuffled or duplicated delivery) reproduces byte-identical detections. A new accepted revision produces new ids.

`causalClaimSupport` is structurally `'insufficient'` on every candidate: a goal and a spatial change co-occurring in one window is reported as co-occurrence — never causation. The deterministic claim policy refuses "the run caused the goal" outright and names the permitted hypothesis interpretation.

## Agent tool boundary

`intelligence/agent-tool.ts` + `POST /api/agent/metric` (server-only, Next.js route):

- allowlisted match sources (today exactly `synthetic-derby-01`; broader resolution awaits Issue #21 auth/tenant/licensing — unknown ids are refused without revealing what exists);
- the four metric kinds only; strict grammar validation (entity ids `home-XX`/`away-XX`, finite bounded windows, width ≤ 20 m, window ≤ 120 s, step ≥ 50 ms, 4 KB body cap);
- stale `reducerRevision` → 409 with the current revision;
- responses carry the full MetricResult (status, value or failure, units, provenance, dependencies, fingerprint) — never raw source dumps;
- no SQL, paths, URLs or executable content accepted anywhere.

## Validation (in-repo)

- **Hand-calculated fixtures** (`metrics.hand-calc.test.ts`): 3-4-5 triangles for nearest/distance, equidistant tie-breaking, in/out corridor cases, L-shaped path length vs displacement, interpolated downgrades — expectations derived on paper, never from the implementation.
- **Golden discovery** (`intelligence.golden.test.ts`): the detector autonomously surfaces The Invisible Assist (window 4721700–4729800, anchors evt-0042/evt-0009/evt-0010, cited context including evt-0007) with both signal families contributing; byte-stable under repetition, event shuffling and duplicate delivery; missing frames withhold tactical signals; goal rescission removes goal salience.
- **Adversarial corpus** (`intelligence.adversarial.test.ts`): movement-without-goal, goal-after-movement (causal claim refused), coverage starvation (zero tactical signals; a goal event may still stand alone), corrected outcome, revision-scoped ids, conflicting-sample invalidation, bounded execution.
- **HTTP adversarial suite** (in `pnpm qa:visual`): eight hostile requests rejected with the documented codes + the two canonical verified queries.

## Reproduce

```bash
pnpm intelligence:demo   # the full deterministic trace with real ids/values
```

Related: [docs/05](05-data-and-event-contracts.md) · [docs/07](07-agent-orchestration.md) · [docs/11](11-evaluation-and-reliability.md)
