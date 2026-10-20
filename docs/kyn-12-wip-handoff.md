# KYN-12 WIP handoff — football intelligence checkpoint

> **Status:** RESUME COMPLETED 2026-10-20 — every item in "NOT completed — resume here" is now done: qa:visual green (36 captures incl. the agent-metric-api section), screenshots regenerated consistently, the demo trace committed (`qa/intelligence-trace.txt`), docs 07/11 updated with implemented-pointers, the threshold-sensitivity evaluation executed and documented (`qa/intelligence-sensitivity.txt` + docs/21 + pinning tests), coverage expanded (+12 tests: asset truthfulness, budgets, sensitivity boundaries), full ladder green (599/599). This file remains as the historical handoff record; the PR carries the final state.

## Branch / commit

- Branch: `feat/kyn-12-football-intelligence`, cut from verified `main` @ `5fc767c` (KYN-11 merge).
- Checkpoint commit: `wip(kyn-12): preserve football intelligence progress`.
- Issue: #12. No PR opened yet (do NOT open one from this WIP state without completing the remaining work).

## Completed and verified locally

### The intelligence library (`packages/match-core/src/intelligence/`)

| File | Contents | Tests |
|---|---|---|
| `metric-result.ts` | Versioned `MetricResult` discriminated union (`verified` / `disclosed` / `insufficient-evidence`), provenance (units, deps, coverage, fingerprint, interpretation boundary), `metricIdFor` / `metricFingerprint` helpers. **Zero is a value; missing is a status.** | via all below |
| `source-quality.ts` | Shared KYN-08-parity policy: existence (exactly one accepted sample — ambiguity withholds), `tracked` visibility, confidence ≥ 0.9, origin eligibility for the verified tier (today exactly `synthetic_ground_truth`); interpolated poses only ever yield `disclosed`. | via all below |
| `metric-nearest.ts` | Metric A `kyneloom-nearest-opponent-v1`: nearest opposing player from exact frames; deterministic lexicographic tie-break; "defender" label ONLY from authoritative roster roles; present-but-unreliable candidates withhold the whole metric. | hand-calc (3-4-5 = 5 m; equidistant tie-break; role filter; 4 withheld cases) |
| `metric-separation-adapter.ts` | Metric B: thin adapter over the canonical KYN-04 `separationFromTimeline` (`kyneloom-separation-v1` preserved; no alternate formula; fingerprint reused verbatim) + endpoint source-quality gate. Golden: 6.306 → 20.344, Δ 14.038. | hand-calc (6-8-10) + golden |
| `metric-lane.ts` | Metric C `kyneloom-lane-occupancy-v1`: finite-segment corridor, width/2 lateral band, in-segment projection, 1.5 m near-end exclusion, lateral-sorted deterministic ordering; geometric condition only — never pass feasibility/intent. | hand-calc (in/out corridor, beyond-endpoint, near-end, diagonal 6-8-10 line) |
| `metric-movement.ts` | Metric D `kyneloom-offball-movement-v1`: windowed displacement/path/mean/peak + optional spacing delta; ≥ 60 % grid coverage; interpolated points → `disclosed` with explicit disclosure; off-ball status (`full`/`partial`/`unknown`) from accepted possession events only, never claimed as verified possession. | hand-calc (straight 10 m/1 s; L-path 7 vs 5; interpolation downgrade; coverage withhold) |
| `candidates.ts` | `kyneloom-moment-candidates-v1` detector/scorer: event salience (goal 40 / shot 12 / pass 4 / correction 6) + tactical salience (separation 2.2 pt/m > 4 m; movement burst 6 pt per m/s, mean ≥ 4.5 OR peak ≥ 6.75 so sprints aren't diluted; proximity 4 pt > 3 m); 4.5 s look-back, 6 s merge; context events cited without salience; ids are fingerprints over canonical sorted inputs (revision-scoped); `causalClaimSupport: 'insufficient'` structurally. | golden + adversarial |
| `agent-tool.ts` | `get_metric` boundary `kyneloom-get-metric-v1`: total `parseMetricQuery` (grammar validation, width ≤ 20 m, window ≤ 120 s, step ≥ 50 ms), `executeMetricQuery` (unknown-entity / outside-tracked-window rejections), `validateClaim` deterministic claim policy (exact metric value = `supported`; wrong value = `unsupported`; ANY causal-objective = `unsupported` with the permitted hypothesis wording), `SUPPORTED_METRICS` allowlist. | hand-calc + golden |

### Golden-fixture discovery (`tests/intelligence-golden.test.ts`, 8 tests, all passing)

The detector AUTONOMOUSLY surfaces The Invisible Assist from the accepted corpus (no matchId special-casing): `cand-23ec4cfe`, window 4721700–4729800, anchors `evt-0042`/`evt-0009`/`evt-0010`, context including `evt-0007`, both signal families contributing, score 140.2 (events 56 + tactical 86). Byte-stable under repetition, event-order shuffling and duplicate delivery; missing frames withhold tactical signals (goal event may stand alone); goal rescission (same-id revision-2 correction) removes goal salience; the four metrics execute through the real tool path with canonical values.

### Adversarial corpus (`intelligence.adversarial.test.ts`, all passing)

Four deterministic in-memory scenarios (golden fixture untouched): movement-without-goal; goal-after-movement (detector groups honestly; claim policy REFUSES "the run caused the goal"); coverage starvation (every tactical signal withheld, zero fabricated); corrected-outcome rescission. Plus: hand-checked +9 m separation in the adversarial corpus; conflicting sample at a dependency frame invalidates a previously verified result (`ambiguous-identity`); revision-scoped candidate ids; threshold sensitivity (burst bar at 20 m/s + score floor 200 → zero candidates); deterministic ranking; bounded execution.

### Agent HTTP API (`apps/web/src/app/api/agent/metric/route.ts`)

Server-only `POST /api/agent/metric`: allowlisted sources (exactly `synthetic-derby-01`; unknown ids → 404 without revealing what exists), 4 KB body cap, stale `reducerRevision` → 409 with current revision, typed 4xx rejections, full `MetricResult` responses (no source dumps), `GET` → documented 405. Revision-aware context cache (60 s TTL keyed on current reducer revision).

### Demo trace (`scripts/intelligence-demo.ts`, `pnpm intelligence:demo`)

Ran successfully: projection 202.9 ms, detection 9.5 ms, 1 candidate, all four metrics verified through the tool path with fingerprints, claim policy demonstration (exact value supported; wrong value unsupported; causal claim unsupported with hypothesis wording), total 243.1 ms.

### Validation state at checkpoint time

Already run and green BEFORE the interrupted final pass: `pnpm lint` clean, `pnpm typecheck` clean (all projects incl. tests), `pnpm format:check` clean, `pnpm test` **47 files / 595 tests passed** (up from 558), `pnpm build` Done, `node scripts/check-docs.mjs` OK (37 files).

## NOT completed — resume here

1. **`pnpm qa:visual` full run** — was launched and KILLED mid-run to checkpoint (the machine had to be returned). The script contains the NEW KYN-12 section (`agent-metric-api`: 2 valid HTTP queries incl. canonical Δ14.038 + 8 adversarial rejections + 405 GET check). It has never completed against the built app — run it first and fix whatever it finds.
2. **The modified `qa/screenshots/*.png`** in the working tree are PARTIAL artifacts of the killed run — re-run `pnpm qa:visual` to regenerate them all consistently before committing the next time (they were left modified-but-unstaged deliberately; stage only after a green run, or restore with `git checkout -- qa/screenshots` if the run is red).
3. **`scripts/intelligence-demo.ts` output capture** into a committed artifact (e.g. `qa/intelligence-trace.txt`) is not yet wired — the PR body should embed the real trace.
4. **Docs 07/11 cross-references**: `docs/21-football-intelligence.md` exists and is linked from the README table; docs/07 still says the tool contracts are "planned" — add an implemented-pointer sentence when finishing.
5. **Evaluation corpus expansion** (mission §12) — the four adversarial scenarios + sensitivity check exist; a broader multi-fixture corpus with measured threshold-perturbation tables is still thin. At minimum document the current thresholds' behavior under perturbation in the PR.
6. **PR**: not opened. After a green `qa:visual`, commit regenerated screenshots, open `KYN-12 — Versioned Football Intelligence & Meaningful Moment Detection` against issue #12, leave unmerged.

## Known failure states / decisions to revisit

- `nearestOpponent` withholds when a present-but-unreliable candidate exists (policy: a potentially-nearest ambiguous opponent must never be skipped in favor of a farther one) — assert this stays true in review.
- `CANDIDATE_THRESHOLDS.minimumTotalScore = 25` means a bare goal (40) always surfaces even with zero tactical support — intended (event salience is real signal); confirm with the other founder.
- Movement-burst dual trigger (mean OR 1.5× peak) was added so the golden sprint isn't diluted — the weights table in `docs/21` documents it.

## How to resume

```bash
git fetch && git checkout feat/kyn-12-football-intelligence
pnpm install --frozen-lockfile
pnpm qa:visual        # complete item 1; fix findings; regenerate screenshots
# then items 3–6 above, then the full ladder once more before the PR
```
