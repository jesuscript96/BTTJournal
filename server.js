const express = require('express');
const cors    = require('cors');
const path    = require('path');

const tradesRouter = require('./routes/trades');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/trades', tradesRouter);

// Fallback: sirve index.html para cualquier ruta no-API
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`BTT Journal corriendo en http://localhost:${PORT}`);
});
