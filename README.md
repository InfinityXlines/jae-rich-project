# 🎤 THE JAE RICH PROJECT — Live Song Requests

A modern, mobile-first website for **The Jae Rich Project** — a vocalist & guitarist duo covering rock, soul, pop, funk, motown, top 40 and beyond.

## Features

- **Upcoming dates** for live appearances
- **Gig-time song requests** with optional dedications
- **Internal song catalog** retained for request quick-pick and future public reuse
- **Admin mode** — triple-tap 🎛️ to mark songs played, skip, or reset
- **Mobile-first** responsive design with neo-soul dark aesthetic
- **Email alerts** — every live song request emails jrichproject@gmail.com instantly (via FormSubmit, no backend needed)
- **Stage Motion layer** — cinematic hero entrance, scroll-reveal gig cards, springy modal/toast, live-queue equalizer, gold arrival flash on new requests; fully respects `prefers-reduced-motion`

## Current Public Song List Status

The public Song List tab is temporarily removed from the visible website. The `SONGS` data remains in `index.html` so the DJ/Song Requests quick-pick can keep working and the public catalog can be restored later without rebuilding the repertoire list.

## Email Alert Setup (one-time)

The first request submitted from the live site triggers a **FormSubmit activation email** to `jrichproject@gmail.com`. Click the confirmation link in that email once, and every request after that lands in the inbox automatically (song, artist, requester name, time). No account or API key required.

## Quick Start

Just open `index.html` in a browser. That's it — everything is in one file.

## Deploy

Enable GitHub Pages (Settings → Pages → Source: main branch) and the site goes live at:
`https://infinityxlines.github.io/jae-rich-project/`

## Admin Controls

- **Triple-tap** the 🎛️ icon in the footer, or press `Ctrl+Shift+A`
- Mark Next as Played / Skip / Clear Queue / Reset All

---

*Built with ❤️ by Simone for The Jae Rich Project — Emerald Coast, FL*
