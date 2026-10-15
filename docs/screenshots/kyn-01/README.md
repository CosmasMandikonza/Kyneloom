# KYN-01 verification screenshots

Rendered-page captures from the KYN-01 pull request, taken against the
production build (`pnpm build` + `pnpm start`, Next.js 16) on 14 October 2026.

| File | Viewport | What it verifies |
|---|---|---|
| `desktop-1440x900-hero.png` | 1440×900 | Header, hero, heading hierarchy, brand tokens |
| `desktop-1440x900-stage.png` | 1440×900 | Scene placeholder with exact 105 m × 68 m proportions (1072×694 px) |
| `desktop-1440x900-fixture-seam.png` | 1440×900 | Fixture seam panel with the intentional zero-fixture state |
| `tablet-1024x768.png` | 1024×768 | Responsive hero and stage, no overflow |
| `mobile-390x844-stage.png` | 390×844 | Stage grows to fit the note card; no clipping or horizontal scroll |

Checks performed at capture time: no horizontal overflow at any viewport, no
Next.js error overlay, single H1, heading order h1 → h2 → h3, skip link
present, scene stage aspect ratio 1.544 (105/68) on desktop and tablet.
