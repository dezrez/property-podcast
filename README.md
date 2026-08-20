# AI & UK Property — The Daily Briefing

A podcast client for the
[AI & UK Property feed](https://richiep540.github.io/ai-property-podcast/feed.xml).
It runs as a website and installs as a desktop app from the same files.

Zero dependencies, zero build step — plain HTML, CSS and JavaScript, 606 KB
total. Deploy it by copying the directory onto any static host.

See [Deploying to GitHub Pages](#deploying-to-github-pages).

---

## Why a PWA

It is an installable PWA rather than a bundled desktop runtime, which means one
codebase covers both the website and the desktop app:

| Approach | Size | Needs hosting | Verdict |
|---|---|---|---|
| **PWA** | ~600 KB | Yes | **In use** — installs from the browser, no store needed |
| Tauri | ~5 MB | No | Worth it only if you must ship a standalone `.exe` |
| Electron | ~200 MB | No | Overkill for a feed reader |

Installed from Edge or Chrome, a PWA gets its own window, Start-menu entry and
taskbar icon, and works offline — the things people actually want from "a
desktop app" — without shipping a browser alongside it. An installed PWA runs on
the browser's own Chromium engine, so it is a Chromium app in every practical
sense.

Nothing here is framework-specific. If you later want a self-contained binary
with no hosting, the same files drop into Tauri or Electron unchanged.

---

## Features

- **Sort by episode GUID** — ascending or descending, plus published date,
  title, and file size. GUID sorting uses natural (numeric-aware) collation, so
  it stays correct if the `episode-YYYY-MM-DD` scheme ever changes.
- **Search** — live, debounced, multi-term. Matches title, description, GUID and
  publication date, and highlights every hit. `/` focuses it, `Esc` clears it.
- **Duplicate GUID handling** — see [Feed quirks](#feed-quirks) below.
- **Player** — resume-where-you-left-off per episode, ±15s/30s skip, 0.75×–2×
  speed, volume, played markers.
- **Windows media integration** — via the Media Session API, so the episode
  title appears in the volume/media overlay and hardware media keys work.
- **Offline** — the app shell and the last good copy of the feed are cached, so
  it opens and stays browsable with no connection.
- **Light/dark/system theming**, keyboard shortcuts, and a responsive layout
  that works from 360 px up.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `/` | Focus search |
| `Esc` | Clear search |
| `Space` | Play / pause |
| `←` / `→` | Back 15s / forward 30s |
| `j` / `k` | Next / previous episode |
| `r` | Refresh the feed |

---

## Feed quirks

These are properties of the live feed, handled in the app rather than papered
over:

1. **Duplicate GUIDs.** The feed has 33 `<item>` entries but only 29 unique
   GUIDs — `episode-2026-07-20` through `episode-2026-07-23` each appear twice,
   where an episode was re-rendered and re-published under its existing GUID.
   The app keeps the entry with the latest `pubDate` per GUID and merges the
   rest. The **Merge duplicate GUIDs** toggle turns this off and labels the
   older entries `superseded`, so nothing is hidden without saying so.

2. **One broken enclosure.** The older `episode-2026-07-20` entry points at
   `github.com/richiep540/...` rather than `richiep540.github.io/...`, which
   404s. The latest-`pubDate` rule happens to discard it, but the player also
   reports a clear error if a superseded entry is played directly.

3. **Missing cover art.** The channel advertises
   `https://richiep540.github.io/ai-property-podcast/cover.jpg`, which currently
   returns **404**. The app probes it and silently keeps its own bundled icon,
   rather than rendering a broken image. Publish a real `cover.jpg` and the app
   picks it up automatically with no code change.

4. **No `itunes:duration`.** Episode length isn't in the feed. The app reads the
   true duration from the audio once an episode is loaded, caches it, and uses
   the measured bitrate to show a `~12 min` estimate for the others. Estimates
   are prefixed `~`; measured values are not.

---

## Running locally

```bash
npm start
```

Then open <http://localhost:5183>. Any static server works — there is nothing to
compile.

### Regenerating assets

```bash
npm run icons
```

Regenerates every PNG in `icons/` from the vector description in
`tools/make_icons.py`. Edit the colours or geometry there, not the PNGs.

```bash
npm run shoot
```

Recaptures the manifest screenshots in `screenshots/` (needs the server running).

### Verifying

```bash
npm run verify
```

Drives headless Edge over the DevTools protocol and asserts the feed parses,
dedupe is correct, GUID sort is an exact reverse in both directions, search
filters and highlights, artwork falls back cleanly, the service worker caches
the shell, and the app still works with the feed unreachable. 13 checks; exits
non-zero on failure.

---

## Deploying to GitHub Pages

Everything here is static — there is nothing to compile, and no server-side
anything. Pages just serves the files.

The app works identically at a domain root or inside a subdirectory: every path
in the HTML, manifest and service worker is relative, and `verify.mjs` passes
13/13 in both shapes. So you can put it wherever is convenient.

### This repository

The app lives at the root of
[`dezrez/property-podcast`](https://github.com/dezrez/property-podcast) on the
`main` branch, and publishes to:

**<https://dezrez.github.io/property-podcast/>**

To enable Pages the first time: **Settings → Pages → Build and deployment →
Source: _Deploy from a branch_ → Branch: `main`, folder `/ (root)` → Save.**
The first build takes a minute or two; after that, every push to `main` goes
live within seconds.

Deploying a change is just:

```bash
git push
```

### Notes on the Pages setup

- `.nojekyll` is committed, so Pages serves the files verbatim instead of
  running them through Jekyll.
- Pages is HTTPS by default, which the service worker and install-as-app both
  require — neither works over plain HTTP.
- The repo is public, which is what lets Pages work on a free plan. Private
  repos need GitHub Enterprise Cloud for Pages.
- `tools/` and `screenshots/` get published too. They are harmless, but if you
  would rather not serve them, move the app files into a `docs/` folder and
  switch the Pages source to `/docs`.

### Installing it as a desktop app

You do not need the Microsoft Store to get this on a desktop. Once it is hosted,
open the URL in Edge or Chrome and use **Install this site as an app** (the
install icon in the address bar). It gets its own window, its own Start-menu
entry and taskbar icon, works offline, and updates whenever you redeploy —
because the manifest, icons and service worker are all already in place.

That covers the desktop-app experience for anyone who installs it themselves.
The Store only adds public discoverability.

### If you ever do want it in the Store

Nothing here needs changing — a hosted, installable PWA is exactly what
[PWABuilder](https://www.pwabuilder.com) packages. You would need a Partner
Center developer account (~£12 individual / ~£54 company), a reserved app name
to get the Package Identity and Publisher ID, and a hosted privacy policy —
[`privacy.html`](privacy.html) is already written for that purpose. Store
desktop screenshots must be 1366×768 or larger; `npm run shoot` produces three
at that size, and `icons/store-tile-300.png` is the 300×300 listing tile.

### Note on updates

The service worker uses stale-while-revalidate for the app shell: after you
redeploy, a user gets the previous build on first launch and the new one on the
next. That is deliberate — it keeps cold starts instant and offline reliable. If
you ever need to force an immediate update for everyone, bump `VERSION` in
[`sw.js`](sw.js).

---
## Layout

```
index.html                 markup and the player chrome
app.css                    all styling; theme tokens at the top
app.js                     feed parsing, dedupe, search, sort, player
privacy.html               privacy policy — must be hosted for submission
manifest.webmanifest       PWA/Store metadata
sw.js                      offline caching
icons/                     generated — do not edit by hand
screenshots/               generated — manifest and Store listing
tools/make_icons.py        icon generator (pure Python, no deps)
tools/shoot.mjs            screenshot capture over CDP
tools/verify.mjs           end-to-end checks
```

### Pointing it at a different feed

Change `FEED_URL` at the top of [`app.js`](app.js) and `FEED_HOST` in
[`sw.js`](sw.js). The parser is standard RSS 2.0 with `<enclosure>`, so any
podcast feed works — though the dedupe rule assumes GUID collisions mean
"re-published", which is not true of every feed.

The feed must send `Access-Control-Allow-Origin` (GitHub Pages sends `*`), since
the app fetches it directly from the browser with no backend.
