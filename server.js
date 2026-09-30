// Tiny zero-dependency server: serves the page and answers schedule questions
// from GO Transit's public GTFS feed (no API key needed).
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;
const GTFS_URL = "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip";
const CACHE = path.join(__dirname, ".cache", "GO-GTFS.zip");
const MAX_AGE = 24 * 60 * 60 * 1000; // re-download once a day

// ---------- zip + csv helpers ----------

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

// ---------- load the timetable ----------

let db = null;
let loading = null;

async function getZip() {
  try {
    const stat = fs.statSync(CACHE);
    if (Date.now() - stat.mtimeMs < MAX_AGE) return fs.readFileSync(CACHE);
  } catch {}
  console.log("⬇  Downloading GO GTFS feed…");
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, buf);
  return buf;
}

async function load() {
  const files = unzip(await getZip(), ["routes.txt", "trips.txt", "stop_times.txt", "stops.txt", "calendar_dates.txt"]);

  const railRoutes = new Map(); // route_id -> { name, colour }
  eachRow(files["routes.txt"], (r) => {
    if (r.route_type === "2") railRoutes.set(r.route_id, { name: r.route_long_name, colour: r.route_color });
  });

  const services = new Map(); // service_id -> Set of yyyymmdd
  eachRow(files["calendar_dates.txt"], (r) => {
    if (r.exception_type !== "1") return;
    if (!services.has(r.service_id)) services.set(r.service_id, new Set());
    services.get(r.service_id).add(r.date);
  });

  const trips = new Map(); // trip_id -> { service, line, colour, number, stops: Map(stop_id -> {...}) }
  eachRow(files["trips.txt"], (r) => {
    const route = railRoutes.get(r.route_id);
    if (!route) return;
    trips.set(r.trip_id, {
      service: r.service_id,
      line: route.name,
      colour: route.colour,
      number: r.trip_short_name || r.trip_id.split("-").pop(),
      stops: new Map(),
    });
  });

  const usedStops = new Set();
  eachRow(files["stop_times.txt"], (r) => {
    const trip = trips.get(r.trip_id);
    if (!trip) return;
    trip.stops.set(r.stop_id, {
      seq: +r.stop_sequence,
      arr: toMin(r.arrival_time),
      dep: toMin(r.departure_time),
      canBoard: r.pickup_type !== "1",
      canAlight: r.drop_off_type !== "1",
    });
    usedStops.add(r.stop_id);
  });

  const stops = [];
  eachRow(files["stops.txt"], (r) => {
    if (usedStops.has(r.stop_id)) stops.push({ code: r.stop_id, name: r.stop_name.replace(/ GO$/, "") });
  });
  stops.sort((a, b) => a.name.localeCompare(b.name));

  db = { trips: [...trips.values()], services, stops, loadedAt: Date.now() };
  console.log(`✅ Loaded ${db.trips.length} train trips, ${stops.length} stations`);
  return db;
}

async function getDb() {
  if (db && Date.now() - db.loadedAt < MAX_AGE) return db;
  if (!loading) loading = load().finally(() => (loading = null));
  return db || loading; // serve stale data while refreshing
}

// Every direct train on `date` that stops at `from` and later at `to`.
function schedule({ trips, services }, date, from, to) {
  const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const out = [];
  for (const t of trips) {
    if (!services.get(t.service)?.has(date)) continue;
    const a = t.stops.get(from);
    const b = t.stops.get(to);
    if (!a || !b || a.seq >= b.seq || !a.canBoard || !b.canAlight) continue;
    const mins = b.arr - a.dep;
    out.push({
      depart: hhmm(a.dep),
      arrive: hhmm(b.arr),
      departMin: a.dep,
      nextDay: a.dep >= 24 * 60,
      duration: mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`,
      line: t.line,
      colour: t.colour,
      number: t.number,
    });
  }
  return out.sort((x, y) => x.departMin - y.departMin);
}

// ---------- http ----------

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const PUBLIC = path.join(__dirname, "public");

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === "/api/stops") return json(200, (await getDb()).stops);
      if (url.pathname === "/api/schedule") {
        const { date, from, to } = Object.fromEntries(url.searchParams);
        if (!/^\d{8}$/.test(date || "") || !from || !to)
          return json(400, { error: "Need date (yyyymmdd), from and to" });
        return json(200, schedule(await getDb(), date, from, to));
      }
      const file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);
      if (!file.startsWith(PUBLIC)) return json(403, { error: "nope" });
      const body = await fs.promises.readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch (err) {
      if (err.code === "ENOENT") return json(404, { error: "Not found" });
      json(500, { error: err.message });
    }
  })
  .on("error", (err) => {
    if (err.code !== "EADDRINUSE") throw err;
    console.error(`❌ Port ${PORT} is already in use (is GO Time already running?). Stop it, or use another port.`);
    process.exit(1);
  })
  .listen(PORT, () => {
    console.log(`🚆 GO Time running at http://localhost:${PORT}`);
    getDb().catch((e) => console.error("Failed to load timetable:", e.message));
  });
