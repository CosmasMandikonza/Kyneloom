# qa/ — visual QA artifacts (KYN-05, extended KYN-06 through KYN-13)

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
`/explore` at 1440×900 and 390×844 — plus the KYN-09 transition captures
(`landing-fragments-*`, `landing-reveal-*`, `landing-fallback-375x812`).

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
camera switches + scrubbing during X-Ray, before/after phase redraw,
**scene→inspector interaction** (real mouse click — real touch tap on
390×844 — on the measured geometry via the overlay probe's projected hit
target; `explore-xray-click-1440x900.png` + `explore-xray-click-390x844.png`
capture the open inspector), the inspector sentence with the computed
values verbatim, provenance + interpretation labels, source frame IDs,
frame navigation seeking, keyboard `X`/`I`/Escape, and a **bounded-resource
check** (4 X-Ray on/off rounds × 3 phase switches must not grow the WebGL
geometry/texture counts) — plus `explore-xray-*.png` captures per viewport.

### Landing transition checks (KYN-09)

The `/` pass asserts the encounter contract (headline, one clickable CTA,
fixture facts, live orb probe) at every viewport, then drives the FULL
orb→stadium transition: fragment + reveal captures by deterministic
elapsed time, handoff to `/explore?enter=orb` at the canonical checkpoint
with 22 players, the landing probe deleted and exactly one canvas. Phase
transitions are asserted from a sessionStorage phase trace (review round):
the normal entry passes idle → intro → fragments → pitch_reveal → ready in
order; reduced motion goes idle → ready directly (no choreography, timed);
a rapid double activation keeps startCount === 1 and preserves
`?enter=orb`; Skip during intro is proven at 1280×800. Fragment budgets
are asserted numerically (320 at 390×844 AND 375×812, 900 at desktop). A
WebGL-disabled browser instance proves the poster fallback
(`landing-fallback-375x812.png`), and repeated landing→replay→back→replay
navigation keeps GPU geometry/texture growth bounded.

## `qa:record:landing` (scripts/record-landing-live.ts)

KYN-09's entry evidence: a continuous capture of the full signature path —
landing orb idle → **Enter the moment** → intro → fragment morph → pitch
reveal → handoff into the REAL Living Replay → 22 footballers playing →
follow camera → Evidence X-Ray — `qa/video/landing-entry-screencast.mp4`
(+ `.webm` twin), captured from the browser compositor's own frame stream
(same disclosed method as `qa:record:xray`). This run: 13.2 s, 281 frames
at a measured 21.3 fps, adjacent-frame motion Δ47.0 Y-units
(ffmpeg-verified), inside the 8–15 s envelope; the replay after handoff
reports 22 players at playhead 4725897 (playing).

### Design iterations (KYN-09, in `qa/iterations/`)

Three documented visual iterations: **i1** (noted, screenshots superseded) —
centered small orb over centered text: rejected as too dim/generic;
**i2** (`i2-*.png`) — orb presence (size/glow/palette), asymmetric editorial
composition (orb right, words left; orb upper on mobile), and the reveal
beat (stadium hidden until `pitch_reveal`); **i3** (`i3-*.png`) — fragment
presence (brighter shards, slower orb dissolve so the orb visibly hands its
mass to the swarm, swarm-hugging camera) — verified frame-by-frame before
the final QA sweep.

## `qa:record:xray` (scripts/record-xray-live.ts)

