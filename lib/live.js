// Live status from the Metrolinx Open Data API, narrowed to one route:
// only the trips, lines and stations the visitor is looking at are returned.
// The access key lives in the METROLINX_API_KEY environment variable and never reaches the browser.
const BASE = "https://api.openmetrolinx.com/OpenDataAPI/api/V1";
const apiKey = () => process.env.METROLINX_API_KEY || process.env.METROLINX_KEY || "";

// Upstream responses are shared by every visitor for a short time, so busy moments
// don't multiply calls to Metrolinx.
const cache = new Map(); // path -> { at, promise }
function get(path, ttl) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = (async () => {
    const res = await fetch(`${BASE}${path}?key=${encodeURIComponent(apiKey())}`);
    if (!res.ok) throw new Error(`Metrolinx API ${res.status}`);
    const data = await res.json();
    const code = data?.Metadata?.ErrorCode;
    if (code && code !== "200") throw new Error(`Metrolinx API: ${data.Metadata.ErrorMessage || code}`);
    return data;
  })();
  cache.set(path, { at: Date.now(), promise });
  promise.catch(() => cache.delete(path));
  return promise;
}

// The API wraps lists inconsistently ([...], {Line: [...]}, a single object, or null).
const list = (x) => {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  const inner = Object.values(x).find(Array.isArray);
  return inner || [x];
};
const yes = (v) => v === true || /^(1|true|y)/i.test(String(v ?? ""));
const tripId = (n) => String(n ?? "").trim().replace(/^0+(?=\d)/, "");
// "2026-10-12 08:49:00" / "08:49" -> minutes after midnight
const toMin = (s) => {
  const m = String(s ?? "").match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*$/);
  return m ? +m[1] * 60 + +m[2] : null;
};

async function getLive({ from, to, trips, lines }) {
  if (!apiKey()) return { enabled: false };
  const wanted = new Set(trips.map(tripId));
  const out = new Map(); // trip number -> status
  const status = (n) => {
    if (!out.has(n)) out.set(n, {});
    return out.get(n);
  };

  const [next, trains, exceptions, alerts] = await Promise.allSettled([
    get(`/Stop/NextService/${from}`, 30_000),
    get("/ServiceataGlance/Trains/All", 30_000),
    get("/ServiceUpdate/Exceptions/Train", 60_000),
    get("/ServiceUpdate/ServiceAlert/All", 60_000),
  ]);

  // Predicted departure and platform at the "from" station.
  if (next.status === "fulfilled") {
    for (const l of list(next.value?.NextService?.Lines)) {
      const n = tripId(l.TripNumber);
      if (!wanted.has(n)) continue;
      const sch = toMin(l.ScheduledDepartureTime);
      const exp = toMin(l.ComputedDepartureTime);
      Object.assign(status(n), {
        departs: exp ?? undefined,
        departDelay: sch != null && exp != null ? ((exp - sch + 1440 + 720) % 1440) - 720 : undefined,
        platform: (l.ActualPlatform || l.ScheduledPlatform || "").trim() || undefined,
        note: (l.DepartureStatus || l.Status || "").trim() || undefined,
      });
    }
  }

  // Trains already running: how late they are and where they are.
  if (trains.status === "fulfilled") {
    for (const t of list(trains.value?.Trips)) {
      const n = tripId(t.TripNumber);
      if (!wanted.has(n)) continue;
      Object.assign(status(n), {
        running: true,
        delay: Math.round((Number(t.DelaySeconds) || 0) / 60),
        at: t.AtStationCode || undefined,
        nextStop: t.NextStopCode || undefined,
      });
    }
  }

  // Cancellations, either the whole trip or one of our two stations being skipped.
  if (exceptions.status === "fulfilled") {
    for (const t of list(exceptions.value?.Trip ?? exceptions.value?.Trips)) {
      const n = tripId(t.TripNumber);
      if (!wanted.has(n)) continue;
      const skipped = list(t.Stop ?? t.Stops)
        .filter((s) => (s.Code === from || s.Code === to) && (yes(s.IsCancelled) || (s.IsStopping != null && !yes(s.IsStopping))))
        .map((s) => s.Code);
      if (yes(t.IsCancelled)) status(n).cancelled = true;
      else if (skipped.length) status(n).skips = skipped;
    }
  }

  // Service alerts that mention this line, either station, or one of these trips.
  const lineSet = new Set(lines);
  const relevant = [];
  if (alerts.status === "fulfilled") {
    for (const m of list(alerts.value?.Messages)) {
      const hit =
        list(m.Lines).some((l) => lineSet.has(l.Code)) ||
        list(m.Stops).some((s) => s.Code === from || s.Code === to) ||
        list(m.Trips).some((t) => wanted.has(tripId(t.TripNumber)));
      if (hit && m.Status !== "DELETED")
        relevant.push({
          subject: (m.SubjectEnglish || "").trim(),
          body: (m.BodyEnglish || "").trim(),
          posted: m.PostedDateTime || null,
        });
    }
  }

  const failed = [next, trains, exceptions, alerts].filter((r) => r.status === "rejected");
  if (failed.length === 4) throw failed[0].reason;
  return {
    enabled: true,
    updated: new Date().toISOString(),
    trips: Object.fromEntries(out),
    alerts: relevant,
    partial: failed.length > 0,
  };
}

module.exports = { getLive };
