// GET /api/index -> { generated, dates, stops }
const { getTimetable } = require("../lib/gtfs");

module.exports = async (req, res) => {
  try {
    const { meta } = await getTimetable();
    res.setHeader("Content-Type", "application/json");
    // Let Vercel's CDN serve this for an hour, and keep serving it while it refreshes.
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.end(JSON.stringify(meta));
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: `Couldn't get the GO timetable: ${err.message}` }));
  }
};