KYN-08's interaction evidence: a continuous, real-time capture of the full
Evidence X-Ray path — overhead → play → `X` activates the overlays → before/
after/both phases → **click the measured geometry itself to open the
inspector (scene→claim→source)** → source frame IDs → Go to before frame →
Back to replay → X-Ray off → broadcast — `qa/video/xray-screencast.mp4`
(+ `.webm` twin). Captured from the **browser compositor's own frame stream**
(CDP `Page.startScreencast`): every frame is the exact composited page,
WebGL canvas included. On this host screen-level capture is unavailable (the
operator's desktop covers every screen region, and gdigrab's PrintWindow
window capture returns black for Chrome's GPU surfaces), and occlusion
throttling is disabled (`--disable-backgrounding-occluded-windows` +
`--disable-features=CalculateNativeWinOcclusion`) so compositing continues
at full rate while covered. This run: 13.2 s, 333 frames at a measured
25.3 fps, adjacent-frame motion Δ9.6 Y-units (ffmpeg-verified), inside the
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

### Moment gallery checks (KYN-10)

`/moments` joins the capture matrix with its own acceptance set: the live
probe (`__kyneloomMoments`) reports ≥ 12 chapters with distinct ids and
distinct source timestamps; every rendered card is a semantic link whose
href matches its catalog id; every preview image loads with a distinct src
(no repeated placeholder); the route owns zero canvases; the timeline spine
exposes one locator control per chapter; hover engages the tilt and reveals
the hook on fine pointers, a full pointer sweep across all cards followed by
leaving the grid ends with ZERO live tilt rAF loops; the featured motion
preview pauses when scrolled offscreen; reduced motion keeps discovery fully
functional with no spatial animation; and a real touch tap on 390×844 opens
the replay without hover (`moments-touch`). A dedicated `moments-seam`
section drives card→scene truth end to end: two different cards open
different correct playheads with exact ball truth at each frame
(4717000 → 5.156, 2.498, 0.11; 4728300 → 52.4, −2, 0.11), direct
`/explore?moment=<id>` works, unknown/malformed ids render the honest
notice with the default checkpoint intact, Tab/Enter keyboard activation
works with a visible focus ring, Evidence X-Ray outside the measured
interval shows the contextual note and its seek lands on 4720500, and three
moments→explore→moments rounds leak nothing.

## `moments:previews` and `qa:record:gallery` (KYN-10)

`pnpm moments:previews` (scripts/generate-moment-previews.ts) generates the
gallery's imagery from the REAL product: the live Living Replay opened at
each chapter's validated timestamp, deliberate camera per entry, rig
converged, floating chrome hidden for a clean plate, canvas captured
(`apps/web/public/moment-previews/*.png` + provenance `manifest.json`). The
featured motion preview is a continuous compositor capture of the playing
scene (headed GPU; headless fallback) assembled with ffmpeg.
`pnpm qa:record:gallery` (scripts/record-gallery-live.ts) records the
continuous discovery journey — gallery → featured → hover/tilt → different
chapter → 3D replay at its timestamp → camera change → honest evidence
context → inspector → back to replay — into
`qa/video/gallery-screencast.mp4` (+ `.webm` twin), same honesty rules as
the other recorders.

### Lens perspectives (KYN-11)

The `/explore` pass adds the one-truth-many-lens contract: Fan default
chrome, byte-identical playhead/selection/world across every switch,
distinct Analyst/Accessible presentations with the verified metric and
live description, session persistence with malformed revert, remembered
lens never overriding chapter timestamps, projected player selection, and
`explore-lens-*.png` evidence per viewport.

### Live stream checks (KYN-13)

The `/explore` pass extends to the streaming contract: recorded replay is
the default mode; activating **Live Synthetic Stream** must reach
`connected` (patient polling — SSE dispatch on SwiftShader takes seconds)
with the truthful status chip live and the scene QA hook reporting the
**streamed snapshot's 22 players / 0 missing**
(`explore-live-connected-1440x900.png`); a genuine producer stop through
the operator control route must take the chip off live-green to the honest
disconnected/reconnecting state with the scene preserved
(`explore-live-offline-1440x900.png`), and a restart must resynchronize
from the canonical snapshot with 22 players again
(`explore-live-recovered-1440x900.png`); at 390×844 the live panel fits
without overflow (`explore-live-panel-390x844.png`), and the service
telemetry endpoint reports **zero quarantined envelopes** on the clean
run. The desktop landing-transition flow runs with one bounded fresh-page
retry (a mid-flight WebGL canvas capture can wedge this host's software
renderer; a new page gets a new renderer process and reruns the identical
assertions).

## `qa:record:stream` (scripts/record-live-demo.ts)

KYN-13's live evidence: a continuous compositor capture of the full
streaming journey — recorded replay → activate **Live Synthetic Stream** →
genuine SSE connection with snapshot + deltas → streamed tracking
repositions the players → **operator stop mid-stream (the producer really
stops; the SSE loop closes with a truthful disconnected frame)** → restart
→ resynchronization → stream continues — into
`qa/video/live-stream-demo.mp4` (+ `.webm` twin), same compositor-capture
honesty rules as the other recorders. This run: 43.8 s, 716 frames at a
measured 16.4 fps, adjacent-frame motion Δ9.21 Y-units (ffmpeg-verified),
ending `connected` with 22 players.

## `qa:record:lens` and `lens:perf` (KYN-11)

`pnpm qa:record:lens` records the continuous acceptance journey (gallery →
Fan → select winger → Analyst at same instant → X-Ray + source frames →
Accessible transcript → back to Fan, selection intact) as
`qa/video/lens-journey-screencast.mp4` (+ `.webm` twin). `pnpm lens:perf`
measures frame times for all four presentations and lifecycle stability
across repeated switching (`qa/perf-lens.txt`).
