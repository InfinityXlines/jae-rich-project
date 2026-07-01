# DJ Requests Tab Label Update

## Issue

- Simone reported the live mobile request tab read `Song Requests`.
- Desired tab label: `DJ Requests`.
- Existing July/August date additions needed to stay live.
- Public Song List/Songlist UI needed to stay absent unless Simone explicitly asks for it.

## Change

- Updated `index.html` visible request tab label from `Song Requests` to `DJ Requests`.
- Updated the page title from `Live Song Requests` to `Live DJ Requests`.
- Updated the nearby internal script comment from `Song Request System` to `DJ Request System`.
- Did not change date cards, request form fields, Worker endpoint, or admin key handling.

## Verification

- Local source checks:
  - `local_cards=152`, `local_july_aug=46`, `local_unique_july_aug=45`, `local_last=2026-08-30`.
  - `Song Requests=0`, `DJ Requests=2`.
  - `Song List=0`, `panel-songs=0`, `tab-songs=0`.
  - `QUEUE_API=2`, `submitDedication=2`, `jrp-live-queue=1`.
- Local mobile browser check:
  - Title contained `Live DJ Requests`.
  - Tab text was `DJ Requests`.
  - DJ panel active and song input visible.
  - No Song List tab or panel existed.
- Cloudflare Pages deploy:
  - Uploaded narrow four-file package from `/tmp/jrp-dj-requests-label-pages-deploy-20260701`.
  - Package contents: `_headers`, `_redirects`, `index.html`, `tip-qr.jpg`.
- Live HTML checks:
  - `https://jaerichent.com/?codex_verify=dj_requests_label_20260701` and `https://jaerichent.com/` both returned:
    - `cards=152`, `july_aug=46`, `unique_july_aug=45`, `last=2026-08-30`.
    - `Song Requests=0`, `Song Request System=0`, `DJ Requests=2`, `DJ Request System=1`.
    - `Song List=0`, `panel-songs=0`, `tab-songs=0`, `switchTab('songs')=0`, `id="search"=0`.
    - `QUEUE_API=2`, `submitDedication=2`, `jrp-live-queue=1`.
- Live mobile browser check:
  - Title contained `Live DJ Requests`.
  - Tab text was `DJ Requests`.
  - DJ panel active and song input visible.
  - No Song List tab or panel existed.
- Live public request smoke:
  - Created temporary queue row `id=227`.
  - Worker POST returned `200` with body `{"ok":true}`.
  - Success UI was visible.
  - Deleted row `id=227`; row was not present after delete.
- Live admin UI smoke:
  - Created temporary queue row `id=228`.
  - Confirmed the temporary song rendered in the live admin UI.
  - Deleted row `id=228`; row was not present after delete.
