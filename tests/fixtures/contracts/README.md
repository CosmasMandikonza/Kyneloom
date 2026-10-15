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
  disclosed interpolated sample (partial visibility, named method).
- `match-state.json` — a coherent projection at 78:42 with possession.

## invalid/

Seventeen adversarial documents. Each must fail its parser with the exact
expectation recorded in `expectations.json` (field path, error code, and/or
message fragment), covering: nonmonotonic and out-of-window camera keyframes,
undeclared evidence references, script injection via unknown keys, out-of-range
FOV, underground cameras, draft-status manifests carrying approvals, future
schema versions, Infinity and negative event timestamps, unknown event kinds,
tracked-visibility samples with reconstructed origins, extrapolation without
an uncertainty horizon, infinite coordinates, ghost possessors, and duplicate
players.

When you add a rejection case, add the file, record the expectation, and the
corpus test picks it up automatically (and fails if file and expectation lists
diverge).
