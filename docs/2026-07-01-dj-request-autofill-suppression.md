# DJ Request Autofill Suppression

## Issue

- Simone reported iOS/Chrome contact autofill suggestions appearing on the DJ request fields.
- Public Song List/Songlist UI must stay absent unless Simone explicitly asks for it.
- July/August 2026 date cards and the Worker-backed DJ request queue needed to remain live.

## Change

- Updated the DJ request and dedication fields in `index.html` to suppress browser/contact autofill:
  - `autocomplete="new-password"`
  - `autocorrect="off"`
  - `autocapitalize="off"`
  - `spellcheck="false"`
  - `data-form-type="other"`
  - `data-lpignore="true"`
  - `data-1p-ignore="true"`
- Fields updated: `dj-song`, `dj-artist`, `ded-years`, `ded-to`, `ded-from`, `ded-comments`.
- Preserved internal quick-pick song support for the DJ request form.
- Did not restore public Song List/Songlist UI.

## Deployment

- Built and deployed a narrow four-file Cloudflare Pages package:
  - `/tmp/jrp-no-dj-autofill-pages-deploy-20260701`
  - `_headers`, `_redirects`, `index.html`, `tip-qr.jpg`
- Deployed with Wrangler after OAuth was reauthorized for the JRP Cloudflare account.
- Wrangler OAuth needed an explicit local callback workaround: run Wrangler with an alternate local callback listener and bridge Cloudflare's fixed `localhost:8976` redirect to that listener. Do not store OAuth callback codes or admin keys in docs.
- Cloudflare Pages deployment URL returned: `https://ee361145.jae-rich-project.pages.dev`.

## Verification

- Live custom domain cache-busted HTML and root HTML both returned:
  - `cards=152`, `july_aug=46`, `unique_july_aug=45`, `last=2026-08-30`.
  - `autocomplete_new_password=6`, `autocorrect_off=6`, `autocapitalize_off=6`, `spellcheck_false=6`.
  - `data_form_type_other=6`, `lpignore=6`, `onep_ignore=6`.
  - `Song Requests=0`, `Song Request System=0`, `DJ Requests=2`, `DJ Request System=1`.
  - `Song List/Songlist=0`, `panel-songs=0`, `tab-songs=0`, `switchTab('songs')=0`.
  - `QUEUE_API=2`, `submitDedication=2`, `jrp-live-queue=1`.
- Production public-form smoke passed:
  - Worker POST status `200`.
  - Success message visible.
  - Temporary test row deleted.
  - Queue count after delete `0`.
- Production admin UI smoke passed:
  - Temporary request visible in admin UI.
  - Temporary test row deleted.
  - Queue count after delete `0`.

