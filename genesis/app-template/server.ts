// Open Platform app template: zero npm dependencies, one file, real data.
// The platform provides DATA_DIR (durable, snapshotted, branched) and PORT.
import { Database } from "bun:sqlite";
import { join } from "node:path";

const dataDir = process.env["DATA_DIR"] ?? "/data";
const db = new Database(join(dataDir, "app.db"), { create: true });
db.exec(
  "PRAGMA journal_mode = WAL;" +
    "PRAGMA busy_timeout = 5000;" +
    "CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL)",
);

Bun.serve({
  port: Number(process.env["PORT"] ?? 8080),
  fetch(req) {
    db.run("INSERT INTO visits (at) VALUES (?)", [new Date().toISOString()]);
    const row = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM visits")
      .get();
    return Response.json({
      app: process.env["OP_APP"] ?? "app",
      owner: process.env["OP_OWNER"] ?? null,
      user: req.headers.get("x-plat-user"),
      visits: row?.n ?? 0,
    });
  },
});

console.log("app listening");
