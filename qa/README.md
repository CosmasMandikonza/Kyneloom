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

## `qa:record:live` (scripts/record-replay-live.ts)

Records `qa/video/living-replay-screencast.mp4` (+ a transcoded `.webm`
twin) — a **continuous, real-time 30 fps screencast** of the golden sequence
on the machine GPU: headed Chromium in a fixed window region, captured with
ffmpeg's Windows screen grabber (gdigrab). This run: 12.3 s, 368 frames,
adjacent-frame motion Δ10.7 Y-units (ffmpeg-verified, never a blank capture).
Live in-browser screencast paths on this host write blank constant-luminance
WebM files (verified), so the screen-level capture is the honest route to a
smooth real-time recording. Requires an interactive Windows desktop.

### Evidence X-Ray checks (KYN-08)

The `/explore` pass also drives the full click-to-claim-to-evidence path:
X-Ray toggle → real rendered overlays (live probe), world invariance across
camera switches + scrubbing during X-Ray, before/after phase redraw, the
inspector sentence with the computed values verbatim, provenance +
interpretation labels, source frame IDs, frame navigation seeking, keyboard
`X`/`I`/Escape — plus `explore-xray-*.png` captures per viewport.

## `qa:record:xray` (scripts/record-xray-live.ts)

KYN-08's interaction evidence: a continuous, real-time capture of the full
Evidence X-Ray path — overhead → play → `X` activates the overlays → before/
after/both phases → Show evidence → source frame IDs → Go to before frame →
Back to replay → X-Ray off → broadcast — `qa/video/xray-screencast.mp4`
(+ `.webm` twin). Captured from the **browser compositor's own frame stream**
(CDP `Page.startScreencast`): every frame is the exact composited page,
WebGL canvas included. On this host screen-level capture is unavailable (the
operator's desktop covers every screen region, and gdigrab's PrintWindow
window capture returns black for Chrome's GPU surfaces), and occlusion
throttling is disabled (`--disable-backgrounding-occluded-windows` +
`--disable-features=CalculateNativeWinOcclusion`) so compositing continues
at full rate while covered. This run: 14.3 s, 302 frames at a measured
21.2 fps, adjacent-frame motion Δ9.9 Y-units (ffmpeg-verified), inside the
8–15 s envelope.

## `qa:record:camera` (scripts/record-camera-live.ts)

KYN-07's rig evidence: a continuous 30 fps gdigrab screencast of the camera
system itself — overhead → winger-follow descent → goalkeeper perspective →
an interrupted mid-flight transition → the manifest-directed shot-to-goal
composition → exit — `qa/video/camera-rig-screencast.mp4` (+ `.webm` twin).
Same pipeline and honesty rules as `qa:record:live`.

## `qa:record` (scripts/record-replay.ts)

Produces `qa/video/living-replay-800x600.webm` — a **deterministic
frame-step compilation** (NOT a continuous real-time screencast; the live
screencast above is the real-time evidence) of the same golden sequence:
checkpoint freeze → decoy run + pass release (broadcast) → scrub back →
player-follow camera → threaded pass, shot, goal at 4728300 → paused
aftermath. The paused playhead is seeked in exact 250 ms increments, each
real rendered frame is screenshotted, and ffmpeg assembles them at 4 fps =
true match speed — every output frame is a genuine rendered browser frame at
a known, reproducible playhead. The script self-checks adjacent-frame motion,
stays inside the 8–15 s envelope, and needs an ffmpeg binary (`KYN_FFMPEG`,
`.tools/ffmpeg`, or PATH).

## Procedure (docs/16)

After a passing run, the operator inspects the screenshots and the video
personally and iterates the design, then re-runs until the review is clean.
`report.json` records the machine-readable results, including the perf probe
readings and ready timings per viewport.
