# Test fixtures

Versioned test-harness data consumed by the web application through the
fixture-loading seam (`packages/contracts` + `apps/web/src/lib/fixtures.ts`).

## What this directory is — and is not

This directory holds **test-only fixture metadata**: an `index.json` registry
that the future synthetic-match generator (KYN-03) will populate with real
fixture payloads. It is deliberately **not** the canonical football data
contract. The final `MatchEvent`, `TrackingSample`, and `MomentManifest`
schemas are jointly owned by KYN-02 and must not be invented here.

## index.json format

```json
{
  "schemaVersion": "0.1",
  "fixtures": [
    {
      "id": "synthetic-derby-01",
      "label": "Synthetic derby — first vertical slice",
      "generator": "fixture-engine-v1",
      "seed": 24017,
      "file": "synthetic-derby-01.json"
    }
  ]
}
```

- `schemaVersion` — `"major.minor"` understood by `@kyneloom/contracts`.
  A mismatch is a hard error, never silently ignored.
- `fixtures` — may be empty. An empty index is the intentional
  "no fixture data" state; the web app renders an explicit empty state
  rather than fabricating data.
- `file` — relative path inside this directory, using forward slashes only.
  The parser rejects absolute paths (POSIX root, UNC root, drive letters,
  including forward-slash drive forms like `C:/x`), backslash separators and
  Windows-style traversal (`folder\..\secret.json`), `..`/`.`/empty path
  segments, and control characters.

## generated/ — canonical golden fixture (KYN-03)

`generated/synthetic-derby-01/` holds the committed golden fixture produced by
the seeded simulator (`pnpm fixture:generate --seed 24017`):

- `events.json` — 11 canonical `MatchEvent` envelopes (kickoff, halves, an
  away goal, the golden pass/shot/goal sequence, full time).
- `tracking.jsonl` — 5,129 canonical `TrackingSample` lines: 23 entities per
  frame, 10 Hz across the golden window [4717000, 4731000] and 1 Hz context
  (±30 s / +10 s, plus windows around every emitted event).
- `metadata.json` — seed, generator version, sampling plan, per-half attack
  directions, score timeline, golden metrics **derived from the emitted
  samples** (decoy-run separation 6.3 → 20.3 m), and sha256 integrity
  checksums.
- `README.md` — the human-readable golden timeline.

The fixture is registered in `index.json` (id `synthetic-derby-01`), so the
web app's fixture seam renders it. Regeneration is byte-identical (asserted
by `tests/golden-fixture.test.ts`); a different seed produces a different but
contract-valid scenario. The deterministic reducer (KYN-04) is NOT part of
the generator: fault-injection variants (duplicates, out-of-order delivery,
late corrections, dropped frames, identity swaps) are produced by
`@kyneloom/match-core` variant functions as reducer test inputs.

## Overriding the location

Set `KYNELOOM_FIXTURES_DIR` (see the root `.env.example`) to point the web
app at a different fixtures directory. When unset, the app walks up from its
working directory to the repository root and uses `tests/fixtures`.
