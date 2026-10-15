# synthetic-derby-01 — generated golden fixture

Seed **24017** · generator **fixture-engine-v1** ·
pitch 105×68 m ·
sampling 1 Hz background / 10 Hz golden ·
223 frames · 5129 samples · 11 events.

## Files

- `events.json` — canonical event envelopes (validated by `parseMatchEvent`).
- `tracking.jsonl` — one canonical sample per line (validated by `parseTrackingSample`).
- `metadata.json` — sampling plan, score timeline, derived golden metrics and integrity checksums.

## Golden timeline — "The Invisible Assist" (second half, home attacks +x)

| Time (ms) | Beat |
|---|---|
| 4720500 | Decoy run begins: home-11 sprints short; away-03 follows |
| 4722100 | **Checkpoint frame** (run in flight, defender following) |
| 4724000 | Separation away-03↔home-09: 6.306 m → 20.344 m (**+14.037 m**) |
| 4724000 | pass_attempted — home-08 releases |
| 4726200 | pass_completed (evt-0042) — home-09 controls (16.913 m at 7.688 m/s) |
| 4727800 | shot_attempted — home-09 shoots |
| 4728300 | **goal** — score 1–1 |
| 4741000 | Emission window ends |

Winger top speed during the decoy: 7.183 m/s (measured from samples).

## Score timeline

- 0 ms: 0-0
- 2095400 ms: 0-1
- 4728300 ms: 1-1

## Integrity

```json
{
  "events": "sha256:c18196de449df3a7098d69872512606403e5ed546a3544faedb95bf2bc3e6e97",
  "tracking": "sha256:4276fb09ec030f6d9c974f524f27f35350b1176ffc7e11676e33fd52d01ee4bd",
  "generatorVersion": "fixture-engine-v1"
}
```

Every metric above is derived from the emitted tracking samples at
generation time — nothing is hard-coded for the UI. Regenerate with:
`pnpm fixture:generate --seed 24017`.

