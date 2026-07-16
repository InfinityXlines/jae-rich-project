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
const RESET_BEFORE_MS = 60 * 60000; // match the tab's 60-min early open so early-bird requests survive the reset
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

// Strip angle brackets server-side: browser/dashboard rendering is
// textContent-safe, but fan text also lands in HTML email — a direct
// API caller must not be able to inject markup into the band's inbox.
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[<>]/g, '').trim().slice(0, max) : '');

// Constant-time comparison for the admin key
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a), bb = enc.encode(b);
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

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
  // Each gig card chunk: parse its own date + first time range + venue
  const chunks = html.split('class="gig-card"').slice(1);
  for (const chunk of chunks) {
    const dm = chunk.match(/data-date="(\d{4})-(\d{2})-(\d{2})"/);
    const tm = chunk.match(/gig-time">\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–—]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!dm || !tm) continue;
    const vm = chunk.match(/gig-venue">\s*([^<]+?)\s*</);
    const [y, mo, d] = [+dm[1], +dm[2], +dm[3]];
    let start = chicagoUTCms(y, mo, d, to24(+tm[1], tm[3]), +tm[2]);
    let end = chicagoUTCms(y, mo, d, to24(+tm[4], tm[6]), +tm[5]);
    if (end <= start) end += 24 * 3600000; // 9 PM - 1 AM sets
    windows.push({ start, end, venue: vm ? vm[1] : null });
  }
  // One-off exact windows (DJ_EXACT_WINDOWS in the site JS) count as gig
  // windows too, so unlisted events still get reset-boundary protection.
  // The site's local Date literals are Central time; months are 0-based.
  const exacts = html.matchAll(
    /open:\s*new Date\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2})\)\.getTime\(\),\s*close:\s*new Date\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2})\)\.getTime\(\)/g
  );
  for (const m of exacts) {
    const n = m.slice(1).map(Number);
    windows.push({
      start: chicagoUTCms(n[0], n[1] + 1, n[2], n[3], n[4]),
      end: chicagoUTCms(n[5], n[6] + 1, n[7], n[8], n[9]),
      venue: null
    });
  }
  return windows;
}

// The site's 286-song catalog is inline JS: ["Artist", "Title", "Genre"]
function parseCatalogFromHTML(html) {
  const triplets = html.matchAll(/\["([^"\\]{1,80})",\s*"([^"\\]{1,80})",\s*"[^"]{1,30}"\]/g);
  return [...triplets].map(m => ({ artist: m[1], title: m[2] }));
}

async function refreshGigWindows(env) {
  const res = await fetch(SITE_URL, { headers: { 'User-Agent': 'JRP-Queue-Worker' } });
  if (!res.ok) return null;
  const html = await res.text();
  const windows = parseGigWindowsFromHTML(html);
  await env.DB.prepare(
    `INSERT INTO meta (k, v) VALUES ('gig_windows', ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`
  ).bind(JSON.stringify({ windows, fetched_at: Date.now() })).run();
  const catalog = parseCatalogFromHTML(html);
  if (catalog.length > 50) { // sanity: don't overwrite with a bad parse
    await env.DB.prepare(
      `INSERT INTO meta (k, v) VALUES ('catalog', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`
    ).bind(JSON.stringify(catalog)).run();
  }
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
// Overlapping / back-to-back gigs (e.g. two venues in one evening) are one
// continuous session: merge before computing boundaries so one gig's start
// boundary can't archive the other gig's live queue mid-set.
function mergeWindows(windows) {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.start - last.end <= RESET_BEFORE_MS + RESET_AFTER_MS) {
      if (w.end > last.end) last.end = w.end;
    } else {
      merged.push({ start: w.start, end: w.end });
    }
  }
  return merged;
}

async function runQueueReset(env, windows) {
  const now = Date.now();
  let lastBoundary = 0;
  for (const w of mergeWindows(windows)) {
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

// ── Crowd Favorites analytics ──
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function monthKeyCT(ts) {
  // "2026-07" in America/Chicago
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit',
  }).format(new Date(ts));
}

