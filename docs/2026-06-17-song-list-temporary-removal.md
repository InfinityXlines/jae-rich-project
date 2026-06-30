# Song List Temporary Removal

## Issue: Public catalog should be hidden for now

**Error**: The live site still exposed the public Song List navigation, tab, search, filters, and full repertoire panel.

**Root Cause**: The Song List was implemented as a first-class tab and the `#songs` hash routed directly to the catalog panel.

**Resolution**: Removed the visible Song List menu item, main tab, and panel from `index.html`; old `#songs` links now route to Dates and rewrite the hash to `#dates`. The `SONGS` data and quick-pick logic remain available for the gig-time request flow and future reuse.

**Prevention**: If the public catalog is restored later, re-add the tab and panel intentionally and verify both normal navigation and old hash links in the browser.
