# qa/ — visual QA artifacts (KYN-05)

Everything here is produced by the committed script — nothing is hand-edited.

```bash
pnpm qa:visual   # from the repo root
```

The script (`scripts/visual-qa.ts`) builds the web app, starts the production
server on an ephemeral port, and captures Playwright Chromium screenshots of
the four routes (`/`, `/explore`, `/studio`, `/m/mom-synthetic-78m`) at
**1440×900, 1280×800, 1024×768, 390×844 and 375×812**, plus
`prefers-reduced-motion` variants (`*-rm.png`) for `/` and `/explore` at
1440×900 and 390×844 — 25 captures in total.

Each run also verifies per capture: no horizontal overflow, no console errors,
and route-specific interaction checks (playhead scrubbing, lens selection,
truthfully disabled controls, real fixture facts, navigation flow). The run
exits non-zero and names every failed check; `report.json` records the
machine-readable results.

Procedure (docs/16): after a passing run, the operator inspects the
screenshots personally and iterates the design, then re-runs until the review
is clean. The current captures reflect the post-review state of the KYN-05
surfaces.
