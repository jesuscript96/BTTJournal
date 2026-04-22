const express = require('express');
const router  = express.Router();
const { pool } = require('../db/database');

// GET /api/store/:key
router.get('/:key', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT value FROM kv_store WHERE key = $1',
      [req.params.key]
    );
    const row = result.rows[0];
    res.json(row ? JSON.parse(row.value) : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/store/:key
router.put('/:key', async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO kv_store (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [req.params.key, JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
