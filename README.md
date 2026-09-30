# 🚆 GO Time

A tiny, cute page that shows every direct GO train between two stations on a given day
(defaults to Union → Kitchener).

## Run it

```
npm start
```

Then open http://localhost:3000. Needs Node 18+, no dependencies, no API key.

## Where the data comes from

The server downloads GO Transit's public GTFS timetable
(`https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip`),
caches it in `.cache/` and refreshes it once a day. The feed covers roughly the next two months.
