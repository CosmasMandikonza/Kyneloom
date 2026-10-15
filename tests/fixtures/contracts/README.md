# Contract fixture corpus (KYN-02)

Versioned valid and adversarial fixtures for the canonical contracts in
`packages/contracts`. Consumed by `tests/contracts-corpus.test.ts` through the
public package API — never parsed by ad-hoc code.

## valid/

- `moment-manifest.json` — the golden manifest. Must stay identical to the
  exported `exampleMomentManifest()` from `@kyneloom/contracts`; the corpus
  test enforces this so docs, corpus and consumer tests cannot drift.
- `match-events.json` — three canonical events including a correction chain
  (`evt-0042-r2` supersedes `evt-0042` at source revision 2).
- `tracking-samples.json` — a tracked player, a tracked airborne ball, and a
  disclosed interpolated sample (`partial` visibility, named method).
- `match-state.json` — a coherent projection at 78:42 with a positioned ball
  and possession.
- `match-state-event-only.json` — the event-only fallback: the ball position
  is explicitly `unavailable` (`no_tracking_source`) with no possessor and an
  empty player list; nothing invents coordinates.

## invalid/

Twenty-six adversarial documents. Each must fail its parser with the exact
expectation recorded in `expectations.json` (field path, error code, and/or
message fragment), covering: nonmonotonic and out-of-window camera keyframes,
keyframes outside their own camera track's interval, undeclared evidence
references, duplicate camera-track/evidence ids, script injection via unknown
keys, out-of-range FOV, underground and beyond-radius cameras, draft-status
manifests carrying approvals, future schema versions, Infinity and negative
event timestamps, unknown event kinds, observed events without a license
reference, tracked-visibility samples with reconstructed origins,
`partial`-visibility samples with factual origins, coordinate-bearing
`untracked` samples, extrapolation without an uncertainty horizon, infinite
coordinates, ghost possessors, unavailable balls that still claim a possessor,
duplicate players, and players whose team contradicts their entity id.

When you add a rejection case, add the file, record the expectation, and the
corpus test picks it up automatically (and fails if file and expectation lists
diverge).
