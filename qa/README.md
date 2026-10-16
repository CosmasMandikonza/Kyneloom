# qa/ — visual QA artifacts (KYN-05, extended KYN-06)

Everything here is produced by the committed scripts — nothing is hand-edited.

```bash
pnpm qa:visual   # screenshots + functional checks (from the repo root)
pnpm qa:record   # real-browser video of the golden replay sequence
```

Both scripts expect a production build (`pnpm build`) and start the web app
themselves on a scratch port.

## `qa:visual` (scripts/visual-qa.ts)

Playwright Chromium captures the four routes (`/`, `/explore`, `/studio`,
`/m/mom-synthetic-78m`) at **1440×900, 1280×800, 1024×768, 390×844 and
375×812**, plus `prefers-reduced-motion` variants (`*-rm.png`) for `/` and
`/explore` at 1440×900 and 390×844 — 25 captures in total.

Per capture it verifies: no horizontal overflow, no console errors, and
route-specific interaction checks. The `/explore` (KYN-06) pass additionally
asserts against the **live 3D scene**: canvas initialization under headless
WebGL2, exactly 22 players / 0 missing via the scene QA hook, enabled camera
radios, byte-identical world snapshots across all four camera modes at the
same playhead, deterministic seek-back, golden ball truth at the checkpoint
(21.241, −2.172, 0.11 — exact), keyboard playhead stepping + Space transport,
transport/stage non-overlap (mobile included), 2D fallback mounting on the
same timeline, and a perf-probe read after 4 s of playback (headless numbers
are SwiftShader-honest; GPU numbers come from the headed `qa:record` run).

## `qa:record` (scripts/record-replay.ts)

Produces `qa/video/living-replay-800x600.webm` — the **real browser video
evidence** of the golden sequence: checkpoint freeze → decoy run (home-11,
away-03 responding) + pass release (broadcast camera) → scrub back →
player-follow camera → threaded pass, shot, goal at 4728300 → paused
aftermath. Every native screencast path on this host records blank frames
(verified with ffmpeg), so the script captures **deterministic stepped
frames**: the paused playhead is seeked in exact 250 ms increments, each real
rendered frame is screenshotted, and ffmpeg assembles them at 4 fps = true
match speed. The script self-checks adjacent-frame motion, stays inside the
8–15 s envelope, and needs an ffmpeg binary (`KYN_FFMPEG`, `.tools/ffmpeg`,
or PATH).

## Procedure (docs/16)

After a passing run, the operator inspects the screenshots and the video
personally and iterates the design, then re-runs until the review is clean.
`report.json` records the machine-readable results, including the perf probe
readings and ready timings per viewport.
