// Downloads GO Transit's public GTFS feed and turns it into compact, per-day train timetables.
// Kept in memory and refreshed every few hours, so the site always pulls the latest file itself.
//
//   meta: { generated, published, dates: [yyyymmdd...], stops: [{code, name}] }
//         generated = when we pulled the file, published = when GO last updated it (ISO strings)
//   day:  { lines: [{name, colour}], trips: [[line, number, stop, arr, dep, stop, arr, dep, ...]] }
//
// In trips, stop is an index into meta.stops; times are minutes after midnight
// (can exceed 1440 for after-midnight trains). arr = -1 means no drop-off, dep = -1 means no pickup.
const zlib = require("zlib");

const GTFS_URL = "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip";
const MAX_AGE = 6 * 60 * 60 * 1000; // re-download every 6 hours

// Minimal zip reader: returns { filename: Buffer } for the files we ask for.
function unzip(buf, wanted) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("Bad zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (wanted.includes(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      out[name] = method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Calls onRow(row) with an object per CSV line. GTFS here has no quoted commas in the columns we use.
function eachRow(buf, onRow) {
  const text = buf.toString("utf8").replace(/^﻿/, "");
  let pos = text.indexOf("\n");
  const cols = text.slice(0, pos).trim().split(",");
  while (pos < text.length) {
    let end = text.indexOf("\n", pos + 1);
    if (end === -1) end = text.length;
    const line = text.slice(pos + 1, end).replace(/\r$/, "");
    pos = end;
    if (!line) continue;
    const vals = line.split(",");
    const row = {};
    for (let i = 0; i < cols.length; i++) row[cols[i]] = vals[i];
    onRow(row);
  }
}

const toMin = (t) => { const [h, m] = t.split(":"); return +h * 60 + +m; };

async function build() {
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed (${res.status})`);
  const lastModified = Date.parse(res.headers.get("last-modified") || "");
  const files = unzip(Buffer.from(await res.arrayBuffer()), [
    "routes.txt", "trips.txt", "stop_times.txt", "stops.txt", "calendar_dates.txt",
  ]);

  const railRoutes = new Map(); // route_id -> { name, colour }
  eachRow(files["routes.txt"], (r) => {
    if (r.route_type === "2") railRoutes.set(r.route_id, { name: r.route_long_name, colour: r.route_color });
  });

  const serviceDates = new Map(); // service_id -> [yyyymmdd]
  eachRow(files["calendar_dates.txt"], (r) => {
    if (r.exception_type !== "1") return;
    if (!serviceDates.has(r.service_id)) serviceDates.set(r.service_id, []);
    serviceDates.get(r.service_id).push(r.date);
  });

  const trips = new Map(); // trip_id -> { service, line, number, stops: [] }
  eachRow(files["trips.txt"], (r) => {
    const route = railRoutes.get(r.route_id);
    if (!route) return;
    trips.set(r.trip_id, {
      service: r.service_id,
      line: route,
      number: r.trip_short_name || r.trip_id.split("-").pop(),
      stops: [],
    });
  });

  eachRow(files["stop_times.txt"], (r) => {
    const trip = trips.get(r.trip_id);
    if (!trip) return;
    trip.stops.push({
      id: r.stop_id,
      seq: +r.stop_sequence,
      arr: r.drop_off_type === "1" ? -1 : toMin(r.arrival_time),
      dep: r.pickup_type === "1" ? -1 : toMin(r.departure_time),
    });
  });

  const used = new Set([...trips.values()].flatMap((t) => t.stops.map((s) => s.id)));
  const stops = [];
  eachRow(files["stops.txt"], (r) => {
    if (used.has(r.stop_id)) stops.push({ code: r.stop_id, name: r.stop_name.replace(/ GO$/, "") });
  });
  stops.sort((a, b) => a.name.localeCompare(b.name));
  const stopIndex = new Map(stops.map((s, i) => [s.code, i]));

  // Group trips by the dates they run on, in the compact format described at the top.
  const days = new Map();
  for (const t of trips.values()) {
    const row = [0, t.number];
    for (const s of t.stops.sort((a, b) => a.seq - b.seq)) row.push(stopIndex.get(s.id), s.arr, s.dep);
    for (const date of serviceDates.get(t.service) || []) {
      if (!days.has(date)) days.set(date, { lines: [], lineIdx: new Map(), trips: [] });
      const day = days.get(date);
      if (!day.lineIdx.has(t.line)) { day.lineIdx.set(t.line, day.lines.length); day.lines.push(t.line); }
      day.trips.push([day.lineIdx.get(t.line), ...row.slice(1)]);
    }
  }
  for (const day of days.values()) delete day.lineIdx;

  return {
    meta: {
      generated: new Date().toISOString(),
      published: Number.isNaN(lastModified) ? null : new Date(lastModified).toISOString(),
      dates: [...days.keys()].sort(),
      stops,
    },
    days,
    loadedAt: Date.now(),
  };
}

let cache = null;
let loading = null;

// Returns the timetable, downloading it when missing or stale (stale data is served while refreshing).
async function getTimetable() {
  if (cache && Date.now() - cache.loadedAt < MAX_AGE) return cache;
  if (!loading) {
    loading = build()
      .then((t) => (cache = t))
      .finally(() => (loading = null));
  }
  return cache || loading;
}

module.exports = { getTimetable };
