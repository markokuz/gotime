// GET /api/live?from=UN&to=KI&trips=3859,3811&lines=KI
//   -> live delays, cancellations and alerts for just those trips, stations and lines
const { getLive } = require("../lib/live");

const CODE = /^[A-Za-z0-9]{1,10}$/;
const csv = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

module.exports = async (req, res) => {
  const send = (status, body, cache) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", cache ? "public, s-maxage=30, stale-while-revalidate=30" : "no-store");
    res.end(JSON.stringify(body));
  };
  const q = new URL(req.url, "http://localhost").searchParams;
  const from = q.get("from") || "", to = q.get("to") || "";
  const trips = csv(q.get("trips")), lines = csv(q.get("lines"));
  if (!CODE.test(from) || !CODE.test(to) || trips.length > 80 || ![...trips, ...lines].every((t) => CODE.test(t)))
    return send(400, { error: "Need from, to, and comma-separated trips/lines" });
  try {
    send(200, await getLive({ from, to, trips, lines }), true);
  } catch (err) {
    send(502, { error: `Couldn't get live train info: ${err.message}` });
  }
};
