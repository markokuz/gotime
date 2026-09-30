// Downloads GO Transit's public GTFS feed and writes small static JSON files into public/data/
// so the site can run on any static host (e.g. GitHub Pages).
//
//   public/data/index.json       { generated, dates: [yyyymmdd...], stops: [{code, name}] }
//   public/data/<yyyymmdd>.json  { lines: [{name, colour}], trips: [[line, number, stop, arr, dep, stop, arr, dep, ...]] }
//
// In trips, stop is an index into index.json's stops; times are minutes after midnight
// (can exceed 1440 for after-midnight trains). arr = -1 means no drop-off, dep = -1 means no pickup.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const GTFS_URL = "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip";
const OUT = path.join(__dirname, "public", "data");

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

async function main() {
  console.log("⬇  Downloading GO GTFS feed…");
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed (${res.status})`);
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

  // Group trips by the dates they run on.
  const byDate = new Map();
  for (const t of trips.values()) {
    for (const date of serviceDates.get(t.service) || []) {
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(t);
    }
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const dates = [...byDate.keys()].sort();
  for (const date of dates) {
    const lines = [];
    const lineIdx = new Map();
    const out = byDate.get(date).map((t) => {
      if (!lineIdx.has(t.line)) { lineIdx.set(t.line, lines.length); lines.push(t.line); }
      const row = [lineIdx.get(t.line), t.number];
      for (const s of t.stops.sort((a, b) => a.seq - b.seq)) row.push(stopIndex.get(s.id), s.arr, s.dep);
      return row;
    });
    fs.writeFileSync(path.join(OUT, `${date}.json`), JSON.stringify({ lines, trips: out }));
  }
  fs.writeFileSync(
    path.join(OUT, "index.json"),
    JSON.stringify({ generated: new Date().toISOString(), dates, stops })
  );
  console.log(`✅ Wrote ${dates.length} days (${dates[0]}–${dates.at(-1)}), ${trips.size} train trips, ${stops.length} stations`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
