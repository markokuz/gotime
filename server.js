// Local development server: serves public/ and the same /api functions Vercel runs.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };
const API = { "/api/index": require("./api/index"), "/api/day": require("./api/day") };

http
  .createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (API[pathname]) return API[pathname](req, res);
    const file = path.join(PUBLIC, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
    try {
      const body = await fs.promises.readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .on("error", (err) => {
    if (err.code !== "EADDRINUSE") throw err;
    console.error(`❌ Port ${PORT} is already in use (is GO Time already running?). Stop it, or use another port.`);
    process.exit(1);
  })
  .listen(PORT, () => console.log(`🚆 GO Time running at http://localhost:${PORT}`));
