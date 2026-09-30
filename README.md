# 🚆 GO Time

A tiny, cute page that shows every direct GO train between two stations on a given day
(defaults to Union → Kitchener).

**Live site:** https://markokuz.github.io/gotime/

## How it works

`build.js` downloads GO Transit's public GTFS timetable, keeps only the trains, and writes one
small JSON file per day into `public/data/`. The page reads those files and finds the trains in
your browser, so it's a fully static site.

A GitHub Action (`.github/workflows/pages.yml`) rebuilds the data and redeploys to GitHub Pages
on every push to `main` and once a day, so the timetable stays current (the feed covers ~2 months ahead).

## Run locally

```
npm run dev
```

Then open http://localhost:3000. Needs Node 18+, no dependencies, no API key.