function monthNameCT(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function prevMonthKeyCT() {
  // Real month arithmetic — "now minus 32 days" overshoots on the 1st
  const [y, m] = monthKeyCT(Date.now()).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 15));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

async function computeStats(env) {
  const { results: rows } = await env.DB.prepare(
    'SELECT song, artist, occasion, created_at FROM requests ORDER BY created_at DESC LIMIT 5000'
  ).all();
  const windows = await getGigWindows(env);
  const catRow = await env.DB.prepare("SELECT v FROM meta WHERE k = 'catalog'").first();
  const catalog = catRow ? JSON.parse(catRow.v) : [];
  const catalogTitles = new Set(catalog.map(c => norm(c.title)));

  const tally = (map, key, display) => {
    const e = map.get(key) || { ...display, n: 0 };
    e.n++;
    map.set(key, e);
    return e;
  };

  const songsAll = new Map(), songsThisMonth = new Map(), songsPrevMonth = new Map(), learnNext = new Map();
  const months = new Map(), occasions = new Map(), venues = new Map(), days = new Map();
  const nowMonth = monthKeyCT(Date.now());
  const prevMonth = prevMonthKeyCT();

  for (const r of rows) {
    const key = norm(r.song) + '::' + norm(r.artist);
    const disp = { song: r.song, artist: r.artist || '' };
    tally(songsAll, key, disp);
    const mk = monthKeyCT(r.created_at);
    months.set(mk, (months.get(mk) || 0) + 1);
    if (mk === nowMonth) tally(songsThisMonth, key, disp);
    if (mk === prevMonth) tally(songsPrevMonth, key, disp);
    if (r.occasion) occasions.set(r.occasion, (occasions.get(r.occasion) || 0) + 1);
    if (!catalogTitles.has(norm(r.song)) && norm(r.song)) tally(learnNext, key, disp);
    const win = windows.find(w => r.created_at >= w.start - 3600000 && r.created_at <= w.end + 2700000);
    if (win && win.venue) venues.set(win.venue, (venues.get(win.venue) || 0) + 1);
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
    }).format(new Date(r.created_at));
    days.set(day, (days.get(day) || 0) + 1);
  }

  const top = (map, n) => [...map.values()].sort((a, b) => b.n - a.n).slice(0, n);
  const topPairs = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([name, count]) => ({ name, n: count }));

  return {
    generated_at: Date.now(),
    total: rows.length,
    thisMonth: months.get(nowMonth) || 0,
    thisMonthKey: nowMonth,
    months: [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12)
      .map(([month, count]) => ({ month, count })),
    topAll: top(songsAll, 20),
    topThisMonth: top(songsThisMonth, 10),
    topPrevMonth: top(songsPrevMonth, 10),
    learnNext: top(learnNext, 15),
    occasions: topPairs(occasions, 10),
    venues: topPairs(venues, 10),
    busiestDays: topPairs(days, 5),
    catalogSize: catalog.length,
  };
}

// Build the digest email fields (shared by the worker-side send and
// the dashboard's browser-side send).
async function buildDigestFields(env, scope) {
  const stats = await computeStats(env);
  const targetMonth = scope === 'current' ? stats.thisMonthKey : prevMonthKeyCT();
  const monthRow = stats.months.find(m => m.month === targetMonth);
  const list = arr => arr.length
    ? arr.map((s, i) => `${i + 1}) ${s.song}${s.artist ? ' — ' + s.artist : ''} (${s.n}x)`).join('   •   ')
    : '(none yet)';
  const pairs = arr => arr.length
    ? arr.map(p => `${p.name} (${p.n})`).join('   •   ')
    : '(none yet)';

  return {
    _subject: `📊 JRP Crowd Favorites Report — ${monthNameCT(targetMonth)}`,
    _template: 'table',
    _captcha: 'false',
    'Report for': monthNameCT(targetMonth) + (scope === 'current' ? ' (month so far)' : ''),
    'Requests this month': String(monthRow ? monthRow.count : 0),
    'Requests all-time': String(stats.total),
    'Top songs this month': list(scope === 'current' ? stats.topThisMonth : stats.topPrevMonth),
    'Top songs all-time': list(stats.topAll.slice(0, 10)),
    '💡 Learn next (requested, not in your catalog)': list(stats.learnNext),
    'Occasions': pairs(stats.occasions),
    'Venues': pairs(stats.venues),
    'Busiest nights': pairs(stats.busiestDays),
  };
}

