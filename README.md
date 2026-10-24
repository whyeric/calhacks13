# Campus Pulse

Live map for large spaces. Deployment #1: Cal Hacks 13.0.

Stack: Vite + React + TypeScript, Leaflet (CRS.Simple over a floor-plan image), Convex (realtime DB + functions), Vercel (hosting).

## Run locally (5 min)

```bash
npm install
npx convex dev          # log in, create project "campus-pulse"; writes .env.local, regenerates convex/_generated
                        # leave it running (it hot-pushes functions)
npx convex run seed:run # in a 2nd terminal: loads the venue pins
npm run dev             # http://localhost:5173  (status pill should say "Live")
```

Without `VITE_CONVEX_URL` the app runs in **Preview** mode: pins come straight from the venue config, no backend.

## Deploy (link works on any phone)

1. Push this folder to a GitHub repo.
2. Convex dashboard → your project → **Settings → URL & Deploy Key** → generate a **Production deploy key**.
3. Vercel → **Add New Project** → import the repo. `vercel.json` already sets the build command
   (`npx convex deploy --cmd 'npm run build'`), so just add one env var:
   `CONVEX_DEPLOY_KEY` = the key from step 2. Deploy.
4. Seed production once: `npx convex run --prod seed:run`

After that, every `git push` redeploys both the frontend and the Convex functions.

## Placing pins on the real venue map

1. The floor plan is `src/assets/floorplan.webp`, a top-down screenshot of the venue's own indoor map
   (cropped, background made transparent). To replace it, keep the camera flat (no 3D tilt) and update the import
   in `src/MapView.tsx` if the file type changes.
2. Set `floorplan.width/height` in `convex/venues/calhacks.ts` to the image's pixel size.
3. Open the app with `?edit=1`, tap each spot, and paste the copied `x, y` into the pin list.
4. `npx convex run seed:run` (add `--prod` for the live site). Re-running is safe; pins upsert by `slug`.

## Layout

```
convex/
  schema.ts            pins table (source: seed | ai | user; startsAt/endsAt for AI-extracted events)
  pins.ts              pins.list query (reactive)
  seed.ts              seed:run, upserts the venue config
  venues/calhacks.ts   venue config: floor-plan size, seed pins, pin kinds/colors
src/
  main.tsx             Live (Convex) vs Preview (static) switch
  App.tsx              top bar, filter chips, pin detail sheet, ?edit=1 coordinate picker
  MapView.tsx          Leaflet map
```

## Next (step 2): check-ins

- `checkins` table: `{ pinId, sessionId, expiresAt }` with indexes `by_pin` and `by_expiry`.
- `checkins.checkIn` mutation: one active check-in per anonymous `sessionId` (random id in localStorage); upsert, `expiresAt = now + 30 min`.
- Counts: keep a `count` field on each pin, incremented/decremented by the mutations, so `pins.list` stays a cheap reactive query.
  Don't filter by `Date.now()` inside a query; let a cron do expiry.
- `convex/crons.ts`: every minute, delete check-ins with `expiresAt < now` and decrement their pin counts.
