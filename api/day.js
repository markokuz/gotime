// GET /api/day?date=yyyymmdd -> { lines, trips } for every train running that day
const { getTimetable } = require("../lib/gtfs");

module.exports = async (req, res) => {
  const send = (status, body, cache) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    if (cache) res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.end(JSON.stringify(body));
  };
  const date = new URL(req.url, "http://localhost").searchParams.get("date") || "";
  if (!/^\d{8}$/.test(date)) return send(400, { error: "Need ?date=yyyymmdd" });
  try {
    const day = (await getTimetable()).days.get(date);
    if (!day) return send(404, { error: "No timetable for that day" });
    send(200, day, true);
  } catch (err) {
    send(502, { error: `Couldn't get the GO timetable: ${err.message}` });
  }
};
