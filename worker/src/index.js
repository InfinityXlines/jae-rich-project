// JRP Live Queue — Cloudflare Worker
// Public:  POST /api/requests        (from jaerichent.com DJ/Dedications tab)
// Band:    GET  /admin?key=…         (live queue dashboard)
//          GET  /api/queue?key=…     (pending requests JSON)
//          POST /api/played?key=…    (mark a request played/removed)
// Auth: ADMIN_KEY secret. Requests without it 404 so the routes stay invisible.

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

export default {
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
      const { results } = await env.DB.prepare(
        'SELECT * FROM requests WHERE played = 0 ORDER BY created_at ASC LIMIT 200'
      ).all();
      return json({ queue: results }, 200, { 'Cache-Control': 'no-store' });
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
  body {
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg); color: #fff; min-height: 100vh; padding: 1.25rem;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    max-width: 720px; margin: 0 auto 1.25rem; gap: 1rem; flex-wrap: wrap;
  }
  h1 { font-size: 1.35rem; color: var(--gold); display: flex; align-items: center; gap: 0.6rem; }
  .live-dot {
    width: 10px; height: 10px; border-radius: 50%; background: var(--success);
    animation: pulse 1.4s ease-in-out infinite; display: inline-block;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
  #count { font-size: 0.95rem; color: var(--gold); border: 1px solid var(--border);
    padding: 0.35rem 0.9rem; border-radius: 50px; }
  #list { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 0.75rem; }
  .req {
    background: var(--card); border: 1px solid var(--border); border-radius: 14px;
    padding: 1rem 1.1rem; display: flex; gap: 1rem; align-items: flex-start;
    animation: slideIn 0.4s cubic-bezier(0.22,1,0.36,1);
  }
  @keyframes slideIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  .req:first-child { border-color: var(--gold); box-shadow: 0 0 18px rgba(212,165,116,0.12); }
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
  .meta { margin-top: 0.45rem; font-size: 0.78rem; color: rgba(255,255,255,0.45); }
  button.done {
    background: linear-gradient(135deg, var(--gold), var(--amber)); color: #000;
    border: none; border-radius: 50px; font-weight: 800; font-size: 0.95rem;
    padding: 0.7rem 1.1rem; cursor: pointer; flex-shrink: 0; transition: transform 0.15s ease;
  }
  button.done:active { transform: scale(0.94); }
  #empty { text-align: center; color: rgba(255,255,255,0.55); padding: 3rem 1rem; font-style: italic; }
</style>
</head>
<body>
<header>
  <h1><span class="live-dot"></span> Live Request Queue</h1>
  <span id="count">…</span>
</header>
<div id="list"></div>
<div id="empty" hidden>No requests yet — the booth is quiet. 🎧</div>
<script>
  const KEY = new URLSearchParams(location.search).get('key');
  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const countEl = document.getElementById('count');

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function timeAgo(ts) {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago';
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
    load();
  }

  function render(queue) {
    listEl.replaceChildren();
    emptyEl.hidden = queue.length > 0;
    countEl.textContent = queue.length + (queue.length === 1 ? ' request' : ' requests');
    queue.forEach((r, i) => {
      const card = el('div', 'req');
      card.appendChild(el('div', 'num', String(i + 1)));
      const body = el('div', 'body');
      body.appendChild(el('div', 'song', r.song));
      if (r.artist) body.appendChild(el('div', 'artist', r.artist));
      if (r.occasion || r.from_name || r.to_name || r.comments) {
        const ded = el('div', 'ded');
        if (r.occasion) {
          const b = el('span', 'badge ' + r.occasion.split(' ')[0],
            r.occasion + (r.years ? ' · ' + r.years + ' yrs' : ''));
          ded.appendChild(b);
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
        body.appendChild(ded);
      }
      body.appendChild(el('div', 'meta', timeAgo(r.created_at)));
      card.appendChild(body);
      const btn = el('button', 'done', '✓ Played');
      btn.addEventListener('click', () => markPlayed(r.id, card));
      card.appendChild(btn);
      listEl.appendChild(card);
    });
  }

  let lastJSON = '';
  async function load() {
    try {
      const res = await fetch('/api/queue?key=' + encodeURIComponent(KEY));
      if (!res.ok) return;
      const data = await res.json();
      const s = JSON.stringify(data.queue);
      if (s !== lastJSON) { lastJSON = s; render(data.queue); }
    } catch (e) { /* transient network — keep showing last state */ }
  }
  load();
  setInterval(load, 4000);
</script>
</body>
</html>`;
