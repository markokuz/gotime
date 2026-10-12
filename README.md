# 🚆 GO Time

A tiny, page that shows every direct GO train between two stations on a given day
(defaults to Union → Kitchener).

## How it works

- `lib/gtfs.js` downloads GO Transit's public GTFS timetable, keeps only the trains, and groups
  them by day. It keeps the result in memory and pulls a fresh copy every 6 hours.
- `api/index.js` (stations + available dates) and `api/day.js` (one day's trains) are Vercel
  functions. Vercel's CDN caches their responses for an hour, so most visits never wait on a download.
- `api/live.js` (with `lib/live.js`) adds live delays, cancellations, platforms and service alerts
  from the Metrolinx Open Data API, filtered to just the stations, line and trains on screen. It only
  runs for today's date and refreshes every minute. It needs the `METROLINX_API_KEY` environment
  variable (in Vercel: Settings → Environment Variables; locally: copy `.env.example` to `.env`).
  Without a key the site still works, just without live status.
- `public/index.html` is the whole front end: it loads a day and finds the direct trains in your browser.

## Run locally

```
npm start
```

Then open http://localhost:3000. Needs Node 18+, no dependencies.
