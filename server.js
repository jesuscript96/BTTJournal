require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const { initDB } = require('./db/database');

const tradesRouter = require('./routes/trades');
const storeRouter  = require('./routes/store');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/trades', tradesRouter);
app.use('/api/store',  storeRouter);

app.get('/api/health', async (req, res) => {
  const { pool } = require('./db/database');
  const t0 = Date.now();
  try {
    const r = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM kv_store)     AS kv_rows,
        (SELECT COUNT(*) FROM trades_store) AS trade_rows,
        (SELECT COUNT(*) FROM meta_store)   AS meta_rows,
        NOW()                               AS db_time
    `);
    const { kv_rows, trade_rows, db_time } = r.rows[0];
    res.json({
      ok: true,
      latency_ms: Date.now() - t0,
      db_time,
      rows: { kv: Number(kv_rows), trades: Number(trade_rows) },
      env: process.env.NODE_ENV || 'development',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, latency_ms: Date.now() - t0 });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB()
  .then(() => app.listen(PORT, () => console.log(`BTT Journal en http://localhost:${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });

module.exports = app;
