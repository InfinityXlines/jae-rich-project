// JRP Live Queue — Cloudflare Worker
// Public:  POST /api/requests          (from jaerichent.com DJ/Dedications tab)
// Band:    GET  /admin?key=…           (live queue dashboard + history)
//          GET  /api/queue?key=…       (pending requests JSON)
//          GET  /api/history?key=…     (full request log, newest first)
//          POST /api/played?key=…      (mark a request played)
//          POST /api/reset-check?key=… (manually run the auto-reset)
// Cron:    every 5 min — re-parse gig times from jaerichent.com and
//          auto-archive the queue 30 min before / 30 min after each gig.
// History is never deleted: rows are archived (queue reset) or played.

const SITE_URL = 'https://jaerichent.com/';
const RESET_BEFORE_MS = 30 * 60000;
const RESET_AFTER_MS = 30 * 60000;
const WINDOW_CACHE_MS = 6 * 3600000; // re-parse the site at most every 6h on the lazy path

const ALLOWED_ORIGINS = [
  'https://jaerichent.com',
  'https://jae-rich-project.pages.dev',
  'http://localhost:8741',
];

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ── Gig schedule: parse the live site's Dates cards ──
// America/Chicago wall time → UTC ms (two-pass for DST correctness)
function chicagoOffsetMs(utcMs) {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(utcMs)).find(p => p.type === 'timeZoneName').value; // "GMT-05:00"
  const m = part.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return -6 * 3600000;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((+m[2]) * 3600000 + (+m[3]) * 60000);
}

function chicagoUTCms(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const utc1 = guess - chicagoOffsetMs(guess);
  return guess - chicagoOffsetMs(utc1);
}

