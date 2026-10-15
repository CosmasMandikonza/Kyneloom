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

The committed `index.json` currently registers **zero fixtures** on purpose:
no synthetic match data exists yet, and the repository does not fabricate
player trajectories or match statistics.

## Overriding the location

Set `KYNELOOM_FIXTURES_DIR` (see the root `.env.example`) to point the web
app at a different fixtures directory. When unset, the app walks up from its
working directory to the repository root and uses `tests/fixtures`.
