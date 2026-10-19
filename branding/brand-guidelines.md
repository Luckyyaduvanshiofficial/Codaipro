# CodaiPro · Brand guidelines (approved concept A)

## Positioning
Offline-first, independent AI assistance for coding on local PCs, including older Windows computers. The identity communicates a protected working space through two complementary offset returns. Do not introduce AI brains, sparkles, terminal brackets, gradient gloss, or decorative detail.

## Naming and type
Brand lockup: **CodaiPro**, matching the currently published website masthead. The app/repo also use “Codai Pro” in prose. Written name can remain “Codai Pro” in sentences if desired, but use the official outlined lockup for primary branding. The wordmark letterforms were outlined from **Inter Display SemiBold**, developed by the Inter Project Authors; font distributed under SIL OFL 1.1 and Apache 2.0 (see https://github.com/rsms/inter). One distinctive adjustment: the dot of the `i` is a custom diagonal quadrilateral. The delivered wordmark uses paths and requires no installed font. The editable text reference in `source/` is for designers only and may render differently if Inter is absent. No font binaries are bundled.

## Colors
| Role | HEX | Usage |
|---|---|---|
| Warm red | `#C23A24` | Master icon and brand accent on light ground |
| Coral adjustment | `#E66C55` | Symbol and i dot on dark ground |
| Ink | `#26221B` | Primary wordmark / dark monochrome |
| Paper | `#F6F4EE` | Cream light surfaces / white on dark |
| Desktop dark | `#1E1E1E` | Dark website/app sample only |

**Contrast ratios, computed using WCAG 2 relative luminance:** red on paper **4.87:1**, coral on desktop dark **5.27:1**, ink on paper **14.39:1**, paper on dark **15.16:1**, paper on red **4.87:1**. Ratios measure filled colors; not a guarantee of WCAG compliance for every use, especially pixel edge antialiasing.

## How to use
- `logo-primary.svg` or `logo-light.svg`: website navbar, documentation, printed light surfaces.
- `logo-dark.svg`: dark website, Windows desktop app dark header. Do not put normal red on dark; use coral adjustment.
- `logo-monochrome.svg` / reversed: engraving, single ink/foil, low-color documents.
- `logo-symbol.svg`: standalone symbol, with transparent background; do not forcibly add the tile in the primary wordmark.
- `favicon.svg`, `app-icon.svg`, `app-icon.ico`, raster app icons: flat red app tile and warm-white mark to preserve visibility across desktop themes.
- For 16px and 24px display use icon **without** the wordmark. The favicon/small icon uses the optically enlarged square counter.
- **Clear space:** at least 14% of the symbol viewBox as unobstructed padding where practical; for the horizontal lockup leave at least the x-height of lowercase letters around all sides.
- **Minimum lockup height:** 32px in UI when physically possible; the wordmark should not be stretched or separately scaled.
- Never add drop shadows, 3D depth, separate-colored corners, decorative badges or altered rotations to the mark. Never place red-on-red, coral-on-white or charcoal-on-black without contrast testing.

## Exports and cross-platform use
- Vector paths are plain SVG 1.1, no filters or references.
- PNGs exported directly at each target resolution from vector source, not from a resized bitmap.
- ICO includes **16, 24, 32, 48, 64, 128, 256**, using 32-bit BMP data through 128px and PNG 256px.
- For Windows app packaging, replace only the icon configuration with `app-icon.ico` after a separate change-approval step. Use your packaging tool’s native icon configuration; this package does not edit the repository.
- Use `favicon.svg` plus `png/favicon-16.png`, `png/favicon-32.png`, `png/favicon-48.png`; add `png/apple-touch-icon.png`, `png/app-icon-192.png` and `png/app-icon-512.png` for mobile and PWA.
- Check Windows high-DPI taskbar, Start Menu, installer and notifications on actual Windows 10/11 before publishing.

## Legal and originality
Codaipro’s own approved direction has been refined, not adapted from competitor SVGs. Geometric offset squares/frames are common in technology, so there is **residual conceptual similarity risk** even after adjusting the join weights and silhouette. Review against the visual marks of Cursor, Continue, Cline, Windsurf, VS Code, and LM Studio, and commission formal legal/trademark clearance for your target markets before registration or high-stakes deployment. Neither this package nor desk research guarantees originality or trademark availability.
