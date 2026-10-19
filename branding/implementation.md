# CodaiPro implementation notes

**Status: applied.** The brand kit is live across the website, browser UI,
desktop app, installer, executable, tray icon, and README. This document is
kept as the deployment checklist and record of how each surface was wired.

## Website navbar and favicon

1. Place `final/logo-primary.svg` in the site's publicly served asset directory. Where the masthead currently uses text (`website/index.html`, `.wordmark`), use a normal accessible `<img>` link after approving a web-specific change.
2. Place `final/favicon.svg` and optionally `final/png/favicon-16.png`, `final/png/favicon-32.png`, `final/png/favicon-48.png` in the served web root.
3. Replace the existing data-URI favicon only when a release/update is authorized:

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
```

**Important:** for GitHub Pages under `/Codaipro/`, do not use root-absolute `/favicon.svg`; use site-relative paths such as `favicon.svg` or the configured base URL. Copy the correct files at that stage. SVG may have a caching delay in browsers; clear caches after deployment.

## PWA icons (where supported)

Place `final/png/app-icon-192.png` and `final/png/app-icon-512.png` in the public folder, and reference the paths in the web app manifest, matching the deploy base path:

```json
{
  "name": "CodaiPro",
  "short_name": "CodaiPro",
  "icons": [
    { "src": "app-icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "app-icon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "theme_color": "#C23A24",
  "background_color": "#F6F4EE",
  "display": "standalone"
}
```

This manifest is an example; it should be integrated with the existing PWA configuration rather than blindly replacing it.

## Windows desktop app

- The repository currently includes `ui/codai.ico`, `ui/logo.ico`, and `ui/logo.png`. Review all actual UI, tray, installer, executable, and Start menu icon references before any replacement. Do not delete the originals until complete rebuild/testing.
- Configure the app packaging tool to embed `final/app-icon.ico` into the executable. Point the desktop app UI header and any tray icon to the appropriate `final/png/app-icon-32.png` or other platform-size asset.
- Test Windows 10 and 11; explicitly verify Explorer file icon, taskbar, Start menu, pinned shortcuts, installer, and high-DPI behavior. Windows icon caches can delay appearance of changes.
- The `app-icon.ico` carries embedded 16/24/32/48/64/128/256 frames. Icon frames use 32-bit BGRA/BMP through 128px and PNG at 256px.

## Dark mode

Use `logo-dark.svg` on #1E1E1E or similar surfaces, never `logo-primary.svg` without checking contrast. Use `logo-symbol-dark.svg` where only an icon is wanted on dark surfaces, and the flat red tile `app-icon.svg` where theme-independent launcher presentation is needed.

## Assets and filenames

- `final/`: original SVGs, source platform icon, Windows ICO.
- `final/png/`: raster icons at native output sizes and preview PNGs.
- `source/`: editable type reference and construction notes.
- `previews/`: review mockups.

Before going live, validate all reference paths on a staging URL or release build, not the production site. Do not make production changes without separate approval.