// Worker-side send via FormSubmit with Origin/Referer set to the
// activated domain. NOTE: FormSubmit rate-limits Cloudflare's shared
// egress IPs hard, so this path often fails — the dashboard's
// browser-side send (band's own IP) is the reliable primary.
async function sendDigest(env, scope) {
  const fields = await buildDigestFields(env, scope);
  const res = await fetch('https://formsubmit.co/ajax/jrichproject@gmail.com', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://jaerichent.com',
      'Referer': 'https://jaerichent.com/',
    },
    body: JSON.stringify(fields),
  });
  let out;
  try { out = await res.json(); } catch { out = { success: 'unknown', status: res.status }; }
  return out;
}

// On the 1st of each month (from 8 AM Central), send the previous
// month's digest. FormSubmit rate-limits shared Worker IPs, so this is
// retried by every cron tick until one attempt succeeds; the
// digest_sent flag guarantees exactly one email per month.
async function maybeSendMonthlyDigest(env) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', day: 'numeric', hour: 'numeric', hour12: false,
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  if (+parts.day !== 1 || +parts.hour < 8) return;
  const mk = monthKeyCT(Date.now());
  const flag = await env.DB.prepare("SELECT v FROM meta WHERE k = 'digest_sent'").first();
  if (flag && flag.v === mk) return;
  const res = await sendDigest(env, 'prev');
  if (res && String(res.success) === 'true') {
    await env.DB.prepare(
      `INSERT INTO meta (k, v) VALUES ('digest_sent', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`
    ).bind(mk).run();
  }
}

