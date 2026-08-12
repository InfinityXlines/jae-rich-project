# The Alice August 9 Schedule Update

## Source

- User-provided flyer: `/tmp/codex-remote-attachments/019fc56e-3125-71a3-bb46-79ca84dcb69c/F00640D5-8526-4A73-AAB2-E9F29AF8ED20/1-Photo-1.jpg`
- Explicit flyer details: Sunday, August 9, 2026; 11:00 AM-2:00 PM; The Alice in Destin; Stars, Stripes & Second Chances.

## Change

- Added The Alice fundraiser as the first August 9 schedule card.
- Reworded the public event label to `P.A.W.S. Fundraiser • Destin` at the user's request.
- Preserved the existing August 9 Sunquest Solaris performance as the second card.

## Verification

- Local source and deployment package: `153` cards, final date `2026-08-30`, and two ordered cards on `2026-08-09`.
- Production deployment: Wrangler direct upload of the four-file package derived from the fetched live HTML, with a diff limited to the requested August 9 card.
- Cloudflare Pages deployment: `https://bea9cddf.jae-rich-project.pages.dev`.
- Cache-busted custom domain: `153` cards, final date `2026-08-30`, and two August 9 cards. The Alice rendered first with `11:00 AM - 2:00 PM`.
- Normal custom-domain root: the same `153` cards and verified August 9 ordering and content.
- Wording follow-up deployment: `https://2e17d8b7.jae-rich-project.pages.dev`.
- Wording follow-up verification: both cache-busted and normal custom-domain pages serve `P.A.W.S. Fundraiser • Destin`; the prior event label is absent.
