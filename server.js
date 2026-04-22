const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const { initDB } = require('./db/database');

const tradesRouter = require('./routes/trades');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/trades', tradesRouter);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB()
  .then(() => app.listen(PORT, () => console.log(`BTT Journal en http://localhost:${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });

module.exports = app;
