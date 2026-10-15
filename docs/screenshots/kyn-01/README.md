# KYN-01 verification screenshots

Rendered-page captures from the KYN-01 pull request, taken against the
production build (`pnpm build` + `pnpm start`, Next.js 16). The stage, hero and
tablet captures are from 14 October 2026; the fixture-seam captures were
re-taken after the review round (path-leak hardening, "Validated index" chip,
validation-timing row) on the same day.

| File | Viewport | What it verifies |
|---|---|---|
| `desktop-1440x900-hero.png` | 1440×900 | Header, hero, heading hierarchy, brand tokens |
| `desktop-1440x900-stage.png` | 1440×900 | Scene placeholder with exact 105 m × 68 m proportions (1072×694 px) |
| `desktop-1440x900-fixture-seam.png` | 1440×900 | Fixture seam panel: "Validated index" chip, intentional zero-fixture state, no filesystem paths |
| `tablet-1024x768.png` | 1024×768 | Responsive hero and stage, no overflow |
| `mobile-390x844-stage.png` | 390×844 | Stage grows to fit the note card; no clipping or horizontal scroll |
| `mobile-390x844-fixture-seam.png` | 390×844 | Metadata rows stack cleanly; long values wrap without clipping |

Checks performed at capture time (re-run for the review round): zero issues
from an automated audit at every viewport — no page-level horizontal overflow,
no element extending past the viewport edges, no clipped text in
overflow-constrained elements; no Next.js error overlay; single H1 with
heading order h1 → h2 → h3; skip link present; scene stage aspect ratio 1.544
(105/68) on desktop and tablet.