export default {
  // Crons: */5 = schedule refresh + queue auto-reset + digest retry;
  // monthly (1st 14:00 UTC ≈ 8-9 AM Central) = first digest attempt.
  async scheduled(event, env) {
    if (event.cron === '0 14 1 * *') {
      await maybeSendMonthlyDigest(env);
      return;
    }
    const windows = await getGigWindows(env, { forceFresh: true });
    await runQueueReset(env, windows);
    await maybeSendMonthlyDigest(env);
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // ── Public: submit a request/dedication ──
    if (url.pathname === '/api/requests' && req.method === 'POST') {
      // Abuse guards: bounded payload, global rate window, pending cap.
      // Limits sit far above real gig traffic but stop scripted floods.
      if (+(req.headers.get('content-length') || 0) > 16384) {
        return json({ error: 'too large' }, 413, cors);
      }
      const recent = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM requests WHERE created_at > ?'
      ).bind(Date.now() - 60000).first();
      if (recent.n >= 30) return json({ error: 'slow down — try again in a minute' }, 429, cors);
      const backlog = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM requests WHERE played = 0 AND archived = 0'
      ).first();
      if (backlog.n >= 200) return json({ error: 'queue is full' }, 429, cors);
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

    // ── Public: monthly digest relay ──
    // jaerichent.com is the FormSubmit-activated origin, so the site's
    // visitors deliver the monthly report from their browsers. The
    // payload is claim-leased for 3 min so simultaneous visitors don't
    // all send; digest-done requires the nonce issued with the claim.
    if (url.pathname === '/api/digest-payload' && req.method === 'GET') {
      const mk = monthKeyCT(Date.now());
      const flag = await env.DB.prepare("SELECT v FROM meta WHERE k = 'digest_sent'").first();
      if (flag && flag.v === mk) return json({ pending: false }, 200, cors);
      const claim = await env.DB.prepare("SELECT v FROM meta WHERE k = 'digest_claim'").first();
      if (claim) {
        const c = JSON.parse(claim.v);
        if (Date.now() - c.at < 180000) return json({ pending: false }, 200, cors);
      }
      const nonce = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO meta (k, v) VALUES ('digest_claim', ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v`
      ).bind(JSON.stringify({ at: Date.now(), nonce })).run();
      const fields = await buildDigestFields(env, 'prev');
      return json({ pending: true, nonce, fields }, 200, cors);
    }

    if (url.pathname === '/api/digest-done' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400, cors); }
      const claim = await env.DB.prepare("SELECT v FROM meta WHERE k = 'digest_claim'").first();
      if (!claim || JSON.parse(claim.v).nonce !== body.nonce) {
        return json({ error: 'bad nonce' }, 403, cors);
      }
      await env.DB.prepare(
        `INSERT INTO meta (k, v) VALUES ('digest_sent', ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v`
      ).bind(monthKeyCT(Date.now())).run();
      return json({ ok: true }, 200, cors);
    }

    // ── Band-only routes ──
    const key = url.searchParams.get('key') || '';
    const authed = Boolean(env.ADMIN_KEY) && safeEqual(key, env.ADMIN_KEY);

    if (url.pathname === '/admin') {
      if (!authed) return new Response('Not found', { status: 404 });
      return new Response(ADMIN_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        },
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
      // Tapping ✓ Played is the announcement: publish this request as
      // "now playing" so the public site can show the banner.
      const row = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
      if (row) {
        await env.DB.prepare(
          `INSERT INTO meta (k, v) VALUES ('now_playing', ?)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v`
        ).bind(JSON.stringify({ ...row, played_at: Date.now() })).run();
      }
      return json({ ok: true });
    }

    // ── Public: what's playing right now (fans' banner) ──
    // No key needed: this is broadcast info the band chose to announce
    // by tapping ✓ Played. Expires after one song-length.
    if (url.pathname === '/api/now-playing' && req.method === 'GET') {
      const NP_TTL_MS = 4 * 60000;
      const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'now_playing'").first();
      let playing = null;
      if (row) {
        const np = JSON.parse(row.v);
        if (Date.now() - np.played_at <= NP_TTL_MS) {
          playing = {
            id: np.id, song: np.song, artist: np.artist,
            occasion: np.occasion, years: np.years,
            from_name: np.from_name, to_name: np.to_name,
            comments: np.comments, played_at: np.played_at
          };
        }
      }
      return json({ playing }, 200, { ...cors, 'Cache-Control': 'no-store' });
    }

    // ── Public: tonight's celebrations (band-approved only) ──
    // No key needed: each row appears only after the band taps 🎉 on the
    // dashboard. Names and occasions only — no comments, no song titles.
    if (url.pathname === '/api/celebrations' && req.method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT id, occasion, years, to_name, from_name FROM requests
         WHERE celebrate = 1 AND created_at > ?
         ORDER BY created_at ASC LIMIT 30`
      ).bind(Date.now() - 12 * 3600000).all();
      return json({ celebrations: results }, 200, { ...cors, 'Cache-Control': 'no-store' });
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

    // Band-only: toggle a dedication onto/off the public celebration spotlight
    if (url.pathname === '/api/celebrate' && req.method === 'POST') {
      if (!authed) return new Response('Not found', { status: 404 });
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ error: 'bad id' }, 400);
      await env.DB.prepare('UPDATE requests SET celebrate = ? WHERE id = ?')
        .bind(body.on ? 1 : 0, id).run();
      return json({ ok: true });
    }

    if (url.pathname === '/api/reset-check' && req.method === 'POST') {
      if (!authed) return new Response('Not found', { status: 404 });
      const windows = await getGigWindows(env, { forceFresh: true });
      const result = await runQueueReset(env, windows);
      return json({ ok: true, windows: windows.length, ...result });
    }

    if (url.pathname === '/api/stats' && req.method === 'GET') {
      if (!authed) return new Response('Not found', { status: 404 });
      return json(await computeStats(env), 200, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/api/send-digest' && req.method === 'POST') {
      if (!authed) return new Response('Not found', { status: 404 });
      const scope = url.searchParams.get('scope') === 'current' ? 'current' : 'prev';
      const result = await sendDigest(env, scope);
      return json({ ok: true, formsubmit: result });
    }

    // Browser-side digest delivery (the reliable path): the dashboard
    // checks status, fetches the fields, POSTs to FormSubmit from the
    // band's own browser/IP, then marks the month done.
    if (url.pathname === '/api/digest-status' && req.method === 'GET') {
      if (!authed) return new Response('Not found', { status: 404 });
      const mk = monthKeyCT(Date.now());
      const flag = await env.DB.prepare("SELECT v FROM meta WHERE k = 'digest_sent'").first();
      return json({ pending: !flag || flag.v !== mk, month: mk }, 200, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/api/digest-fields' && req.method === 'GET') {
      if (!authed) return new Response('Not found', { status: 404 });
      const scope = url.searchParams.get('scope') === 'current' ? 'current' : 'prev';
      return json(await buildDigestFields(env, scope), 200, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/api/digest-mark' && req.method === 'POST') {
      if (!authed) return new Response('Not found', { status: 404 });
      await env.DB.prepare(
        `INSERT INTO meta (k, v) VALUES ('digest_sent', ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v`
      ).bind(monthKeyCT(Date.now())).run();
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
<meta name="referrer" content="no-referrer">
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
  button.cel {
    background: none; color: var(--gold);
    border: 1px solid rgba(212,165,116,0.5); border-radius: 50px;
    font-size: 0.85rem; font-weight: 700; padding: 0.55rem 0.9rem;
    cursor: pointer; flex-shrink: 0; transition: all 0.15s ease;
  }
  button.cel.on { background: linear-gradient(135deg, var(--gold), var(--amber)); color: #000; border-color: transparent; }
  button.cel:active { transform: scale(0.94); }
  .btns { display: flex; flex-direction: column; gap: 0.45rem; flex-shrink: 0; min-width: 118px; }
  .btns button { width: 100%; }
  .empty { text-align: center; color: rgba(255,255,255,0.55); padding: 3rem 1rem; font-style: italic;
    max-width: 720px; margin: 0 auto; }
  .day-head { font-size: 0.9rem; color: var(--gold); font-weight: 800; letter-spacing: 0.08em;
    text-transform: uppercase; margin-top: 0.75rem; }
  #stats { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 0.75rem; }
  .stat-chips { display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .stat-chip { flex: 1; min-width: 130px; background: var(--card); border: 1px solid var(--border);
    border-radius: 14px; padding: 0.9rem 1rem; text-align: center; }
  .stat-chip .big { font-size: 1.7rem; font-weight: 800; color: var(--gold); }
  .stat-chip .lbl { font-size: 0.75rem; letter-spacing: 0.1em; text-transform: uppercase;
    color: rgba(255,255,255,0.55); margin-top: 0.2rem; }
  .stat-row { background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 0.65rem 0.9rem; }
  .stat-row .line { display: flex; justify-content: space-between; gap: 0.75rem; font-size: 0.95rem; }
  .stat-row .cnt { color: var(--gold); font-weight: 800; flex-shrink: 0; }
  .stat-bar { height: 4px; border-radius: 2px; background: linear-gradient(90deg, var(--gold), var(--amber));
    margin-top: 0.45rem; opacity: 0.8; }
  button.email-report { align-self: flex-start; background: linear-gradient(135deg, var(--gold), var(--amber));
    color: #000; border: none; border-radius: 50px; font-weight: 800; font-size: 0.95rem;
    padding: 0.7rem 1.3rem; cursor: pointer; }
  button.email-report:active { transform: scale(0.95); }
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
  <button id="nav-stats">📊 Stats</button>
</nav>
<div id="list"></div>
<div id="hist" hidden></div>
<div id="stats" hidden></div>
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
    if (!confirm('Delete "' + song + '" permanently? This cannot be undone.')) return;
    card.style.opacity = '0.35';
    try {
      await fetch('/api/delete?key=' + encodeURIComponent(KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
    } catch (e) { card.style.opacity = '1'; return; }
    if (mode === 'live') { lastJSON = ''; loadLive(); } else loadHistory();
  }

  function setCelBtn(btn, on) {
    btn.textContent = on ? '🌟 Celebrating' : '🎉 Celebrate';
    btn.classList.toggle('on', !!on);
  }

  async function toggleCelebrate(r, btn) {
    const on = r.celebrate ? 0 : 1;
    btn.disabled = true;
    try {
      await fetch('/api/celebrate?key=' + encodeURIComponent(KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id, on })
      });
      r.celebrate = on;
      lastJSON = '';
    } catch (e) {}
    btn.disabled = false;
    setCelBtn(btn, r.celebrate);
  }

  function isCelebration(r) {
    return r.occasion === 'Birthday' || r.occasion === 'Anniversary';
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
      const btns = el('div', 'btns');
      const btn = el('button', 'done', '✓ Played');
      btn.addEventListener('click', () => markPlayed(r.id, card));
      btns.appendChild(btn);
      if (isCelebration(r)) {
        const cel = el('button', 'cel');
        setCelBtn(cel, r.celebrate);
        cel.addEventListener('click', () => toggleCelebrate(r, cel));
        btns.appendChild(cel);
      }
      const del = el('button', 'del', '🗑 Delete');
      del.addEventListener('click', () => deleteReq(r.id, card, r.song));
      btns.appendChild(del);
      card.appendChild(btns);
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
      const btns = el('div', 'btns');
      if (isCelebration(r)) {
        const cel = el('button', 'cel');
        setCelBtn(cel, r.celebrate);
        cel.addEventListener('click', () => toggleCelebrate(r, cel));
        btns.appendChild(cel);
      }
      const del = el('button', 'del', '🗑 Delete');
      del.addEventListener('click', () => deleteReq(r.id, card, r.song));
      btns.appendChild(del);
      card.appendChild(btns);
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

  // ── Stats view ──
  const statsEl = document.getElementById('stats');
  const navStats = document.getElementById('nav-stats');

  function statSection(title) { statsEl.appendChild(el('div', 'day-head', title)); }
  function statRows(items, fmt) {
    if (!items.length) { statsEl.appendChild(el('div', 'meta', 'Nothing here yet.')); return; }
    const max = items[0].n || 1;
    items.forEach((it, i) => {
      const row = el('div', 'stat-row');
      const line = el('div', 'line');
      line.appendChild(el('span', null, (i + 1) + '.  ' + fmt(it)));
      line.appendChild(el('span', 'cnt', it.n + '×'));
      row.appendChild(line);
      const bar = el('div', 'stat-bar');
      bar.style.width = Math.max(6, Math.round(it.n / max * 100)) + '%';
      row.appendChild(bar);
      statsEl.appendChild(row);
    });
  }

  function renderStats(s) {
    statsEl.replaceChildren();
    countEl.textContent = s.total + ' all-time';

    const chips = el('div', 'stat-chips');
    [[s.total, 'All-time requests'], [s.thisMonth, 'This month'],
     [s.learnNext.reduce((a, b) => a + b.n, 0), 'Not-in-catalog asks']].forEach(([n, lbl]) => {
      const c = el('div', 'stat-chip');
      c.appendChild(el('div', 'big', String(n)));
      c.appendChild(el('div', 'lbl', lbl));
      chips.appendChild(c);
    });
    statsEl.appendChild(chips);

    const btn = el('button', 'email-report', '📧 Email me this report');
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const res = await fetch('/api/send-digest?scope=current&key=' + encodeURIComponent(KEY), { method: 'POST' });
        const d = await res.json();
        btn.textContent = (d.formsubmit && String(d.formsubmit.success) === 'true')
          ? '✓ Sent to the inbox!' : '⚠ Send failed — try again';
      } catch (e) { btn.textContent = '⚠ Send failed — try again'; }
      setTimeout(() => { btn.disabled = false; btn.textContent = '📧 Email me this report'; }, 4000);
    });
    statsEl.appendChild(btn);

    statSection('🏆 Top Songs — All Time');
    statRows(s.topAll, it => it.song + (it.artist ? ' — ' + it.artist : ''));
    statSection('📈 Top Songs — This Month');
    statRows(s.topThisMonth, it => it.song + (it.artist ? ' — ' + it.artist : ''));
    statSection('💡 Learn Next — requested, not in your ' + s.catalogSize + '-song catalog');
    statRows(s.learnNext, it => it.song + (it.artist ? ' — ' + it.artist : ''));
    statSection('🎉 Occasions');
    statRows(s.occasions.map(p => ({ n: p.n, name: p.name })), it => it.name);
    statSection('📍 Venues');
    statRows(s.venues.map(p => ({ n: p.n, name: p.name })), it => it.name);
    statSection('🔥 Busiest Nights');
    statRows(s.busiestDays.map(p => ({ n: p.n, name: p.name })), it => it.name);
    statSection('🗓 Requests by Month');
    statRows(s.months.map(m => ({ n: m.count, name: m.month })), it => it.name);
  }

  async function loadStats() {
    try {
      const res = await fetch('/api/stats?key=' + encodeURIComponent(KEY));
      if (!res.ok) return;
      renderStats(await res.json());
    } catch (e) {}
  }

  function setView(which) {
    mode = which;
    navLive.classList.toggle('on', which === 'live');
    navHist.classList.toggle('on', which === 'hist');
    navStats.classList.toggle('on', which === 'stats');
    listEl.hidden = which !== 'live';
    histEl.hidden = which !== 'hist';
    statsEl.hidden = which !== 'stats';
    emptyEl.hidden = true;
  }

  navLive.addEventListener('click', () => { setView('live'); lastJSON = ''; loadLive(); });
  navHist.addEventListener('click', () => { setView('hist'); loadHistory(); });
  navStats.addEventListener('click', () => { setView('stats'); loadStats(); });

  // ── Monthly report: browser-side delivery ──
  // FormSubmit rate-limits Cloudflare's server IPs but happily accepts
  // browser submissions. On each dashboard open: if this month's
  // report hasn't gone out yet, send it from right here.
  function note(msg) {
    let n = document.getElementById('note');
    if (!n) {
      n = el('div', null, '');
      n.id = 'note';
      n.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);' +
        'background:#14121e;border:1px solid var(--gold);color:#fff;padding:0.8rem 1.3rem;' +
        'border-radius:50px;font-size:0.9rem;max-width:92vw;text-align:center;z-index:99;' +
        'box-shadow:0 8px 30px rgba(0,0,0,0.5)';
      document.body.appendChild(n);
    }
    n.textContent = msg;
    n.hidden = false;
    clearTimeout(note._t);
    note._t = setTimeout(() => { n.hidden = true; }, 9000);
  }

  (async function deliverMonthlyDigest() {
    try {
      const st = await (await fetch('/api/digest-status?key=' + encodeURIComponent(KEY))).json();
      if (!st.pending) return;
      const fields = await (await fetch('/api/digest-fields?key=' + encodeURIComponent(KEY) + '&scope=prev')).json();
      const res = await fetch('https://formsubmit.co/ajax/jrichproject@gmail.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(fields),
        signal: AbortSignal.timeout(15000)
      });
      const out = await res.json().catch(() => ({}));
      if (String(out.success) === 'true') {
        await fetch('/api/digest-mark?key=' + encodeURIComponent(KEY), { method: 'POST' });
        note('📊 Monthly Crowd Favorites report emailed to the inbox ✓');
      } else if (/activat/i.test(out.message || '')) {
        note('📧 One-time setup: check jrichproject@gmail.com for a FormSubmit "Activate Form" email and click it — the report will send next time you open this page.');
      } else {
        note('⚠ Monthly report send failed: ' + (out.message || ('HTTP ' + res.status)) + ' — will retry on your next visit.');
      }
    } catch (e) {
      note('⚠ Monthly report send error: ' + e.message + ' — will retry on your next visit.');
    }
  })();

  loadLive();
  setInterval(() => { if (mode === 'live') loadLive(); }, 4000);
</script>
</body>
</html>`;
