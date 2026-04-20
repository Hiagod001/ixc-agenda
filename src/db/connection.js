const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// Mantém o mesmo comportamento do projeto original: arquivo agenda.db na raiz do projeto
const dbPath = process.env.DB_PATH || path.join(process.cwd(), "agenda.db");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA temp_store = MEMORY");
  db.run("PRAGMA cache_size = -20000");
  db.run("PRAGMA busy_timeout = 5000");
});

module.exports = { db, dbPath };
