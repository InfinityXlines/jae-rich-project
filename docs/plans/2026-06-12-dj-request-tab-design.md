# DJ Request Tab — Design (approved 2026-06-12)

A fourth main tab, "🎧 DJ Request", that exists only during scheduled gig windows.

## Visibility engine
- Source of truth: the existing Dates gig cards (`.gig-card[data-date]` + `.gig-time` text, e.g. "6:00 PM - 9:00 PM").
- Window: visible from **60 min before start** to **30 min BEFORE end** (changed 2026-07-01; was end+30). Queue auto-reset boundaries remain start−30 / end+30. Cross-midnight sets handled (end < start ⇒ end +1 day). Device-local time is correct because the audience is physically at the gig.
- Re-evaluated every 30 s, on page focus, and at init. `body.dj-live` class gates tab + panel.
- Overrides: admin mode ON or `?djtest=1` query param forces visibility (band demo/testing).
- If the window closes while a fan is viewing the DJ panel, they are switched to Dates.

## Request flow (freeform + quick-pick)
- Inputs: song title (required), artist (optional), name (optional). Sanitized like existing inputs; length-capped.
- Quick-pick: typing in the song field live-filters the 286-song catalog (max 6 results); tapping one autofills song + artist.
- Dupe suppression by normalized song+artist key.

## DJ Live Queue
- Separate state: `localStorage` key `jrp_dj_queue_v1`, daily auto-clear, included in the existing 5 s multi-tab sync loop.
- Renders with the existing `.queue-item` styling incl. gold `just-added` flash; EQ-bars header; "ON AIR" pulsing badge.
- Admin bar gains: ✓ Next DJ Req / ⏭ Skip DJ / 🗑 Clear DJ Queue.

## Email alerts
- Each DJ request POSTs to the same activated FormSubmit form (same domain ⇒ no re-activation), subject `🎧 DJ Request: <song> — <artist>`.

## Out of scope (YAGNI)
- No server-side shared queue (consistent with existing architecture).
- No per-song "played" badges for freeform requests (admin just advances the queue).

---

## Post-design evolution (same day)

The tab evolved into **Song Requests** with a dedication form, backed by a
Cloudflare Worker + D1 (`worker/`): shared band-only queue at
`/admin?key=…`, per-request email alerts, auto-reset at gig start − 30 min
and gig end + 30 min (cron parses the live Dates cards every 5 min), and a
permanent History view with day grouping, CT timestamps, status badges,
and per-row permanent delete (`POST /api/delete`).

Dashboard bugfix worth remembering: the `hidden` attribute's UA
`display: none` loses to author `display: flex` — the dashboard now has
`[hidden] { display: none !important; }` so view toggling actually hides
the inactive list.
