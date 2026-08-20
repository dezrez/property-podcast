# AI & UK Property — The Daily Briefing

A desktop podcast client for the
[AI & UK Property feed](https://richiep540.github.io/ai-property-podcast/feed.xml),
built as an installable PWA so it can be packaged for the Microsoft Store.

Zero dependencies, zero build step — plain HTML, CSS and JavaScript.

---

## Why a PWA and not Electron

The Store accepts three realistic shapes for this app:

| Approach | Download size | Store route | Verdict |
|---|---|---|---|
| **PWA + PWABuilder** | ~1 MB | Officially supported; PWABuilder generates the MSIX | **Recommended** |
| Tauri | ~5 MB | MSIX via `tauri build` | Good if you refuse to host the files |
| Electron | ~200 MB | MSIX, full-trust | Overkill for a feed reader |

A packaged PWA runs inside **Edge WebView2**, which *is* Chromium — so this is
the "Chromium app" idea, minus 200 MB of bundled runtime. The trade-off is that
the packaged app points at a hosted URL, so the files must live somewhere public
(see [Publishing](#publishing-to-the-microsoft-store)).

Nothing here is framework-specific. If you later want a fully self-contained
binary with no hosting, the same files drop into Tauri or Electron unchanged.

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

## Publishing to the Microsoft Store

> **Status: not packaged.** This repository is the finished *app*. No MSIX
> exists yet, and one cannot be produced until the files are hosted and a
> Partner Center identity has been reserved. The checklist below is what stands
> between here and a live listing.

### Pre-submission checklist

| # | Item | Status |
|---|---|---|
| 1 | App built, working, verified | **Done** |
| 2 | Manifest, service worker, icons, screenshots | **Done** |
| 3 | Privacy policy page ([`privacy.html`](privacy.html)) | **Done** — needs hosting |
| 4 | Files hosted on a public HTTPS URL | **You** |
| 5 | Partner Center developer account (~£12 individual / ~£54 company) | **You** |
| 6 | App name reserved → gives Package Identity + Publisher ID | **You** |
| 7 | MSIX generated by PWABuilder using those identity values | Blocked by 4–6 |
| 8 | Age rating questionnaire, listing text, submit | Blocked by 7 |

Steps 4–6 need your account and your decisions; they cannot be done for you.

### 1. Host the files

The packaged app points at a live HTTPS URL. Any static host works; GitHub Pages
is the obvious one since the feed already lives there. Everything in this
directory is static — commit it to a repo and enable Pages, or drop it in the
existing `ai-property-podcast` repo under `/app`.

If you host it somewhere other than the site root, no change is needed: every
path in the manifest and service worker is relative.

> If you would rather not host anything, switch to Tauri instead — the same
> files get bundled into the executable, and only the feed is fetched at
> runtime.

### 2. Generate the MSIX

1. Go to [pwabuilder.com](https://www.pwabuilder.com) and enter your hosted URL.
2. Fix anything the report card flags (it should be clean — manifest, service
   worker, icons and screenshots are all in place).
3. **Package for stores → Windows**, and enter your Publisher ID and Publisher
   Display Name exactly as they appear in Partner Center.
4. Download the `.msixbundle`.

### 3. Submit

You need a **Microsoft Partner Center developer account** — a one-off fee,
roughly £12 individual / £54 company.

1. Reserve the app name in Partner Center **first** — PWABuilder needs the
   Package Identity Name, Publisher ID and Publisher Display Name from that
   reservation, and they must match exactly or the submission is rejected.
2. Create a submission and upload the `.msixbundle`.
3. **Store listing images.** Desktop screenshots must be `.png` and **1366×768
   or larger** (4K supported), under 50 MB each; at least one is required and up
   to ten are allowed. `npm run shoot` produces three at exactly 1366×768:

   | File | Shows |
   |---|---|
   | `screenshots/wide.png` | Episode list with the player |
   | `screenshots/store-2-search.png` | Search filtering and highlighting |
   | `screenshots/store-3-sort.png` | GUID sort, oldest first |

   `screenshots/narrow.png` is **540×900 and below the Store minimum** — it
   exists only for the manifest's `narrow` form factor, which feeds the
   browser's install prompt. Do not upload it to Partner Center.

   Also upload `icons/store-tile-300.png` as the **1:1 app tile icon
   (300×300)**. It is optional, but when supplied the Store prefers it over the
   icon inside the package.

   Keep important content in the top three-quarters of each screenshot — Store
   layouts can overlay text on the bottom quarter.
4. **Privacy policy URL — required.** Partner Center asks whether the app
   accesses, collects or transmits personal information. This one does not: it
   makes no network calls beyond the public feed and its audio, and everything
   it saves stays in local browser storage. Answer **No**, but still supply a
   URL — if Microsoft decides a policy was needed and none was given, the
   submission fails certification. [`privacy.html`](privacy.html) is written and
   ready; point the field at wherever you host it (e.g.
   `https://<your-site>/privacy.html`).
5. Age rating: a talk podcast with `<itunes:explicit>false</itunes:explicit>`,
   so the questionnaire should come out at 3+/PEGI 3.
6. Submit. First review typically takes 24–72 hours.

### Note on updates

The service worker uses stale-while-revalidate for the app shell: after you
redeploy, a user gets the previous build on first launch and the new one on the
next. That is deliberate — it keeps cold starts instant and offline reliable. If
you ever need to force an immediate update for everyone, bump `VERSION` in
[`sw.js`](sw.js).

You do **not** need to resubmit to the Store to ship a UI change — the MSIX is a
thin shell around the hosted URL, so redeploying the files updates the installed
app. Only manifest-level changes (name, icons, identity) need a new package.

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
