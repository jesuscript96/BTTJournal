const express = require('express');
const router  = express.Router();
const { pool } = require('../db/database');

// GET /api/trades  — devuelve trades + meta
router.get('/', async (req, res) => {
  try {
    const [tradesRow, metaRow] = await Promise.all([
      pool.query('SELECT value FROM trades_store WHERE key = $1', ['trades']),
      pool.query('SELECT value FROM meta_store WHERE key = $1',   ['meta'])
    ]);
    res.json({
      trades: tradesRow.rows[0] ? JSON.parse(tradesRow.rows[0].value) : [],
      meta:   metaRow.rows[0]   ? JSON.parse(metaRow.rows[0].value)   : {}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/trades  — guarda trades + meta
router.put('/', async (req, res) => {
  try {
    const { trades, meta } = req.body;
    const upsert = 'INSERT INTO $1 (key, value) VALUES ($2, $3) ON CONFLICT (key) DO UPDATE SET value = $3';
    if (trades !== undefined) {
      await pool.query(
        'INSERT INTO trades_store (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        ['trades', JSON.stringify(trades)]
      );
    }
    if (meta !== undefined) {
      await pool.query(
        'INSERT INTO meta_store (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        ['meta', JSON.stringify(meta)]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/trades  — borra todos los datos
router.delete('/', async (req, res) => {
  try {
    await Promise.all([
      pool.query('DELETE FROM trades_store'),
      pool.query('DELETE FROM meta_store')
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
