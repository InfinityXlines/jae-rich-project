# DJ Request Tab — Design (approved 2026-06-12)

A fourth main tab, "🎧 DJ Request", that exists only during scheduled gig windows.

## Visibility engine
- Source of truth: the existing Dates gig cards (`.gig-card[data-date]` + `.gig-time` text, e.g. "6:00 PM - 9:00 PM").
- Window: visible from **60 min before start** to **30 min after end**. Cross-midnight sets handled (end < start ⇒ end +1 day). Device-local time is correct because the audience is physically at the gig.
- Re-evaluated every 30 s, on page focus, and at init. `body.dj-live` class gates tab + panel.
- Overrides: admin mode ON or `?djtest=1` query param forces visibility (band demo/testing).
- If the window closes while a fan is viewing the DJ panel, they are switched to Song List.

## Request flow (freeform + quick-pick)
- Inputs: song title (required), artist (optional), name (optional). Sanitized like existing inputs; length-capped.
- Quick-pick: typing in the song field live-filters the 286-song catalog (max 6 results); tapping one autofills song + artist.
- Dupe suppression by normalized song+artist key.

## DJ Live Queue
- Separate state: `localStorage` key `jrp_dj_queue_v1`, daily auto-clear, included in the existing 5 s multi-tab sync loop.
- Renders with the existing `.queue-item` styling incl. gold `just-added` flash; EQ-bars header; "ON AIR" pulsing badge.
- Admin bar gains: ✓ Next DJ Req / ⏭ Skip DJ / 🗑 Clear DJ Queue.

## Email alerts
- Each DJ request POSTs to the same activated FormSubmit form (same domain ⇒ no re-activation), subject `🎧 DJ Request: <song> — <artist>` to distinguish from Song List's 🎵 alerts.

## Out of scope (YAGNI)
- No server-side shared queue (consistent with existing architecture).
- No per-song "played" badges for freeform requests (admin just advances the queue).
