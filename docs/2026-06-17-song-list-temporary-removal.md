# Song List Temporary Removal

## Issue: Public Catalog Should Stay Hidden

**Error**: Live site still exposed public Song List navigation, tab, search, filters, and full repertoire panel.

**Root Cause**: Song List was implemented as a first-class `#songs` tab hash routed directly to the catalog panel.

**Resolution**: Removed visible Song List menu item, main tab, and panel from `index.html`; old `#songs` links now route to the Dates hash `#dates`. `SONGS` data and quick-pick logic may remain available for the gig-time request flow.

## Production Redeploy - 2026-06-30

- Rebuilt a narrow Cloudflare Pages direct-upload package from the deployed July/August schedule package with public Song List entry points removed.
- Local package checks: `Song List=0`, `panel-songs=0`, `tab-songs=0`, `switchTab('songs')=0`, `package_cards=151`, `package_july_aug=46`, `package_last=2026-08-30`.
- Live verification deploy:
  - `https://jaerichent.com/`: `root_songlist_counts 0 0 0 0 0 0`, `root_cards=151`, `root_july_aug=46`, `root_last=2026-08-30`.
  - `https://jaerichent.com/?codex_verify=remove_songlist_20260630`: `final_songlist_counts 0 0 0 0 0 0`, `final_cards=151`, `final_july_aug=46`, `final_last=2026-08-30`.

## Prevention

Do not restore the public Song List, Songlist, `#songs` tab, song-search panel, or visible repertoire catalog unless Simone explicitly asks for it. The internal `SONGS` data may remain only for DJ quick-pick/request flow support.

If the public catalog is intentionally restored later, re-add the tab panel deliberately and verify normal navigation plus old hash links in browser.