function parseGigWindowsFromHTML(html) {
  const windows = [];
  const to24 = (h, ap) => (h % 12) + (/pm/i.test(ap) ? 12 : 0);
  // Each gig card chunk: parse its own date + first time range
  const chunks = html.split('class="gig-card"').slice(1);
  for (const chunk of chunks) {
    const dm = chunk.match(/data-date="(\d{4})-(\d{2})-(\d{2})"/);
    const tm = chunk.match(/gig-time">\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–—]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!dm || !tm) continue;
    const [y, mo, d] = [+dm[1], +dm[2], +dm[3]];
    let start = chicagoUTCms(y, mo, d, to24(+tm[1], tm[3]), +tm[2]);
    let end = chicagoUTCms(y, mo, d, to24(+tm[4], tm[6]), +tm[5]);
    if (end <= start) end += 24 * 3600000; // 9 PM - 1 AM sets
    windows.push({ start, end });
  }
  return windows;
}

async function refreshGigWindows(env) {
  const res = await fetch(SITE_URL, { headers: { 'User-Agent': 'JRP-Queue-Worker' } });
  if (!res.ok) return null;
  const windows = parseGigWindowsFromHTML(await res.text());
  await env.DB.prepare(
    `INSERT INTO meta (k, v) VALUES ('gig_windows', ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`
  ).bind(JSON.stringify({ windows, fetched_at: Date.now() })).run();
  return windows;
}

async function getGigWindows(env, { forceFresh = false } = {}) {
  if (!forceFresh) {
    const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'gig_windows'").first();
    if (row) {
      const cached = JSON.parse(row.v);
      if (Date.now() - cached.fetched_at < WINDOW_CACHE_MS) return cached.windows;
    }
  }
  const fresh = await refreshGigWindows(env);
  if (fresh) return fresh;
  // Site unreachable: fall back to last known schedule rather than none
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'gig_windows'").first();
  return row ? JSON.parse(row.v).windows : [];
}

// The queue should only ever contain requests newer than the most
// recent reset boundary. Boundaries: gig start − 30 min, gig end + 30 min.
// Idempotent — safe to run as often as we like.
async function runQueueReset(env, windows) {
  const now = Date.now();
  let lastBoundary = 0;
  for (const w of windows) {
    for (const b of [w.start - RESET_BEFORE_MS, w.end + RESET_AFTER_MS]) {
      if (b <= now && b > lastBoundary) lastBoundary = b;
    }
  }
  if (!lastBoundary) return { archived: 0, lastBoundary: null };
  const r = await env.DB.prepare(
    'UPDATE requests SET archived = 1 WHERE played = 0 AND archived = 0 AND created_at < ?'
  ).bind(lastBoundary).run();
  return { archived: r.meta.changes || 0, lastBoundary };
}

export default {
  // Cron: refresh schedule from the live site, then apply resets
  async scheduled(event, env) {
    const windows = await getGigWindows(env, { forceFresh: true });
    await runQueueReset(env, windows);
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // ── Public: submit a request/dedication ──
    if (url.pathname === '/api/requests' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400, cors); }
      const song = clean(body.song, 80);
      if (!song) return json({ error: 'song required' }, 400, cors);
      const occasion = clean(body.occasion, 30);
      if (occasion && !['Birthday', 'Anniversary', 'Special Request'].includes(occasion)) {
        return json({ error: 'bad occasion' }, 400, cors);
      }
      await env.DB.prepare(
        `INSERT INTO requests (song, artist, occasion, years, from_name, to_name, comments, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        song,
        clean(body.artist, 80),
        occasion,
        clean(body.years, 10),
        clean(body.from_name, 40),
        clean(body.to_name, 40),
        clean(body.comments, 200),
        Date.now()
      ).run();
      return json({ ok: true }, 200, cors);
    }

    // ── Band-only routes ──
    const key = url.searchParams.get('key') || '';
    const authed = env.ADMIN_KEY && key === env.ADMIN_KEY;

    if (url.pathname === '/admin') {
      if (!authed) return new Response('Not found', { status: 404 });
      return new Response(ADMIN_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/api/queue' && req.method === 'GET') {
      if (!authed) return new Response('Not found', { status: 404 });
      // Lazy reset on every band read — cron is the backstop
      const windows = await getGigWindows(env);
      await runQueueReset(env, windows);
      const { results } = await env.DB.prepare(
        'SELECT * FROM requests WHERE played = 0 AND archived = 0 ORDER BY created_at ASC LIMIT 200'
      ).all();
      return json({ queue: results }, 200, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/api/history' && req.method === 'GET') {
      if (!authed) return new Response('Not found', { status: 404 });
      const { results } = await env.DB.prepare(
        'SELECT * FROM requests ORDER BY created_at DESC LIMIT 500'
      ).all();
      return json({ history: results }, 200, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/api/played' && req.method === 'POST') {
      if (!authed) return new Response('Not found', { status: 404 });
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ error: 'bad id' }, 400);
      await env.DB.prepare('UPDATE requests SET played = 1 WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    // Permanent single-row delete (band-initiated, from the History view)
    if (url.pathname === '/api/delete' && req.method === 'POST') {
      if (!authed) return new Response('Not found', { status: 404 });
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ error: 'bad id' }, 400);
      await env.DB.prepare('DELETE FROM requests WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    if (url.pathname === '/api/reset-check' && req.method === 'POST') {
      if (!authed) return new Response('Not found', { status: 404 });
      const windows = await getGigWindows(env, { forceFresh: true });
      const result = await runQueueReset(env, windows);
      return json({ ok: true, windows: windows.length, ...result });
    }

    return new Response('Not found', { status: 404 });
  },
};

// ── Band dashboard ──
// All fan-typed content is rendered with textContent — never markup.
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>JRP — Live Request Queue</title>
<style>
  :root {
    --bg: #0a0a0f; --card: #14121e; --gold: #d4a574; --amber: #c9735b;
    --purple: #7c5cbf; --border: rgba(212,165,116,0.18); --success: #5cb87a;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  /* The hidden attribute must always win, even over display:flex below */
  [hidden] { display: none !important; }
  body {
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg); color: #fff; min-height: 100vh; padding: 1.25rem;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    max-width: 720px; margin: 0 auto 1rem; gap: 1rem; flex-wrap: wrap;
  }
  h1 { font-size: 1.35rem; color: var(--gold); display: flex; align-items: center; gap: 0.6rem; }
  .live-dot {
    width: 10px; height: 10px; border-radius: 50%; background: var(--success);
    animation: pulse 1.4s ease-in-out infinite; display: inline-block;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
  #count { font-size: 0.95rem; color: var(--gold); border: 1px solid var(--border);
    padding: 0.35rem 0.9rem; border-radius: 50px; }
  nav { max-width: 720px; margin: 0 auto 1.25rem; display: flex; gap: 0.5rem; }
  nav button {
    background: var(--card); color: #fff; border: 1px solid var(--border);
    border-radius: 50px; padding: 0.5rem 1.1rem; font-size: 0.9rem; font-weight: 700;
    cursor: pointer;
  }
  nav button.on { border-color: var(--gold); color: var(--gold); }
  #list, #hist { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 0.75rem; }
  .req {
    background: var(--card); border: 1px solid var(--border); border-radius: 14px;
    padding: 1rem 1.1rem; display: flex; gap: 1rem; align-items: flex-start;
    animation: slideIn 0.4s cubic-bezier(0.22,1,0.36,1);
  }
  @keyframes slideIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  #list .req:first-child { border-color: var(--gold); box-shadow: 0 0 18px rgba(212,165,116,0.12); }
  .num { font-size: 1.2rem; font-weight: 800; color: var(--gold); min-width: 28px; text-align: center; }
  .body { flex: 1; min-width: 0; }
  .song { font-size: 1.1rem; font-weight: 700; }
  .artist { color: rgba(255,255,255,0.75); font-size: 0.95rem; }
  .ded { margin-top: 0.5rem; font-size: 0.92rem; line-height: 1.5; color: #eee; }
  .badge {
    display: inline-block; font-size: 0.75rem; font-weight: 800; letter-spacing: 0.06em;
    text-transform: uppercase; padding: 0.2rem 0.65rem; border-radius: 50px; margin-right: 0.4rem;
  }
  .badge.Birthday { background: rgba(212,165,116,0.18); color: var(--gold); }
  .badge.Anniversary { background: rgba(124,92,191,0.25); color: #b9a3e6; }
  .badge.Special { background: rgba(92,184,122,0.18); color: var(--success); }
  .badge.status-played { background: rgba(92,184,122,0.18); color: var(--success); }
  .badge.status-archived { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.55); }
  .badge.status-pending { background: rgba(212,165,116,0.18); color: var(--gold); }
  .meta { margin-top: 0.45rem; font-size: 0.78rem; color: rgba(255,255,255,0.45); }
  button.done {
    background: linear-gradient(135deg, var(--gold), var(--amber)); color: #000;
    border: none; border-radius: 50px; font-weight: 800; font-size: 0.95rem;
    padding: 0.7rem 1.1rem; cursor: pointer; flex-shrink: 0; transition: transform 0.15s ease;
  }
  button.done:active { transform: scale(0.94); }
  button.del {
    background: none; color: rgba(255,255,255,0.45);
    border: 1px solid rgba(255,255,255,0.18); border-radius: 50px;
    font-size: 0.85rem; font-weight: 700; padding: 0.55rem 0.9rem;
    cursor: pointer; flex-shrink: 0; transition: all 0.15s ease;
  }
  button.del:hover { color: #ff6b61; border-color: rgba(255,59,48,0.5); }
  button.del:active { transform: scale(0.94); }
  .empty { text-align: center; color: rgba(255,255,255,0.55); padding: 3rem 1rem; font-style: italic;
    max-width: 720px; margin: 0 auto; }
  .day-head { font-size: 0.9rem; color: var(--gold); font-weight: 800; letter-spacing: 0.08em;
    text-transform: uppercase; margin-top: 0.75rem; }
</style>
</head>
<body>
<header>
  <h1><span class="live-dot"></span> Live Request Queue</h1>
  <span id="count">…</span>
</header>
<nav>
  <button id="nav-live" class="on">🎶 Live Queue</button>
  <button id="nav-hist">📜 History</button>
</nav>
<div id="list"></div>
<div id="hist" hidden></div>
<div class="empty" id="empty" hidden>No requests yet — the booth is quiet. 🎧</div>
<script>
  const KEY = new URLSearchParams(location.search).get('key');
  const listEl = document.getElementById('list');
  const histEl = document.getElementById('hist');
  const emptyEl = document.getElementById('empty');
  const countEl = document.getElementById('count');
  const navLive = document.getElementById('nav-live');
  const navHist = document.getElementById('nav-hist');
  let mode = 'live';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const fmtCT = ts => new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });

  function timeAgo(ts) {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago';
  }

  function dedBlock(r) {
    const ded = el('div', 'ded');
    if (r.occasion) {
      ded.appendChild(el('span', 'badge ' + r.occasion.split(' ')[0],
        r.occasion + (r.years ? ' · ' + r.years + ' yrs' : '')));
    }
    const parts = [];
    if (r.to_name) parts.push('To: ' + r.to_name);
    if (r.from_name) parts.push('From: ' + r.from_name);
    if (parts.length) ded.appendChild(el('div', null, parts.join('  •  ')));
    if (r.comments) {
      const c = el('div', null, '“' + r.comments + '”');
      c.style.color = '#d4a574';
      ded.appendChild(c);
    }
    return ded.childNodes.length ? ded : null;
  }

  async function markPlayed(id, card) {
    card.style.opacity = '0.35';
    try {
      await fetch('/api/played?key=' + encodeURIComponent(KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
    } catch (e) { card.style.opacity = '1'; return; }
    loadLive();
  }

  async function deleteReq(id, card, song) {
    if (!confirm('Delete "' + song + '" from history forever? This cannot be undone.')) return;
    card.style.opacity = '0.35';
    try {
      await fetch('/api/delete?key=' + encodeURIComponent(KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
    } catch (e) { card.style.opacity = '1'; return; }
    loadHistory();
  }

  function renderLive(queue) {
    listEl.replaceChildren();
    emptyEl.hidden = queue.length > 0;
    countEl.textContent = queue.length + (queue.length === 1 ? ' request' : ' requests');
    queue.forEach((r, i) => {
      const card = el('div', 'req');
      card.appendChild(el('div', 'num', String(i + 1)));
      const body = el('div', 'body');
      body.appendChild(el('div', 'song', r.song));
      if (r.artist) body.appendChild(el('div', 'artist', r.artist));
      const ded = dedBlock(r);
      if (ded) body.appendChild(ded);
      body.appendChild(el('div', 'meta', timeAgo(r.created_at)));
      card.appendChild(body);
      const btn = el('button', 'done', '✓ Played');
      btn.addEventListener('click', () => markPlayed(r.id, card));
      card.appendChild(btn);
      listEl.appendChild(card);
    });
  }

  function renderHistory(rows) {
    histEl.replaceChildren();
    emptyEl.hidden = rows.length > 0;
    countEl.textContent = rows.length + ' logged';
    let lastDay = '';
    rows.forEach(r => {
      const day = new Date(r.created_at).toLocaleDateString('en-US',
        { timeZone: 'America/Chicago', weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
      if (day !== lastDay) { histEl.appendChild(el('div', 'day-head', day)); lastDay = day; }
      const card = el('div', 'req');
      const body = el('div', 'body');
      body.appendChild(el('div', 'song', r.song));
      if (r.artist) body.appendChild(el('div', 'artist', r.artist));
      const ded = dedBlock(r);
      if (ded) body.appendChild(ded);
      const status = r.played ? ['status-played', '✓ played'] :
        (r.archived ? ['status-archived', 'auto-cleared'] : ['status-pending', 'in queue']);
      const meta = el('div', 'meta', fmtCT(r.created_at) + ' CT  ·  ');
      meta.appendChild(el('span', 'badge ' + status[0], status[1]));
      body.appendChild(meta);
      card.appendChild(body);
      const del = el('button', 'del', '🗑 Delete');
      del.addEventListener('click', () => deleteReq(r.id, card, r.song));
      card.appendChild(del);
      histEl.appendChild(card);
    });
  }

  let lastJSON = '';
  async function loadLive() {
    try {
      const res = await fetch('/api/queue?key=' + encodeURIComponent(KEY));
      if (!res.ok) return;
      const data = await res.json();
      const s = JSON.stringify(data.queue);
      if (s !== lastJSON) { lastJSON = s; renderLive(data.queue); }
    } catch (e) {}
  }

  async function loadHistory() {
    try {
      const res = await fetch('/api/history?key=' + encodeURIComponent(KEY));
      if (!res.ok) return;
      renderHistory((await res.json()).history);
    } catch (e) {}
  }

  navLive.addEventListener('click', () => {
    mode = 'live'; navLive.classList.add('on'); navHist.classList.remove('on');
    histEl.hidden = true; listEl.hidden = false; lastJSON = ''; loadLive();
  });
  navHist.addEventListener('click', () => {
    mode = 'hist'; navHist.classList.add('on'); navLive.classList.remove('on');
    listEl.hidden = true; histEl.hidden = false; emptyEl.hidden = true; loadHistory();
  });

  loadLive();
  setInterval(() => { if (mode === 'live') loadLive(); }, 4000);
</script>
</body>
</html>`;
