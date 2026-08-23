# jaerichent.com known-good freeze — 2026-08-23 (America/Chicago)

## Why
User confirmed the live site is working and asked to save current state before any changes.

## Production facts
- Live URL: https://jaerichent.com/
- Hosting: Cloudflare (Pages or Workers static) — NOT GitHub `main`
- GitHub `main` (`3d165407`) is only a QR redirect to jaerichent.com
- Open PR stack (#1/#2/#3) is NOT what to merge blindly; live HTML differs from `dedications-band-queue` tip (live title/canonical branding ahead of that branch)
- Live CSP connect-src includes: formsubmit.co + https://jrp-live-queue.jrichproject.workers.dev
- Worker: `jrp-live-queue` (id tag f60f78644dd1491d818fed491137fd4a), account jrichproject

## Freeze artifacts
- index.html — downloaded from https://jaerichent.com/ at freeze time
- headers.txt — response headers
- favicon.svg, tip-qr.jpg — live assets
- sha256 of index.html recorded below

## Guardrails
- Do NOT merge jae-rich-project PRs #1/#2/#3 without L'Mont approval
- Do NOT redeploy Cloudflare from GitHub `main` (redirect-only)
- Do NOT overwrite Cloudflare production without an explicit ship ask
- Restore path: redeploy this frozen index.html (and worker snapshot if needed) to Cloudflare

sha256: 5b52fad084ae5ae4509f40431caf3cafd85f0fa5309479b7e601b1096ae02124
bytes: 170953
frozen_at_utc: 2026-08-23T18:02:42Z
