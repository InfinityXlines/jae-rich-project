# Disaster Recovery — Jae Rich Project

Everything needed to rebuild the live song-request system from scratch.
Three pieces: **site** (Cloudflare Pages), **worker + database** (Cloudflare
Worker `jrp-live-queue` + D1), and **request history** (SQL dumps in
`../backups/`, kept outside this folder so they never deploy or hit git).

Account: `jrichproject@gmail.com` (Cloudflare). Auth: `npx wrangler login`.

## 1. Restore the site (jaerichent.com)

```bash
git clone git@github.com:InfinityXlines/jae-rich-project.git
cd jae-rich-project
git checkout dedications-band-queue   # the real site — main is only a QR stub
npx wrangler pages deploy . --project-name=jae-rich-project --branch=main
```

`--branch=main` is REQUIRED — without it wrangler names the deployment after
the git branch and creates a preview instead of production.

If the Pages project itself is gone: create project `jae-rich-project` in the
Cloudflare dashboard (direct upload), deploy as above, then re-attach the
custom domain `jaerichent.com` under Pages → Custom domains.

Quick rollback (no disaster needed): Cloudflare keeps every past deployment
under Pages → jae-rich-project → Deployments → Rollback.

## 2. Restore the worker

```bash
cd worker
npx wrangler deploy
npx wrangler secret put ADMIN_KEY   # paste any new strong value
```

A new ADMIN_KEY means a new dashboard URL:
`https://jrp-live-queue.jrichproject.workers.dev/admin?key=<NEW_KEY>` —
update the band's bookmarks. Worker versions can also be rolled back with
`npx wrangler rollback`.

## 3. Restore the database

```bash
cd worker
# If the D1 database is gone, recreate it and put the new database_id
# into wrangler.toml, then:
npx wrangler d1 execute jrp-live-queue --remote --file=schema.sql
npx wrangler d1 execute jrp-live-queue --remote --file=../../backups/jrp-live-queue-<LATEST>.sql
```

## Taking a fresh backup (do this every month or two)

```bash
cd worker
npx wrangler d1 export jrp-live-queue --remote \
  --output=../../backups/jrp-live-queue-$(date +%Y%m%d).sql
git push origin dedications-band-queue
```

Copy `/Volumes/Development/JRP/backups/` somewhere off this Mac
(iCloud/Drive/USB) — the SQL dumps hold the fans' request history and live
nowhere else. They stay out of git on purpose (fan names/comments).

## Gotchas learned the hard way

- Local worker testing: `wrangler dev`/`d1 --local` need
  `--persist-to <path on the boot volume>` — workerd's SQLite crashes on the
  external /Volumes/Development drive.
- FormSubmit activation is per-origin (jaerichent.com is activated; the
  monthly digest relay depends on it).
- The DJ tab's gig windows parse from the Dates cards; one-off windows live
  in `DJ_EXTRA_WINDOWS` / `DJ_EXACT_WINDOWS` in index.html — the worker
  re-parses the live HTML every 5 minutes, so windows need no worker deploy.
- Production Pages deploys always use `--branch=main`.
