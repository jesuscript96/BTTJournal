const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'journal.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS trades_store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta_store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

module.exports = db;
