/* AI & UK Property — The Daily Briefing
 * Standalone podcast client. No dependencies, no build step.
 */
(function () {
  'use strict';

  var FEED_URL = 'https://richiep540.github.io/ai-property-podcast/feed.xml';
  var CACHE_KEY = 'feed.xml.v1';
  var CACHE_AT_KEY = 'feed.fetchedAt.v1';
  var PREFS_KEY = 'prefs.v1';
  var PROGRESS_KEY = 'progress.v1';
  var DURATIONS_KEY = 'durations.v1';
  var SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

  // ---------------------------------------------------------------- storage

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* quota or private mode — non-fatal */
    }
  }

  var prefs = load(PREFS_KEY, {});
  if (typeof prefs !== 'object' || prefs === null) prefs = {};
  if (!prefs.sort) prefs.sort = 'guid-desc';
  if (typeof prefs.dedupe !== 'boolean') prefs.dedupe = true;
  if (typeof prefs.volume !== 'number') prefs.volume = 1;
  if (typeof prefs.rate !== 'number') prefs.rate = 1;
  if (!prefs.theme) prefs.theme = 'system';

  var progress = load(PROGRESS_KEY, {});     // key -> { t: seconds, d: duration, done: bool }
  var durations = load(DURATIONS_KEY, {});   // enclosure url -> seconds

  function savePrefs() { save(PREFS_KEY, prefs); }
  function saveProgress() { save(PROGRESS_KEY, progress); }

  // ---------------------------------------------------------------- helpers

  var $ = function (id) { return document.getElementById(id); };

  function stripHtml(str) {
    if (!str) return '';
    if (str.indexOf('<') === -1 && str.indexOf('&') === -1) return str.trim();
    try {
      var doc = new DOMParser().parseFromString(str, 'text/html');
      return (doc.body.textContent || '').trim();
    } catch (e) {
      return str.trim();
    }
  }

  function formatBytes(n) {
    if (!n || n < 0) return '';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function formatClock(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var mm = h > 0 && m < 10 ? '0' + m : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + (s < 10 ? '0' + s : s);
  }

  function formatMins(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    var m = Math.round(sec / 60);
    return m < 1 ? '<1 min' : m + ' min';
  }

  var dateFmt = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  });
  var timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

  function formatDate(d) {
    return d ? dateFmt.format(d) : 'Unknown date';
  }

  function relative(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' h ago';
    return timeFmt.format(new Date(ts)) + ', ' + dateFmt.format(new Date(ts));
  }

  // ------------------------------------------------------------ feed parsing

  var show = { title: 'AI & UK Property', subtitle: 'The Daily Briefing', image: '' };
  var allEpisodes = [];  // every <item>, in feed order
  var episodes = [];     // after dedupe — what the list works from

  function text(parent, tag) {
    var el = parent.getElementsByTagName(tag)[0];
    return el ? (el.textContent || '').trim() : '';
  }

  function parseFeed(xml) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('The feed is not valid XML.');
    }
    var channel = doc.getElementsByTagName('channel')[0];
    if (!channel) throw new Error('No <channel> found in the feed.');

    var chTitle = text(channel, 'title');
    if (chTitle) {
      // "AI & UK Property: The Daily Briefing" -> two lines
      var split = chTitle.split(/:\s*/);
      show.title = split[0] || chTitle;
      show.subtitle = split.length > 1 ? split.slice(1).join(': ') : text(channel, 'description');
    }
    var img = channel.getElementsByTagName('image')[0];
    if (img) show.image = text(img, 'url');
    if (!show.image) {
      var it = channel.getElementsByTagName('itunes:image')[0] ||
               channel.getElementsByTagName('image')[0];
      if (it && it.getAttribute) show.image = it.getAttribute('href') || '';
    }

    var items = channel.getElementsByTagName('item');
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var enc = item.getElementsByTagName('enclosure')[0];
      var url = enc ? enc.getAttribute('url') || '' : '';
      var pubRaw = text(item, 'pubDate');
      var parsed = pubRaw ? new Date(pubRaw) : null;
      if (parsed && isNaN(parsed.getTime())) parsed = null;

      var guid = text(item, 'guid');
      out.push({
        index: i,
        guid: guid,
        title: stripHtml(text(item, 'title')) || 'Untitled episode',
        description: stripHtml(text(item, 'description')),
        url: url,
        bytes: enc ? parseInt(enc.getAttribute('length') || '0', 10) || 0 : 0,
        type: enc ? enc.getAttribute('type') || 'audio/mpeg' : 'audio/mpeg',
        date: parsed,
        pubRaw: pubRaw,
        key: guid + '|' + url,
        dupCount: 1,
        isSupersededDup: false
      });
    }
    return out;
  }

  /* This feed republishes some episodes under an existing GUID (e.g. four of
     episode-2026-07-2x), and one stale entry points at a github.com URL that
     404s. Keep the newest pubDate per GUID and flag the rest. */
  function applyDedupe(list) {
    var byGuid = {};
    var i, ep;
    for (i = 0; i < list.length; i++) {
      ep = list[i];
      var g = ep.guid || ('__no-guid-' + ep.index);
      (byGuid[g] = byGuid[g] || []).push(ep);
    }

    var kept = [];
    for (var g2 in byGuid) {
      if (!Object.prototype.hasOwnProperty.call(byGuid, g2)) continue;
      var group = byGuid[g2];
      for (i = 0; i < group.length; i++) {
        group[i].dupCount = group.length;
        group[i].isSupersededDup = false;
      }
      if (group.length === 1) { kept.push(group[0]); continue; }

      var best = group[0];
      for (i = 1; i < group.length; i++) {
        var a = group[i], bt = best.date ? best.date.getTime() : -Infinity;
        var at = a.date ? a.date.getTime() : -Infinity;
        // newest pubDate wins; on a tie prefer the earlier feed position
        if (at > bt) best = a;
      }
      for (i = 0; i < group.length; i++) {
        if (group[i] !== best) group[i].isSupersededDup = true;
      }
      kept.push(best);
    }
    return kept;
  }

  function rebuild() {
    episodes = prefs.dedupe ? applyDedupe(allEpisodes) : allEpisodes.slice();
    render();
    handleLaunchIntent();
  }

  /* Jump-list / shortcut entry point: index.html?play=latest */
  var launchHandled = false;
  function handleLaunchIntent() {
    if (launchHandled || !episodes.length) return;
    var intent;
    try {
      intent = new URLSearchParams(window.location.search).get('play');
    } catch (e) {
      return;
    }
    if (intent !== 'latest') { launchHandled = true; return; }
    launchHandled = true;
    var newest = episodes.slice().sort(SORTERS['date-desc'])[0];
    if (newest) loadEpisode(newest, true);
  }

  // -------------------------------------------------------- duration guessing

  function knownDuration(ep) {
    var d = durations[ep.url];
    return typeof d === 'number' && d > 0 ? d : 0;
  }

  var bytesPerSecond = 0;
  function recomputeBitrate() {
    var total = 0, secs = 0;
    for (var i = 0; i < allEpisodes.length; i++) {
      var ep = allEpisodes[i], d = knownDuration(ep);
      if (d > 0 && ep.bytes > 0) { total += ep.bytes; secs += d; }
    }
    bytesPerSecond = secs > 0 ? total / secs : 0;
  }

  function estimateDuration(ep) {
    var known = knownDuration(ep);
    if (known) return { seconds: known, exact: true };
    if (bytesPerSecond > 0 && ep.bytes > 0) {
      return { seconds: ep.bytes / bytesPerSecond, exact: false };
    }
    return { seconds: 0, exact: false };
  }

  // ------------------------------------------------------------ search / sort

  function tokenize(q) {
    return q.toLowerCase().split(/\s+/).filter(function (t) { return t.length > 0; });
  }

  function matches(ep, tokens) {
    if (!tokens.length) return true;
    var hay = (ep.title + ' ' + ep.description + ' ' + ep.guid + ' ' + ep.pubRaw).toLowerCase();
    for (var i = 0; i < tokens.length; i++) {
      if (hay.indexOf(tokens[i]) === -1) return false;
    }
    return true;
  }

  var collator = new Intl.Collator('en-GB', { numeric: true, sensitivity: 'base' });

  var SORTERS = {
    'guid-desc': function (a, b) { return collator.compare(b.guid, a.guid) || byDate(b, a); },
    'guid-asc':  function (a, b) { return collator.compare(a.guid, b.guid) || byDate(a, b); },
    'date-desc': function (a, b) { return byDate(b, a) || collator.compare(b.guid, a.guid); },
    'date-asc':  function (a, b) { return byDate(a, b) || collator.compare(a.guid, b.guid); },
    'title-asc': function (a, b) { return collator.compare(a.title, b.title) || byDate(b, a); },
    'title-desc': function (a, b) { return collator.compare(b.title, a.title) || byDate(b, a); },
    'size-desc': function (a, b) { return (b.bytes - a.bytes) || byDate(b, a); },
    'size-asc':  function (a, b) { return (a.bytes - b.bytes) || byDate(a, b); }
  };

  function byDate(a, b) {
    var at = a.date ? a.date.getTime() : 0;
    var bt = b.date ? b.date.getTime() : 0;
    return at - bt;
  }

  // ---------------------------------------------------------------- rendering

  var listEl = $('list');
  var searchEl = $('search');
  var currentQuery = '';
  var currentKey = null;   // key of the loaded episode

  function highlight(str, tokens) {
    var frag = document.createDocumentFragment();
    if (!tokens.length || !str) {
      frag.appendChild(document.createTextNode(str || ''));
      return frag;
    }
    // find every token hit, merge overlaps, then emit text/<mark> runs
    var lower = str.toLowerCase();
    var hits = [];
    for (var i = 0; i < tokens.length; i++) {
      var from = 0, at;
      while ((at = lower.indexOf(tokens[i], from)) !== -1) {
        hits.push([at, at + tokens[i].length]);
        from = at + tokens[i].length;
      }
    }
    if (!hits.length) {
      frag.appendChild(document.createTextNode(str));
      return frag;
    }
    hits.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [hits[0]];
    for (i = 1; i < hits.length; i++) {
      var last = merged[merged.length - 1];
      if (hits[i][0] <= last[1]) last[1] = Math.max(last[1], hits[i][1]);
      else merged.push(hits[i]);
    }
    var pos = 0;
    for (i = 0; i < merged.length; i++) {
      if (merged[i][0] > pos) {
        frag.appendChild(document.createTextNode(str.slice(pos, merged[i][0])));
      }
      var mark = document.createElement('mark');
      mark.textContent = str.slice(merged[i][0], merged[i][1]);
      frag.appendChild(mark);
      pos = merged[i][1];
    }
    if (pos < str.length) frag.appendChild(document.createTextNode(str.slice(pos)));
    return frag;
  }

  function svg(pathD, opts) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', pathD);
    s.appendChild(p);
    if (opts && opts.filled) { s.style.fill = 'currentColor'; s.style.stroke = 'none'; }
    return s;
  }

  var ICON_PLAY = 'M7 4.5v15l13-7.5Z';
  var ICON_PAUSE = 'M7 4h4v16H7zM13 4h4v16h-4z';
  var ICON_COPY = 'M10 13.5a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.7L11.3 6.8M14 10.5a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7';
  var ICON_DOWNLOAD = 'M12 4v10m0 0 4-4m-4 4-4-4M4 18h16';

  function buildEpisode(ep, tokens) {
    var card = document.createElement('article');
    card.className = 'ep';
    card.dataset.key = ep.key;
    if (ep.key === currentKey) card.classList.add('playing');

    // play button
    var playBtn = document.createElement('button');
    playBtn.className = 'ep-play';
    playBtn.type = 'button';
    var isCurrent = ep.key === currentKey;
    playBtn.appendChild(svg(isCurrent && !audio.paused ? ICON_PAUSE : ICON_PLAY, { filled: true }));
    playBtn.setAttribute('aria-label', (isCurrent && !audio.paused ? 'Pause ' : 'Play ') + ep.title);
    playBtn.addEventListener('click', function () { toggleEpisode(ep); });
    card.appendChild(playBtn);

    // main
    var main = document.createElement('div');
    main.className = 'ep-main';

    var h = document.createElement('h2');
    h.className = 'ep-title';
    h.appendChild(highlight(ep.title, tokens));
    main.appendChild(h);

    if (ep.description) {
      var p = document.createElement('p');
      p.className = 'ep-desc';
      p.appendChild(highlight(ep.description, tokens));
      main.appendChild(p);
    }

    var meta = document.createElement('div');
    meta.className = 'ep-meta';

    var guidEl = document.createElement('span');
    guidEl.className = 'guid';
    guidEl.title = 'Episode GUID';
    guidEl.appendChild(highlight(ep.guid || '(no guid)', tokens));
    meta.appendChild(guidEl);

    function addMeta(str, title) {
      if (!str) return;
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '·';
      meta.appendChild(dot);
      var s = document.createElement('span');
      s.textContent = str;
      if (title) s.title = title;
      meta.appendChild(s);
    }

    addMeta(formatDate(ep.date), ep.pubRaw);

    var est = estimateDuration(ep);
    if (est.seconds > 0) {
      addMeta((est.exact ? '' : '~') + formatMins(est.seconds),
        est.exact ? 'Measured length' : 'Estimated from file size');
    }
    addMeta(formatBytes(ep.bytes));

    if (ep.dupCount > 1) {
      var tag = document.createElement('span');
      tag.className = 'tag dup';
      if (ep.isSupersededDup) {
        tag.textContent = 'superseded';
        tag.title = 'An entry with the same GUID was published later in the feed.';
      } else {
        tag.textContent = ep.dupCount + ' versions';
        tag.title = 'This GUID appears ' + ep.dupCount + ' times in the feed. ' +
          'Showing the most recently published version.';
      }
      meta.appendChild(tag);
    }

    var prog = progress[ep.key];
    if (prog && prog.done) {
      var doneTag = document.createElement('span');
      doneTag.className = 'tag done';
      doneTag.textContent = 'played';
      meta.appendChild(doneTag);
    }

    main.appendChild(meta);
    card.appendChild(main);

    // side
    var side = document.createElement('div');
    side.className = 'ep-side';

    var actions = document.createElement('div');
    actions.className = 'ep-actions';

    var copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn';
    copyBtn.type = 'button';
    copyBtn.title = 'Copy audio link';
    copyBtn.setAttribute('aria-label', 'Copy audio link');
    copyBtn.appendChild(svg(ICON_COPY));
    copyBtn.addEventListener('click', function () {
      if (navigator.clipboard && ep.url) {
        navigator.clipboard.writeText(ep.url).then(function () {
          setStatus('Link copied', false, 2000);
        }, function () { setStatus('Could not copy', true, 2500); });
      }
    });
    actions.appendChild(copyBtn);

    if (ep.url) {
      var dl = document.createElement('a');
      dl.className = 'icon-btn';
      dl.href = ep.url;
      dl.setAttribute('download', '');
      dl.rel = 'noopener';
      dl.title = 'Download MP3';
      dl.setAttribute('aria-label', 'Download ' + ep.title);
      dl.appendChild(svg(ICON_DOWNLOAD));
      actions.appendChild(dl);
    }
    side.appendChild(actions);

    if (prog && prog.t > 5 && prog.d > 0 && !prog.done) {
      var bar = document.createElement('div');
      bar.className = 'progress';
      bar.title = formatClock(prog.t) + ' of ' + formatClock(prog.d);
      var fill = document.createElement('span');
      fill.style.width = Math.min(100, (prog.t / prog.d) * 100).toFixed(1) + '%';
      bar.appendChild(fill);
      side.appendChild(bar);
    }

    card.appendChild(side);
    return card;
  }

  function render() {
    var tokens = tokenize(currentQuery);
    var visible = episodes.filter(function (ep) { return matches(ep, tokens); });
    visible.sort(SORTERS[prefs.sort] || SORTERS['guid-desc']);

    listEl.textContent = '';

    if (!visible.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      var h2 = document.createElement('h2');
      var p = document.createElement('p');
      if (!allEpisodes.length) {
        h2.textContent = 'No episodes loaded';
        p.textContent = 'The feed could not be read. Check your connection and try again.';
      } else {
        h2.textContent = 'No matches';
        p.textContent = 'Nothing matches “' + currentQuery + '”.';
      }
      empty.appendChild(h2);
      empty.appendChild(p);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = allEpisodes.length ? 'Clear search' : 'Retry';
      btn.addEventListener('click', function () {
        if (allEpisodes.length) { setQuery(''); } else { refresh(true); }
      });
      empty.appendChild(btn);
      listEl.appendChild(empty);
    } else {
      var frag = document.createDocumentFragment();
      for (var i = 0; i < visible.length; i++) {
        frag.appendChild(buildEpisode(visible[i], tokens));
      }
      listEl.appendChild(frag);
    }

    var total = episodes.length;
    var hidden = allEpisodes.length - episodes.length;
    var label = visible.length === total
      ? total + ' episode' + (total === 1 ? '' : 's')
      : visible.length + ' of ' + total;
    if (prefs.dedupe && hidden > 0) label += ' · ' + hidden + ' duplicate' + (hidden === 1 ? '' : 's') + ' merged';
    $('count').textContent = label;

    $('showTitle').textContent = show.title;
    $('showSubtitle').textContent = show.subtitle;
    applyArtwork();
  }

  /* The feed advertises cover.jpg, which currently 404s. Only swap in the
     remote artwork once it has actually decoded; otherwise keep the bundled
     icon so the app never shows a broken image. */
  var artworkState = 'pending';
  function applyArtwork() {
    if (artworkState !== 'pending' || !show.image) return;
    artworkState = 'loading';
    var probe = new Image();
    probe.onload = function () {
      artworkState = 'ok';
      $('brandArt').src = show.image;
      $('npArt').src = show.image;
    };
    probe.onerror = function () {
      artworkState = 'failed';
      show.image = '';  // keep it out of the Media Session artwork too
    };
    probe.src = show.image;
  }

  // ------------------------------------------------------------------- status

  var statusEl = $('status');
  var statusTimer = null;
  function setStatus(msg, isError, clearAfter) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('err', !!isError);
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    if (clearAfter) {
      statusTimer = setTimeout(function () { showLastUpdated(); }, clearAfter);
    }
  }

  function showLastUpdated() {
    var at = load(CACHE_AT_KEY, 0);
    if (!navigator.onLine) { setStatus('Offline · cached', true); return; }
    setStatus(at ? 'Updated ' + relative(at) : '');
  }

  // -------------------------------------------------------------------- fetch

  var refreshing = false;

  function refresh(force) {
    if (refreshing) return Promise.resolve();
    refreshing = true;
    $('refreshBtn').classList.add('spin');
    setStatus('Refreshing…');

    return fetch(FEED_URL, { cache: force ? 'reload' : 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (xml) {
        var parsed = parseFeed(xml);
        allEpisodes = parsed;
        save(CACHE_KEY, xml);
        save(CACHE_AT_KEY, Date.now());
        recomputeBitrate();
        rebuild();
        showLastUpdated();
      })
      .catch(function (err) {
        var cached = load(CACHE_KEY, null);
        if (cached && !allEpisodes.length) {
          try {
            allEpisodes = parseFeed(cached);
            recomputeBitrate();
            rebuild();
          } catch (e) { /* cache unusable */ }
        }
        setStatus(navigator.onLine ? 'Update failed · ' + err.message : 'Offline · cached', true);
        if (!allEpisodes.length) render();
      })
      .then(function () {
        refreshing = false;
        $('refreshBtn').classList.remove('spin');
      });
  }

  function bootFromCache() {
    var cached = load(CACHE_KEY, null);
    if (!cached) {
      listEl.textContent = '';
      for (var i = 0; i < 6; i++) {
        var sk = document.createElement('div');
        sk.className = 'skeleton';
        listEl.appendChild(sk);
      }
      return;
    }
    try {
      allEpisodes = parseFeed(cached);
      recomputeBitrate();
      rebuild();
      showLastUpdated();
    } catch (e) { /* fall through to network */ }
  }

  // ------------------------------------------------------------------- player

  var audio = $('audio');
  var playerEl = $('player');
  var seekEl = $('seek');
  var seeking = false;

  audio.volume = prefs.volume;
  audio.playbackRate = prefs.rate;
  $('volume').value = prefs.volume;
  $('speedBtn').textContent = prefs.rate + '×';

  function findEpisode(key) {
    for (var i = 0; i < allEpisodes.length; i++) {
      if (allEpisodes[i].key === key) return allEpisodes[i];
    }
    return null;
  }

  function currentEpisode() {
    return currentKey ? findEpisode(currentKey) : null;
  }

  function loadEpisode(ep, autoplay) {
    if (!ep.url) { setStatus('That episode has no audio URL', true, 3000); return; }
    currentKey = ep.key;
    audio.src = ep.url;
    audio.load();

    var saved = progress[ep.key];
    if (saved && saved.t > 5 && !saved.done) {
      var resumeTo = saved.t;
      audio.addEventListener('loadedmetadata', function once() {
        audio.removeEventListener('loadedmetadata', once);
        if (isFinite(audio.duration) && resumeTo < audio.duration - 10) {
          audio.currentTime = resumeTo;
        }
      });
    }

    playerEl.hidden = false;
    document.body.classList.remove('no-player');
    $('npTitle').textContent = ep.title;
    $('npTitle').title = ep.title;
    prefs.lastKey = ep.key;
    savePrefs();

    updateMediaSession(ep);
    render();

    if (autoplay) {
      var p = audio.play();
      if (p && p.catch) p.catch(function () { /* autoplay blocked */ });
    }
  }

  function toggleEpisode(ep) {
    if (currentKey === ep.key) {
      if (audio.paused) {
        var p = audio.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        audio.pause();
      }
    } else {
      loadEpisode(ep, true);
    }
  }

  function updateMediaSession(ep) {
    if (!('mediaSession' in navigator)) return;
    try {
      var art = show.image
        ? [{ src: show.image, sizes: '512x512', type: 'image/jpeg' }]
        : [
            { src: new URL('icons/icon-192.png', location.href).href, sizes: '192x192', type: 'image/png' },
            { src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }
          ];
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: ep.title,
        artist: show.title,
        album: show.subtitle,
        artwork: art
      });
    } catch (e) { /* MediaMetadata unsupported */ }
  }

  if ('mediaSession' in navigator) {
    var ms = navigator.mediaSession;
    var setHandler = function (action, fn) {
      try { ms.setActionHandler(action, fn); } catch (e) { /* unsupported action */ }
    };
    setHandler('play', function () { audio.play(); });
    setHandler('pause', function () { audio.pause(); });
    setHandler('seekbackward', function () { nudge(-15); });
    setHandler('seekforward', function () { nudge(30); });
    setHandler('previoustrack', function () { step(-1); });
    setHandler('nexttrack', function () { step(1); });
    setHandler('seekto', function (details) {
      if (details && typeof details.seekTime === 'number') audio.currentTime = details.seekTime;
    });
  }

  function nudge(delta) {
    if (!isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + delta));
  }

  /* Move through the list as it is currently sorted and filtered. */
  function step(delta) {
    var tokens = tokenize(currentQuery);
    var visible = episodes.filter(function (e) { return matches(e, tokens); });
    visible.sort(SORTERS[prefs.sort] || SORTERS['guid-desc']);
    if (!visible.length) return;
    var idx = -1;
    for (var i = 0; i < visible.length; i++) {
      if (visible[i].key === currentKey) { idx = i; break; }
    }
    var next = visible[idx + delta];
    if (next) loadEpisode(next, true);
  }

  function persistPosition() {
    if (!currentKey || !isFinite(audio.duration) || audio.duration <= 0) return;
    var done = audio.currentTime / audio.duration > 0.95;
    progress[currentKey] = { t: done ? 0 : audio.currentTime, d: audio.duration, done: done };
    saveProgress();
  }

  var lastPersist = 0;

  audio.addEventListener('timeupdate', function () {
    var cur = audio.currentTime, dur = audio.duration;
    $('npTime').textContent = formatClock(cur) + ' / ' + (isFinite(dur) ? formatClock(dur) : '--:--');
    if (!seeking && isFinite(dur) && dur > 0) {
      seekEl.value = String(Math.round((cur / dur) * 1000));
    }
    if (Date.now() - lastPersist > 4000) {
      lastPersist = Date.now();
      persistPosition();
    }
  });

  audio.addEventListener('loadedmetadata', function () {
    var ep = currentEpisode();
    if (ep && isFinite(audio.duration) && audio.duration > 0) {
      if (durations[ep.url] !== audio.duration) {
        durations[ep.url] = audio.duration;
        save(DURATIONS_KEY, durations);
        recomputeBitrate();
        render();
      }
    }
  });

  audio.addEventListener('play', function () {
    document.body.classList.add('playing');
    $('playPause').setAttribute('aria-label', 'Pause');
    render();
  });

  audio.addEventListener('pause', function () {
    document.body.classList.remove('playing');
    $('playPause').setAttribute('aria-label', 'Play');
    persistPosition();
    render();
  });

  audio.addEventListener('ended', function () {
    if (currentKey) {
      progress[currentKey] = { t: 0, d: audio.duration || 0, done: true };
      saveProgress();
    }
    step(1);
  });

  audio.addEventListener('error', function () {
    var ep = currentEpisode();
    setStatus('Could not play' + (ep && ep.isSupersededDup ? ' (superseded entry)' : ''), true, 5000);
  });

  $('playPause').addEventListener('click', function () {
    if (audio.paused) { audio.play(); } else { audio.pause(); }
  });
  $('back15').addEventListener('click', function () { nudge(-15); });
  $('fwd30').addEventListener('click', function () { nudge(30); });

  seekEl.addEventListener('input', function () {
    seeking = true;
    if (isFinite(audio.duration)) {
      $('npTime').textContent = formatClock((seekEl.value / 1000) * audio.duration) +
        ' / ' + formatClock(audio.duration);
    }
  });
  seekEl.addEventListener('change', function () {
    if (isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = (seekEl.value / 1000) * audio.duration;
    }
    seeking = false;
  });

  $('volume').addEventListener('input', function () {
    audio.volume = parseFloat(this.value);
    prefs.volume = audio.volume;
    savePrefs();
  });

  $('speedBtn').addEventListener('click', function () {
    var i = SPEEDS.indexOf(prefs.rate);
    prefs.rate = SPEEDS[(i + 1) % SPEEDS.length];
    audio.playbackRate = prefs.rate;
    this.textContent = prefs.rate + '×';
    savePrefs();
  });

  $('closePlayer').addEventListener('click', function () {
    audio.pause();
    persistPosition();
    playerEl.hidden = true;
    document.body.classList.add('no-player');
    currentKey = null;
    delete prefs.lastKey;
    savePrefs();
    render();
  });

  // ------------------------------------------------------------------ controls

  function setQuery(q) {
    currentQuery = q;
    searchEl.value = q;
    $('clearSearch').hidden = !q;
    render();
  }

  var searchTimer = null;
  searchEl.addEventListener('input', function () {
    var value = this.value;
    $('clearSearch').hidden = !value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      currentQuery = value;
      render();
    }, 120);
  });

  $('clearSearch').addEventListener('click', function () {
    setQuery('');
    searchEl.focus();
  });

  var sortEl = $('sort');
  sortEl.value = prefs.sort;
  if (sortEl.selectedIndex === -1) { sortEl.value = 'guid-desc'; prefs.sort = 'guid-desc'; }
  sortEl.addEventListener('change', function () {
    prefs.sort = this.value;
    savePrefs();
    render();
  });

  var dedupeEl = $('dedupe');
  dedupeEl.checked = prefs.dedupe;
  dedupeEl.addEventListener('change', function () {
    prefs.dedupe = this.checked;
    savePrefs();
    rebuild();
  });

  $('refreshBtn').addEventListener('click', function () { refresh(true); });

  // theme: system -> dark -> light -> system
  function applyTheme() {
    var t = prefs.theme;
    if (t === 'system') {
      var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', t);
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content',
        document.documentElement.getAttribute('data-theme') === 'dark' ? '#0d1117' : '#f6f7f9');
    }
    $('themeBtn').title = 'Theme: ' + prefs.theme + ' (click to change)';
  }

  $('themeBtn').addEventListener('click', function () {
    prefs.theme = prefs.theme === 'system' ? 'dark' : prefs.theme === 'dark' ? 'light' : 'system';
    savePrefs();
    applyTheme();
    setStatus('Theme: ' + prefs.theme, false, 1800);
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (prefs.theme === 'system') applyTheme();
  });

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

    if (e.key === '/' && !typing) { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
    if (e.key === 'Escape') {
      if (typing && tag === 'input') { setQuery(''); searchEl.blur(); }
      return;
    }
    if (typing) return;

    if (e.key === ' ') {
      if (!currentKey) return;
      e.preventDefault();
      if (audio.paused) { audio.play(); } else { audio.pause(); }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault(); nudge(-15);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault(); nudge(30);
    } else if (e.key === 'r' || e.key === 'R') {
      refresh(true);
    } else if (e.key === 'j') {
      step(1);
    } else if (e.key === 'k') {
      step(-1);
    }
  });

  window.addEventListener('online', function () { showLastUpdated(); refresh(false); });
  window.addEventListener('offline', function () { showLastUpdated(); });
  window.addEventListener('pagehide', persistPosition);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') persistPosition();
  });

  /* The player bar wraps to a second row on narrow windows, so its height is
     not fixed. Keep the list's bottom padding in step with it. */
  function syncPlayerHeight() {
    var h = playerEl.hidden ? 0 : playerEl.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--player-h', Math.round(h) + 'px');
  }
  if (window.ResizeObserver) {
    new ResizeObserver(syncPlayerHeight).observe(playerEl);
  }
  window.addEventListener('resize', syncPlayerHeight);

  // ---------------------------------------------------------------------- boot

  applyTheme();
  document.body.classList.add('no-player');
  bootFromCache();

  // restore the last episode paused at its saved position, ready to resume
  // (skipped when a jump-list shortcut already chose an episode)
  if (prefs.lastKey && !currentKey) {
    var last = findEpisode(prefs.lastKey);
    if (last) loadEpisode(last, false);
  }

  refresh(false);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* not fatal */ });
    });
  }
})();
