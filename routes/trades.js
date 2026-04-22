const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

const getRow = db.prepare('SELECT value FROM trades_store WHERE key = ?');
const setRow = db.prepare('INSERT OR REPLACE INTO trades_store (key, value) VALUES (?, ?)');
const getMeta = db.prepare('SELECT value FROM meta_store WHERE key = ?');
const setMeta = db.prepare('INSERT OR REPLACE INTO meta_store (key, value) VALUES (?, ?)');

// GET /api/trades  — devuelve trades + meta
router.get('/', (req, res) => {
  try {
    const tradesRow = getRow.get('trades');
    const metaRow   = getMeta.get('meta');
    res.json({
      trades: tradesRow ? JSON.parse(tradesRow.value) : [],
      meta:   metaRow   ? JSON.parse(metaRow.value)   : {}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/trades  — guarda trades + meta de una sola vez
router.put('/', (req, res) => {
  try {
    const { trades, meta } = req.body;
    if (trades !== undefined) setRow.run('trades', JSON.stringify(trades));
    if (meta   !== undefined) setMeta.run('meta',  JSON.stringify(meta));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/trades  — borra todos los datos
router.delete('/', (req, res) => {
  try {
    db.prepare('DELETE FROM trades_store').run();
    db.prepare('DELETE FROM meta_store').run();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
