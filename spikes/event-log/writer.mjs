// Throwaway spike: append events to SQLite, report each committed index on stdout AFTER commit.
import { DatabaseSync } from "node:sqlite";

const [dbPath, syncMode, startIdx] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${syncMode};`);
db.exec("CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, idx INTEGER NOT NULL, payload TEXT NOT NULL)");
const ins = db.prepare("INSERT INTO events(idx, payload) VALUES (?, ?)");

let i = Number(startIdx);
for (;;) {
  db.exec("BEGIN IMMEDIATE");
  ins.run(i, "x".repeat(100));
  db.exec("COMMIT");
  process.stdout.write(`${i}\n`); // acknowledged only after commit returned
  i++;
}
