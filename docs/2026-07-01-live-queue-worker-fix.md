# Live Queue Worker Fix

## Issue

- Simone reported the live request/admin page was not populating songs.
- The deployed public site was not posting DJ requests to the Worker queue, so the admin page had nothing new to show.

## Root Cause

- The active live deployment had drifted behind the repo source and still used the older local/FormSubmit request path.
- The current `dedications-band-queue` repo source has the correct Worker-backed path: `QUEUE_API`, `submitDedication()`, and `#dj-submit` posting to `https://jrp-live-queue.jrichproject.workers.dev/api/requests`.

## Change

- Built a narrow Cloudflare Pages package from commit `4bdc967d4b9a413233c78135fea590ca12e01192` on branch `dedications-band-queue`.
- Package path: `/tmp/jrp-worker-queue-pages-deploy-20260701`.
- Package contents: `_headers`, `_redirects`, `index.html`, `tip-qr.jpg`.
- Deployed through Cloudflare Pages direct upload in Chrome.
- Preserved the public Song List removal. Do not restore public Song List/Songlist UI unless Simone explicitly asks.

## Verification

- Live cache-busted HTML `https://jaerichent.com/?codex_verify=worker_queue_fix_20260701`:
  - `Song List=0`, `panel-songs=0`, `tab-songs=0`, `switchTab('songs')=0`, `id="search"=0`.
  - `QUEUE_API=2`, `submitDedication=2`, `jrp-live-queue=1`.
  - `cards=152`, `july_aug=46`, `unique_july_aug=45`, `last=2026-08-30`.
- Live root HTML `https://jaerichent.com/` returned the same counts.
- Production public-form smoke:
  - Submitted `Codex Production Queue Smoke Remove Me 1782865199` from `https://jaerichent.com/?djtest=1#dj`.
  - Browser posted to `https://jrp-live-queue.jrichproject.workers.dev/api/requests`.
  - Worker response status `200`, body `{"ok":true}`.
  - Success UI was visible.
  - Created queue row `id=210`.
  - Deleted row `id=210`; queue count after delete `0`.
- Admin UI smoke:
  - Created temporary queue row `id=211`.
  - Loaded the live admin page with the admin key omitted from this note.
  - Confirmed the temporary song text rendered in the admin UI.
  - Deleted row `id=211`; queue count after delete `0`.
