# July and August 2026 Schedule Update

## Source

- `/Users/simonehunt/Downloads/1000007938.png` - July 2026 Solaris schedule image.
- `/Users/simonehunt/Downloads/1000007940.webp` - August 2026 Solaris schedule image.

## Change

- Added July 2026 and August 2026 Solaris date cards to `index.html`.
- Preserved the existing `.gig-card[data-date]` structure so the public Dates tab, DJ visibility logic, and worker schedule parser keep using the same source of truth.
- Added `data-order` to the two August 22 events so the private morning event appears before the public evening event.

## Verification

- Extracted the schedule cards from `index.html` and confirmed all 46 July/August events match the image transcription.
- Checked the 45 unique July/August dates against the 2026 calendar weekdays.
- Parsed the browser script with Node via `new Function(...)`.
- Rendered the page with Playwright screenshots at desktop and mobile widths.
- Ran a Playwright interaction check: loaded `#dates`, expanded `46 more dates`, verified July 2 and August 30 render, then scrolled to August 30 and confirmed the private 6:00 PM - 10:00 PM card was visible with opacity `1.0` and no page errors.

