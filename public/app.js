// STATE
// ═══════════════════════════════
let trades    = [];
let displayed = [];
let activeTab = 'trades';
let filters   = { result:'all', type:'all', hour:'all' };
let sortBy    = { col:null, dir:'asc' };
let pendingFile = null;
let equityChart = null;
let equityMode  = 'r'; // 'r' | 'dollar' | 'gross'
let lastImport  = null;

let PATTERNS = ['','Breakout','BO Interno','Gap&Go','G&E','G&C','SIR','Testing','VWAP Bounce','VWAP Reclaim','Cruce VWAP short'];

const MONTHS_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const DAYS_ES   = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];

// ═══════════════════════════════
// TRADE CHART MODAL
// ═══════════════════════════════
let chartInstance = null;
let chartRawBars  = [];   // 1-min raw bars cached
let chartSymbol   = null;
let chartDateISO  = null;
let chartTF       = 1;

async function openTradeChart(symbol, dateISO) {
  if (!dateISO) { alert('Este trade no tiene fecha ISO guardada. Re-importa el XLS.'); return; }
  loadMassiveKey(); // ensure massiveKey global is fresh
  if (!massiveKey) { alert('Necesitas configurar tu API key de Massive en Ajustes.'); return; }
  if (typeof LightweightCharts === 'undefined') {
    alert('La librería de gráficos no está cargada. Comprueba tu conexión a internet y recarga la página.');
    return;
  }

  chartSymbol  = symbol;
  chartDateISO = dateISO;
  chartTF      = 1;

  // Update header
  document.getElementById('cm-ticker').textContent = symbol;
  document.getElementById('cm-date').textContent   = dateISO;
  document.getElementById('cm-loading').style.display = '';
  document.getElementById('cm-loading').textContent   = 'Cargando velas de 1min...';
  if (chartInstance) { chartInstance.remove(); chartInstance = null; }

  // Show trades for this symbol+date
  const dayTrades = trades.filter(t => t.symbol === symbol && t.dateISO === dateISO)
                          .sort((a,b) => a.openedHour?.localeCompare(b.openedHour));
  document.getElementById('cm-trades').innerHTML = dayTrades.map(t =>
    `<span class="chart-trade-pill ${t.type?.toLowerCase()==='short'?'short':'long'}">
      ${t.type?.toUpperCase()||'L'} ${t.qty} @ $${t.entry?.toFixed(2)} → $${t.exit?.toFixed(2)}
      <span style="color:${t.net>=0?'#3dba6f':'#e05252'}"> ${t.net>=0?'+':''}$${t.net?.toFixed(2)}</span>
    </span>`
  ).join('');

  // Summary bar
  const totalNet = dayTrades.reduce((s,t)=>s+t.net,0);
  const wins = dayTrades.filter(t=>t.resultado==='P').length;
  document.getElementById('cm-summary').innerHTML = `
    <div class="chart-summary-item"><div class="chart-summary-label">TRADES</div><div class="chart-summary-val">${dayTrades.length}</div></div>
    <div class="chart-summary-item"><div class="chart-summary-label">WIN RATE</div><div class="chart-summary-val">${dayTrades.length?(wins/dayTrades.length*100).toFixed(0)+'%':'—'}</div></div>
    <div class="chart-summary-item"><div class="chart-summary-label">NET DÍA</div><div class="chart-summary-val" style="color:${totalNet>=0?'#3dba6f':'#e05252'}">${totalNet>=0?'+':''}$${totalNet.toFixed(2)}</div></div>
    <div class="chart-summary-item"><div class="chart-summary-label">GAP%</div><div class="chart-summary-val">${dayTrades[0]?.mGapPct!=null?dayTrades[0].mGapPct.toFixed(1)+'%':'—'}</div></div>
    <div class="chart-summary-item"><div class="chart-summary-label">PM HIGH</div><div class="chart-summary-val">${dayTrades[0]?.mPMHigh?'$'+dayTrades[0].mPMHigh.toFixed(2):'—'}</div></div>
    <div class="chart-summary-item"><div class="chart-summary-label">PM VOL</div><div class="chart-summary-val">${dayTrades[0]?.mPMVol?fmtVol(dayTrades[0].mPMVol):'—'}</div></div>
    <div class="chart-summary-item"><div class="chart-summary-label">FLOAT</div><div class="chart-summary-val">${dayTrades[0]?.mFloat?fmtFloat(dayTrades[0].mFloat):'—'}</div></div>
    <div class="chart-summary-item" style="color:var(--dim);font-size:10px;align-self:center;font-family:var(--sans)">Click en vela para ver precio · Arrastra para mover · Scroll para zoom</div>
  `;

  document.getElementById('chart-modal-overlay').classList.add('open');

  // Fetch 1-min bars: 4am ET → 4pm ET
  try {
    const utcOffset = isDST(new Date(dateISO + 'T12:00:00Z')) ? 4 : 5;
    const fromMs = new Date(`${dateISO}T${String(4  + utcOffset).padStart(2,'0')}:00:00Z`).getTime();
    const toMs   = new Date(`${dateISO}T${String(16 + utcOffset).padStart(2,'0')}:00:00Z`).getTime();

    const resp = await massiveFetch(`/v2/aggs/ticker/${symbol}/range/1/minute/${fromMs}/${toMs}?adjusted=false&sort=asc&limit=2000`);
    chartRawBars = resp.results || [];

    if (!chartRawBars.length) {
      document.getElementById('cm-loading').textContent = 'Sin datos para este ticker/fecha.';
      return;
    }
    document.getElementById('cm-loading').style.display = 'none';
    renderCandleChart(chartTF, dayTrades);
  } catch(e) {
    document.getElementById('cm-loading').textContent = `Error: ${e.message}`;
  }
}

function setChartTF(tf) {
  chartTF = tf;
  document.querySelectorAll('.chart-tf-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tf-${tf}`)?.classList.add('active');
  const dayTrades = trades.filter(t => t.symbol===chartSymbol && t.dateISO===chartDateISO);
  if (chartRawBars.length) renderCandleChart(tf, dayTrades);
}

function aggregateBars(bars, tf) {
  if (tf === 1) return bars.map(b => ({
    time: Math.floor(b.t / 1000),
    open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v
  }));
  const out = [];
  for (let i = 0; i < bars.length; i += tf) {
    const slice = bars.slice(i, i + tf);
    out.push({
      time:   Math.floor(slice[0].t / 1000),
      open:   slice[0].o,
      high:   Math.max(...slice.map(b=>b.h)),
      low:    Math.min(...slice.map(b=>b.l)),
      close:  slice[slice.length-1].c,
      volume: slice.reduce((s,b)=>s+b.v, 0),
    });
  }
  return out;
}

function renderCandleChart(tf, dayTrades) {
  const body = document.getElementById('cm-body');
  if (chartInstance) { try { chartInstance.remove(); } catch(e){} chartInstance = null; }

  // Guard: library must be loaded
  if (typeof LightweightCharts === 'undefined') {
    document.getElementById('cm-loading').style.display = '';
    document.getElementById('cm-loading').textContent = 'Error: librería de gráficos no cargó. Comprueba tu conexión a internet.';
    return;
  }

  const candles = aggregateBars(chartRawBars, tf);
  if (!candles.length) return;

  document.getElementById('cm-loading').style.display = 'none';

  const utcOffset = isDST(new Date(chartDateISO + 'T12:00:00Z')) ? 4 : 5;

  chartInstance = LightweightCharts.createChart(body, {
    width:  body.clientWidth,
    height: body.clientHeight,
    layout: {
      background: { type: 'solid', color: '#0f0f0f' },
      textColor: '#777',
      fontFamily: 'DM Mono, monospace',
      fontSize: 10,
    },
    grid: { vertLines:{color:'#161616'}, horzLines:{color:'#161616'} },
    crosshair: { mode: 1 }, // Normal mode
    rightPriceScale: { borderColor:'#1e1e1e', scaleMargins:{top:0.1, bottom:0.2} },
    leftPriceScale:  { visible: false },
    timeScale: {
      borderColor: '#1e1e1e',
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 5,
      tickMarkFormatter: ts => {
        const et = new Date((ts - utcOffset * 3600) * 1000);
        const h = et.getUTCHours().toString().padStart(2,'0');
        const m = et.getUTCMinutes().toString().padStart(2,'0');
        return h + ':' + m;
      },
    },
    localization: {
      timeFormatter: ts => {
        const et = new Date((ts - utcOffset * 3600) * 1000);
        const h = et.getUTCHours().toString().padStart(2,'0');
        const m = et.getUTCMinutes().toString().padStart(2,'0');
        return h + ':' + m + ' ET';
      },
    },
    handleScroll: true,
    handleScale:  true,
  });

  // ── Candlestick series ──
  const candleSeries = chartInstance.addCandlestickSeries({
    upColor:          '#2dba6f',
    downColor:        '#e05252',
    borderUpColor:    '#2dba6f',
    borderDownColor:  '#e05252',
    wickUpColor:      '#2dba6f',
    wickDownColor:    '#e05252',
  });
  candleSeries.setData(candles);

  // ── VWAP + MA72 ──
  const { vwapData, ma72Data } = buildIndicators(candles);
  const vwapSeries = chartInstance.addLineSeries({
    color: '#f0a500', lineWidth: 1, priceLineVisible: false,
    lastValueVisible: false, crosshairMarkerVisible: false,
    title: 'VWAP',
  });
  vwapSeries.setData(vwapData);
  const ma72Series = chartInstance.addLineSeries({
    color: '#8888ff', lineWidth: 1, priceLineVisible: false,
    lastValueVisible: false, crosshairMarkerVisible: false,
    title: 'MA72', lineStyle: 1,
  });
  ma72Series.setData(ma72Data);

  // ── Volume histogram ──
  const volSeries = chartInstance.addHistogramSeries({
    priceFormat:    { type: 'volume' },
    priceScaleId:   'vol',
    scaleMargins:   { top: 0.82, bottom: 0 },
  });
  volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  volSeries.setData(candles.map(c => ({
    time:  c.time,
    value: c.volume,
    color: c.close >= c.open ? 'rgba(45,186,111,0.2)' : 'rgba(224,82,82,0.2)',
  })));

  // ── Session separator markers ──
  const pmStartS  = new Date(`${chartDateISO}T${String(4 +utcOffset).padStart(2,'0')}:00:00Z`).getTime()/1000;
  const openTimeS = new Date(`${chartDateISO}T${String(9 +utcOffset).padStart(2,'0')}:30:00Z`).getTime()/1000;
  const pmCandle  = candles.find(c => c.time >= pmStartS);
  const openCandle= candles.find(c => c.time >= openTimeS);

  // ── Build all markers ──
  const markers = buildTradeMarkers(dayTrades, candles, tf);

  if (pmCandle) markers.push({
    time: pmCandle.time, position: 'aboveBar', shape: 'arrowDown',
    color: '#f0a500', text: '◀ PRE-MARKET 4:00', size: 0,
  });
  if (openCandle) markers.push({
    time: openCandle.time, position: 'aboveBar', shape: 'arrowDown',
    color: '#ffffff', text: '◀ OPEN 9:30', size: 0,
  });

  // Deduplicate same time+position by shifting 1s
  const seen = {};
  markers.sort((a,b) => a.time - b.time).forEach(m => {
    const key = `${m.time}-${m.position}`;
    if (seen[key]) m.time += 1;
    seen[key] = true;
  });
  try { candleSeries.setMarkers(markers.sort((a,b) => a.time - b.time)); } catch(e) { console.warn('Markers err:', e); }



  chartInstance.timeScale().fitContent();

  // ── Resize ──
  const ro = new ResizeObserver(() => {
    if (chartInstance) chartInstance.applyOptions({ width: body.clientWidth, height: body.clientHeight });
  });
  ro.observe(body);
}

function buildIndicators(candles) {
  // ── VWAP (resets at 9:30 ET open) ──
  const vwapData = [];
  let cumTPV = 0, cumVol = 0;
  candles.forEach(c => {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * (c.volume || 0);
    cumVol += (c.volume || 0);
    vwapData.push({ time: c.time, value: cumVol ? parseFloat((cumTPV / cumVol).toFixed(4)) : c.close });
  });

  // ── MA 72 ──
  const ma72Data = [];
  const period = 72;
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) continue;
    const slice = candles.slice(i - period + 1, i + 1);
    const avg = slice.reduce((s, c) => s + c.close, 0) / period;
    ma72Data.push({ time: candles[i].time, value: parseFloat(avg.toFixed(4)) });
  }
  return { vwapData, ma72Data };
}

function buildTradeMarkers(dayTrades, candles, tf) {
  const markers = [];
  const dateKey  = (chartDateISO || dayTrades[0]?.dateISO || '');
  const utcOffset = isDST(new Date(dateKey + 'T12:00:00Z')) ? 4 : 5;

  dayTrades.forEach(t => {
    const isShort = t.type?.toLowerCase() === 'short';

    // ── Entry: arrow pointing in trade direction ──
    if (t.openedHour) {
      const [h,m,s] = t.openedHour.split(':').map(Number);
      const ms = new Date(`${t.dateISO}T${String(h+utcOffset).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s||0).padStart(2,'0')}Z`).getTime();
      const entryT = snapToCandle(ms/1000, candles, tf);
      if (entryT) markers.push({
        time:     entryT,
        position: isShort ? 'aboveBar' : 'belowBar',
        shape:    isShort ? 'arrowDown' : 'arrowUp',
        color:    isShort ? '#e05252' : '#2dba6f',
        text:     '',
        size:     1,
      });
    }

    // ── Exit: arrow (direction color) + PnL label (result color) ──
    if (t.closed && t.closed.includes(':') && t.closed.length <= 8) {
      const [h,m,s] = t.closed.split(':').map(Number);
      const ms  = new Date(`${t.dateISO}T${String(h+utcOffset).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s||0).padStart(2,'0')}Z`).getTime();
      const exitT = snapToCandle(ms/1000, candles, tf);
      if (exitT) {
        // Arrow: direction-based color, no text
        markers.push({
          time:     exitT,
          position: isShort ? 'belowBar' : 'aboveBar',
          shape:    isShort ? 'arrowUp' : 'arrowDown',
          color:    isShort ? '#2dba6f' : '#e05252',
          text:     '',
          size:     1,
        });
        // P&L label: always above, result-based color, offset 1 candle
        markers.push({
          time:     exitT + 60,
          position: 'aboveBar',
          shape:    'circle',
          color:    t.net >= 0 ? '#2dba6f' : '#e05252',
          text:     `${t.net >= 0 ? '+' : ''}$${t.net?.toFixed(2)}`,
          size:     0,
        });
      }
    }
  });

  return markers.sort((a,b) => a.time - b.time);
}

function snapToCandle(timeS, candles, tf) {
  // Find nearest candle time
  let best = null, bestDiff = Infinity;
  const windowS = tf * 60;
  candles.forEach(c => {
    const diff = Math.abs(c.time - timeS);
    if (diff < bestDiff && diff < windowS * 2) { bestDiff = diff; best = c.time; }
  });
  return best;
}

function closeChartModal() {
  document.getElementById('chart-modal-overlay').classList.remove('open');
  if (chartInstance) { chartInstance.remove(); chartInstance = null; }
  chartRawBars = [];
}


function openInspector(idx) {
  const t = trades[idx];
  if (!t) return;

  document.getElementById('insp-title').textContent = `${t.symbol} — ${t.fecha}`;
  document.getElementById('insp-sub').textContent = `${t.type} · ${t.net >= 0 ? '+' : ''}$${t.net?.toFixed(2)} · ${t.patron || 'sin patrón'}`;

  const hasMassive = t.mGapPct != null || t.mFloat != null;

  const row = (label, val, cls='') => `
    <div class="inspector-row">
      <span class="inspector-key">${label}</span>
      <span class="inspector-val ${cls}">${val ?? '—'}</span>
    </div>`;

  let html = '';

  // Trade basics
  html += '<div class="inspector-section">Trade</div>';
  html += row('Entry', `$${t.entry?.toFixed(4)}`);
  html += row('Exit', `$${t.exit?.toFixed(4)}`);
  html += row('Qty', t.qty?.toLocaleString());
  html += row('Gross', `$${t.gross?.toFixed(2)}`, t.gross >= 0 ? 'pos' : 'neg');
  html += row('Net', `$${t.net?.toFixed(2)}`, t.net >= 0 ? 'pos' : 'neg');
  html += row('Hold', t.held);
  html += row('Patrón', t.patron || '—');
  html += row('R\'s', t.rs || '—');

  // Massive data
  if (hasMassive) {
    html += '<div class="inspector-section" style="color:var(--amber)">◉ Massive — Precio</div>';
    html += row('Prev Close', t.mPrevClose != null ? `$${t.mPrevClose.toFixed(2)}` : '—');
    html += row('Day Open', t.mDayOpen != null ? `$${t.mDayOpen.toFixed(2)}` : '—');
    html += row('Day High', t.mDayHigh != null ? `$${t.mDayHigh.toFixed(2)}` : '—');
    html += row('Day Low', t.mDayLow != null ? `$${t.mDayLow.toFixed(2)}` : '—');
    html += row('Day Close', t.mDayClose != null ? `$${t.mDayClose.toFixed(2)}` : '—');
    html += row('Gap% Open', t.mGapPct != null ? `${t.mGapPct.toFixed(2)}%` : '—', t.mGapPct >= 0 ? 'pos' : 'neg');
    html += row('PM High', t.mPMHigh != null ? `$${t.mPMHigh.toFixed(2)}` : '—');
    html += row('PM Gap%', t.mPMGapPct != null ? `${t.mPMGapPct.toFixed(2)}%` : '—', t.mPMGapPct >= 0 ? 'pos' : 'neg');

    html += '<div class="inspector-section" style="color:var(--amber)">◉ Massive — Volumen Premarket ET</div>';
    html += row('PM Total', t.mPMVol != null ? fmtVol(t.mPMVol) : '—');
    const pmHours = [[4,'4:00–5:00'],[5,'5:00–6:00'],[6,'6:00–7:00'],[7,'7:00–8:00'],[8,'8:00–9:00'],[9,'9:00–9:30']];
    pmHours.forEach(([h, label]) => {
      html += row(label, t[`mPMVol${h}`] != null ? fmtVol(t[`mPMVol${h}`]) : '—');
    });
    html += row('Day Vol', t.mDayVol != null ? fmtVol(t.mDayVol) : '—');

    html += '<div class="inspector-section" style="color:var(--amber)">◉ Massive — Fundamentales</div>';
    html += row('Float', t.mFloat != null ? fmtFloat(t.mFloat) : '—');
    html += row('Market Cap', t.mMarketCap != null ? fmtFloat(t.mMarketCap) : '—');
    html += row('Sector SIC', t.mSector || '—');
    const FLAG = {USA:'🇺🇸',China:'🇨🇳','Hong Kong':'🇭🇰',Canada:'🇨🇦','United Kingdom':'🇬🇧',Israel:'🇮🇱',Australia:'🇦🇺',Germany:'🇩🇪',France:'🇫🇷',Netherlands:'🇳🇱',Sweden:'🇸🇪',Switzerland:'🇨🇭',Japan:'🇯🇵',Ireland:'🇮🇪',Singapore:'🇸🇬',Brazil:'🇧🇷',India:'🇮🇳',Taiwan:'🇹🇼',Korea:'🇰🇷'};
    const cFlag = t.mCountry ? (FLAG[t.mCountry] || '🌐') + ' ' : '';
    html += row('País', t.mCountry ? cFlag + t.mCountry : '—');
    if (t.mTickerType && ['ADRC','ADRW','ADRP'].includes(t.mTickerType)) html += row('Tipo', '⚠ ADR — empresa extranjera cotizando en EEUU');
    html += row('Inst.%', t.mInstitPct != null ? t.mInstitPct+'%' : '—');
    html += row('Insid.%', t.mInsidPct  != null ? t.mInsidPct+'%'  : '—');
    if (t.mNewsCount > 0) {
      html += `<div class="insp-row"><span class="insp-label">Noticias</span><span class="insp-val" style="color:var(--amber);cursor:pointer;text-decoration:underline" onclick="openNewsModal(${trades.indexOf(t)})">${t.mNewsCount} artículo${t.mNewsCount>1?'s':''} →</span></div>`;
    } else if (t.mNewsCount === 0) {
      html += row('Noticias', 'Sin noticias ese día');
    }
    html += row('Nombre', t.mName || '—');
  } else {
    html += `<div style="margin-top:16px;padding:12px;background:var(--bg3);border:1px solid var(--border2);border-radius:3px;font-family:var(--sans);font-size:11px;color:var(--dim);text-align:center">
      Sin datos de Massive.<br>Ve a Ajustes → Enriquecer trades para añadirlos.
    </div>`;
  }

  document.getElementById('insp-body').innerHTML = html;
  document.getElementById('inspector-overlay').classList.add('open');
}

function closeInspector() {
  document.getElementById('inspector-overlay').classList.remove('open');
}

// ═══════════════════════════════
// MASSIVE API
// ═══════════════════════════════
let massiveKey = '';

function saveMassiveKey(v) {
  massiveKey = v.trim();
  localStorage.setItem('tj_massive_key', massiveKey);
}

function loadMassiveKey() {
  massiveKey = localStorage.getItem('tj_massive_key') || '';
  const inp = document.getElementById('massive-key-input');
  if (inp && massiveKey) inp.value = massiveKey;
  return massiveKey;
}

function massiveLog(msg, type='info') {
  const log = document.getElementById('massive-log');
  if (!log) return;
  log.style.display = 'block';
  const color = type==='ok'?'var(--green)':type==='err'?'var(--red)':'var(--dim)';
  log.innerHTML += `<span style="color:${color}">${msg}</span>\n`;
  log.scrollTop = log.scrollHeight;
  log.scrollTop = log.scrollHeight;
}

function massiveProgress(done, total) {
  const wrap = document.getElementById('massive-progress-wrap');
  const bar  = document.getElementById('massive-progress-bar');
  const stat = document.getElementById('massive-status');
  if (!wrap) return;
  wrap.style.display = 'block';
  bar.style.width = (done/total*100)+'%';
  stat.textContent = `${done} / ${total} trades`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function massiveFetch(path, retries = 3) {
  const base = 'https://api.polygon.io';
  const sep  = path.includes('?') ? '&' : '?';
  const url  = `${base}${path}${sep}apiKey=${massiveKey}`;
  for (let attempt = 0; attempt < retries; attempt++) {
    const r = await fetch(url);
    if (r.status === 429) {
      const wait = (attempt + 1) * 15000; // 15s, 30s, 45s
      massiveLog(`  ⏸ Rate limit (429) — esperando ${wait/1000}s...`);
      await sleep(wait);
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  throw new Error('Rate limit después de 3 reintentos');
}

async function enrichWithMassive() {
  if (!massiveKey) { toast('Primero añade tu API Key de Massive', 'err'); return; }

  // Reset UI
  const log  = document.getElementById('massive-log');
  const stat = document.getElementById('massive-status');
  log.innerHTML = '';
  log.style.display = 'block';
  stat.textContent = '';

  const countSel = document.getElementById('massive-count').value;
  // Sort trades by date desc, pick last N unique days
  const sorted = [...trades].sort((a,b) => b.dateISO.localeCompare(a.dateISO));
  let subset;
  if (countSel === 'pending') {
    // Only trades missing ANY key enrichment data
    subset = sorted.filter(t => t.mMFE == null || t.mFloat == null || t.mGapPct == null);
  } else if (countSel === 'all') {
    subset = sorted;
  } else {
    subset = sorted.slice(0, parseInt(countSel));
  }
  if (!subset.length) {
    toast('No hay trades pendientes de enriquecer 🎉', 'ok');
    massiveLog('✅ Todos los trades ya están enriquecidos.', 'ok');
    return;
  }

  massiveLog(`🔄 Enriqueciendo ${subset.length} trades...`);

  // Group by ticker+date to avoid duplicate calls
  const jobMap = {};
  subset.forEach(t => {
    const key = `${t.symbol}__${t.dateISO}`;
    if (!jobMap[key]) jobMap[key] = { symbol: t.symbol, dateISO: t.dateISO, trades: [] };
    jobMap[key].trades.push(t);
  });
  const jobs = Object.values(jobMap);
  const minsEst = Math.ceil(jobs.length * 23 / 60);
  massiveLog(`📦 ${jobs.length} ticker-día únicos · estimado: ~${minsEst < 60 ? minsEst+'min' : Math.floor(minsEst/60)+'h '+minsEst%60+'min'}`);

  let done = 0;
  let skipped = 0;
  for (const job of jobs) {
    const { symbol, dateISO, trades: jobTrades } = job;
    // Resume: skip jobs where ALL trades already have full enrichment
    const alreadyDone = jobTrades.every(t => t.mMFE != null && t.mFloat != null && t.mGapPct != null);
    if (alreadyDone) {
      done++; skipped++;
      massiveProgress(done, jobs.length);
      continue;
    }
    massiveLog(`⏳ ${symbol} ${dateISO}`);
    try {
      const enriched = await fetchMassiveData(symbol, dateISO);
      // Apply shared data to all trades with this ticker+date
      trades.forEach(t => { if (t.symbol === symbol && t.dateISO === dateISO) Object.assign(t, enriched); });
      massiveLog(`✓ ${symbol} ${dateISO} — gap ${enriched.mGapPct?.toFixed(1) ?? '?'}% | float ${fmtFloat(enriched.mFloat)} | PM High ${enriched.mPMHigh ? '$'+enriched.mPMHigh.toFixed(2) : '?'} | PM vol ${fmtVol(enriched.mPMVol)}`, 'ok');
    } catch(e) {
      massiveLog(`✗ ${symbol} ${dateISO}: ${e.message}`, 'err');
    }

    // ── MFE / MAE per trade ───────────────────────────────────────────────
    try {
      await sleep(800);
      const utcOff  = isDST(new Date(dateISO + 'T12:00:00Z')) ? 4 : 5;
      const fromMs  = new Date(`${dateISO}T${String(4  + utcOff).padStart(2,'0')}:00:00Z`).getTime();
      const toMs    = new Date(`${dateISO}T${String(16 + utcOff).padStart(2,'0')}:00:00Z`).getTime();
      const barsResp = await massiveFetch(`/v2/aggs/ticker/${symbol}/range/1/minute/${fromMs}/${toMs}?adjusted=false&sort=asc&limit=2000`);
      const bars    = barsResp.results || [];

      // For each trade of this ticker-day, slice bars to trade window and compute MFE/MAE
      jobTrades.forEach(t => {
        if (!t.openedHour || !t.entry) return;
        const [oh,om,os=0] = t.openedHour.split(':').map(Number);
        const tradeOpenMs = new Date(`${dateISO}T${String(oh+utcOff).padStart(2,'0')}:${String(om).padStart(2,'0')}:${String(os).padStart(2,'0')}Z`).getTime();

        let tradeCloseMs = toMs;
        if (t.closedHour) {
          const [ch,cm,cs=0] = t.closedHour.split(':').map(Number);
          tradeCloseMs = new Date(`${dateISO}T${String(ch+utcOff).padStart(2,'0')}:${String(cm).padStart(2,'0')}:${String(cs).padStart(2,'0')}Z`).getTime();
        } else if (t.minutos > 0) {
          tradeCloseMs = tradeOpenMs + t.minutos * 60000;
        }

        const tradeBars = bars.filter(b => b.t >= tradeOpenMs && b.t <= tradeCloseMs);
        if (!tradeBars.length) return;

        const maxHigh = Math.max(...tradeBars.map(b => b.h));
        const minLow  = Math.min(...tradeBars.map(b => b.l));
        const entry   = t.entry;
        const isShort = t.type?.toLowerCase() === 'short';

        const mfe = isShort
          ? Math.max(0, (entry - minLow)  / entry * 100)
          : Math.max(0, (maxHigh - entry) / entry * 100);
        const mae = isShort
          ? Math.max(0, (maxHigh - entry) / entry * 100)
          : Math.max(0, (entry - minLow)  / entry * 100);

        // Also store $ values
        t.mMFE       = parseFloat(mfe.toFixed(3));    // % favorable
        t.mMAE       = parseFloat(mae.toFixed(3));    // % adverse
        t.mMFEdol    = parseFloat((isShort ? entry - minLow : maxHigh - entry).toFixed(4));
        t.mMAEdol    = parseFloat((isShort ? maxHigh - entry : entry - minLow).toFixed(4));
        t.mCapture   = mfe > 0 ? parseFloat(((t.recorrido * 100) / mfe * 100).toFixed(1)) : null;
      });
      massiveLog(`  → MFE/MAE calculados para ${jobTrades.filter(t=>t.mMFE!=null).length}/${jobTrades.length} trades`, 'ok');
    } catch(e) {
      massiveLog(`  mfe/mae err: ${e.message}`, 'err');
    }

    done++;
    massiveProgress(done, jobs.length);
    if (done < jobs.length) await sleep(18000);
  }

  save();
  toast(`Enriquecidos ${subset.length} trades${skipped>0?' ('+skipped+' ya tenían datos)':''}`, 'ok');
  massiveLog(`✅ Listo. Datos guardados.${skipped>0?' · '+skipped+' ticker-días saltados (ya enriquecidos).':''}`, 'ok');
}

async function fetchMassiveData(symbol, dateISO) {
  const result = {};

  // ── 1. Ticker details (float, shares, market cap, sector) ──
  try {
    const det = await massiveFetch(`/v3/reference/tickers/${symbol}?date=${dateISO}`);
    const r = det.results || {};
    result.mFloat       = r.share_class_shares_outstanding ?? r.weighted_shares_outstanding ?? null;
    result.mShares      = r.total_employees ? null : (r.share_class_shares_outstanding ?? null);
    result.mMarketCap   = r.market_cap ?? null;
    result.mSector      = r.sic_description ?? null;
    result.mName        = r.name ?? null;
    // Type hint: ADRC/ADRW/ADRP = ADR (foreign co listed in US)
    result.mTickerType  = r.type ?? null;
    // locale: 'us' or 'global'
    result.mLocale      = r.locale ?? null;
  } catch(e) { massiveLog(`  details err: ${e.message}`, 'err'); }
  await sleep(500);

  // ── 2. Daily OHLCV + previous close ──
  try {
    // Look back 7 calendar days to handle holidays (e.g. MLK Day, Presidents Day, etc.)
    const lookbackDate = (() => {
      const d = new Date(dateISO + 'T12:00:00Z');
      d.setDate(d.getDate() - 7);
      return d.toISOString().slice(0, 10);
    })();
    const agg = await massiveFetch(`/v2/aggs/ticker/${symbol}/range/1/day/${lookbackDate}/${dateISO}?adjusted=false&sort=asc&limit=10`);
    const results = agg.results || [];
    if (results.length >= 2) {
      const prev = results[results.length - 2];
      const day  = results[results.length - 1];
      result.mPrevClose = prev.c;
      result.mDayOpen   = day.o;
      result.mDayHigh   = day.h;
      result.mDayLow    = day.l;
      result.mDayClose  = day.c;
      result.mDayVol    = day.v;
      result.mGapPct    = prev.c ? ((day.o - prev.c) / prev.c * 100) : null;
    } else if (results.length === 1) {
      const day = results[0];
      result.mDayOpen = day.o; result.mDayHigh = day.h;
      result.mDayLow  = day.l; result.mDayClose = day.c; result.mDayVol = day.v;
    }
  } catch(e) { massiveLog(`  daily agg err: ${e.message}`, 'err'); }
  await sleep(500);

  // ── 3. Premarket vol + high from 1-min aggregates, summed per hour
  try {
    const utcOffset = isDST(new Date(dateISO + 'T12:00:00Z')) ? 4 : 5;
    const pmFrom = new Date(`${dateISO}T${String(4 + utcOffset).padStart(2,'0')}:00:00Z`);
    const pmTo   = new Date(`${dateISO}T${String(9 + utcOffset).padStart(2,'0')}:30:00Z`);

    const pm = await massiveFetch(`/v2/aggs/ticker/${symbol}/range/1/minute/${pmFrom.getTime()}/${pmTo.getTime()}?adjusted=false&sort=asc&limit=1000`);
    const bars = pm.results || [];
    massiveLog(`  PM 1min bars: ${bars.length} | resultsCount: ${pm.resultsCount}`);

    if (bars.length > 0) {
      let pmHigh = null, pmVol = 0;
      const hourVols = { h4:0, h5:0, h6:0, h7:0, h8:0, h9:0 };
      bars.forEach(bar => {
        const etHour = new Date(bar.t).getUTCHours() - utcOffset;
        const hKey = `h${etHour}`;
        if (hourVols.hasOwnProperty(hKey)) hourVols[hKey] += (bar.v || 0);
        pmVol += (bar.v || 0);
        if (pmHigh === null || bar.h > pmHigh) pmHigh = bar.h;
      });
      result.mPMHigh = pmHigh;
      result.mPMVol  = pmVol || null;
      result.mPMVol4 = hourVols.h4 || null; result.mPMVol5 = hourVols.h5 || null;
      result.mPMVol6 = hourVols.h6 || null; result.mPMVol7 = hourVols.h7 || null;
      result.mPMVol8 = hourVols.h8 || null; result.mPMVol9 = hourVols.h9 || null;
    }

    if (result.mPrevClose && result.mPMHigh) {
      result.mPMGapPct = (result.mPMHigh - result.mPrevClose) / result.mPrevClose * 100;
    }
    massiveLog(`  → PM High: ${result.mPMHigh ? '$'+result.mPMHigh.toFixed(2) : '—'} | PM Gap: ${result.mPMGapPct?.toFixed(1) ?? '—'}% | PM Vol: ${fmtVol(result.mPMVol)}`);
  } catch(e) { massiveLog(`  premarket err: ${e.message}`, 'err'); }
  await sleep(400);

  // ── 4. Institutional & insider ownership — Finviz scrape ─────────────────
  // Polygon free tier does NOT return inst%/insider% (404). Scrape Finviz instead.
  try {
    const fvUrl    = `https://finviz.com/quote.ashx?t=${symbol}&ty=c&ta=0&p=d`;
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(fvUrl)}`;
    const fvResp   = await fetch(proxyUrl);
    if (!fvResp.ok) throw new Error(`HTTP ${fvResp.status}`);
    const fvJson   = await fvResp.json();
    const html     = fvJson.contents || '';
    massiveLog(`  Finviz HTML: ${html.length} chars, status: ${fvJson.status?.http_code ?? '?'}`);
    if (!html) throw new Error('Finviz devolvió HTML vacío — proxy bloqueado');
    // Try multiple proxy fallbacks if allorigins fails
    // Finviz snapshot table: values are wrapped in <small> tags after the label
    // Structure: <b>Inst Own</b></td><td ...><small>64.50%</small>
    const fvInst    = html.match(/Inst Own[\s\S]*?<small>([\d.]+%)<\/small>/i);
    const fvInsid   = html.match(/Insider Own[\s\S]*?<small>([\d.]+%)<\/small>/i);
    const fvCountry = html.match(/>Country<[\s\S]*?<td[^>]*>\s*([A-Za-z][A-Za-z .\-]{1,28}?)\s*<\/td>/i);
    // Also try alternate structure (Finviz sometimes uses data-boxover or title attrs)
    const fvInst2    = !fvInst    && html.match(/Inst Own[^%]*?([\d.]+)%/i);
    const fvInsid2   = !fvInsid   && html.match(/Insider Own[^%]*?([\d.]+)%/i);
    if (fvInst)    result.mInstitPct = parseFloat(fvInst[1]);
    else if (fvInst2) result.mInstitPct = parseFloat(fvInst2[1]);
    if (fvInsid)   result.mInsidPct  = parseFloat(fvInsid[1]);
    else if (fvInsid2) result.mInsidPct = parseFloat(fvInsid2[1]);
    if (fvCountry) result.mCountry   = fvCountry[1].trim();
    // Debug: show first occurrence of 'Inst' in HTML
    const instIdx = html.indexOf('Inst Own');
    if (instIdx >= 0) massiveLog(`  Inst Own context: ${html.slice(instIdx, instIdx+80).replace(/[\r\n]/g,' ')}`);
    massiveLog(`  → Inst: ${result.mInstitPct != null ? result.mInstitPct+'%' : '—'} | Insid: ${result.mInsidPct != null ? result.mInsidPct+'%' : '—'} | País: ${result.mCountry || '—'} (Finviz)`);
  } catch(e) { massiveLog(`  ownership err: ${e.message}`, 'err'); }
  await sleep(800);

  // ── 5. News on the trade day ──────────────────────────────────────────────
  try {
    const nextDay = (() => { const d = new Date(dateISO+'T12:00:00Z'); d.setDate(d.getDate()+1); return d.toISOString().slice(0,10); })();
    const news = await massiveFetch(`/v2/reference/news?ticker=${symbol}&published_utc.gte=${dateISO}&published_utc.lt=${nextDay}&order=asc&limit=5&sort=published_utc`);
    const articles = (news.results || []).filter(a => a.title);
    if (articles.length) {
      // Store compact: "Title (source)" joined by " | "
      result.mNews = articles.map(a => {
        const src = a.publisher?.name || a.source || '';
        const t   = a.title.length > 80 ? a.title.slice(0, 80) + '…' : a.title;
        return src ? `${t} [${src}]` : t;
      }).join(' | ');
      result.mNewsCount = articles.length;
      massiveLog(`  → News: ${articles.length} artículos`);
    } else {
      result.mNewsCount = 0;
      massiveLog(`  → News: sin noticias ese día`);
    }
  } catch(e) { massiveLog(`  news err: ${e.message}`, 'err'); }

  return result;
}

function getPrevTradingDay(dateISO) {
  const US_HOLIDAYS = new Set([
    // 2025
    '2025-01-01','2025-01-20','2025-02-17','2025-04-18','2025-05-26',
    '2025-06-19','2025-07-04','2025-09-01','2025-11-27','2025-12-25',
    // 2026
    '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
    '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  ]);
  const d = new Date(dateISO + 'T12:00:00Z');
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6 || US_HOLIDAYS.has(d.toISOString().slice(0,10))) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

// US DST: 2nd Sunday March → 1st Sunday November
function isDST(date) {
  const y = date.getUTCFullYear();
  const marchSecondSun = new Date(Date.UTC(y, 2, 8));
  marchSecondSun.setUTCDate(8 + (7 - marchSecondSun.getUTCDay()) % 7);
  const novFirstSun = new Date(Date.UTC(y, 10, 1));
  novFirstSun.setUTCDate(1 + (7 - novFirstSun.getUTCDay()) % 7);
  return date >= marchSecondSun && date < novFirstSun;
}

function fmtFloat(n) {
  if (!n) return '?';
  if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(0)+'K';
  return n;
}

function fmtVol(n) {
  if (!n) return '?';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(0)+'K';
  return n;
}


// ═══════════════════════════════
// PERSISTENCE — REST API backend
// ═══════════════════════════════
async function save() {
  try {
    await fetch('/api/trades', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ trades, meta: { lastImport, patterns: PATTERNS } })
    });
  } catch(e) {
    toast('Error guardando en servidor: ' + e.message, 'err');
  }
}

async function load() {
  try {
    const res = await fetch('/api/trades');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.trades && data.trades.length) {
      trades = data.trades;
      migrateDateISO();
    }
    if (data.meta) {
      if (data.meta.lastImport) lastImport = data.meta.lastImport;
      if (data.meta.patterns)   PATTERNS   = data.meta.patterns;
    }
  } catch(e) {
    console.error('Error cargando desde API:', e);
  }
}
// Fix dateISO for trades that were stored with UTC-shifted dates
// Uses fecha (DD/MM/YYYY) which was always correct
function migrateDateISO() {
  let fixed = 0;
  trades.forEach(t => {
    if (t.fecha && t.fecha.includes('/')) {
      const parts = t.fecha.split('/');
      if (parts.length === 3) {
        const correct = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
        if (t.dateISO !== correct) { t.dateISO = correct; fixed++; }
      }
    }
  });
  if (fixed > 0) { save(); console.log(`Migrated ${fixed} dateISO values`); }
}

// ═══════════════════════════════
// TABS
// ═══════════════════════════════
function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b,i) => {
    const names = ['trades','analytics','calendario','notas','settings'];
    b.classList.toggle('active', names[i] === tab);
  });
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + tab).classList.add('active');
  if (tab === 'analytics')   { computeAllRS(); renderAnalytics(); }
  if (tab === 'settings')    renderSettings();
  if (tab === 'calendario')  { computeAllRS(); renderCalendario(); }
  if (tab === 'notas')       renderNotas();
}

// ═══════════════════════════════
// FILE IMPORT
// ═══════════════════════════════
const dz   = document.getElementById('drop-zone');
const finp = document.getElementById('file-input');
dz.addEventListener('click', () => finp.click());
dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); if(e.dataTransfer.files[0]) setPendingFile(e.dataTransfer.files[0]); });
finp.addEventListener('change', () => { if(finp.files[0]) setPendingFile(finp.files[0]); });

// DAS drop zone
const dzDas  = document.getElementById('drop-zone-das');
const finpDas= document.getElementById('file-input-das');
dzDas.addEventListener('click', () => finpDas.click());
dzDas.addEventListener('dragover',  e => { e.preventDefault(); dzDas.classList.add('over'); });
dzDas.addEventListener('dragleave', () => dzDas.classList.remove('over'));
dzDas.addEventListener('drop', e => { e.preventDefault(); dzDas.classList.remove('over'); if(e.dataTransfer.files[0]) setPendingDAS(e.dataTransfer.files[0]); });
finpDas.addEventListener('change', () => { if(finpDas.files[0]) setPendingDAS(finpDas.files[0]); });

let pendingDASFile = null;
function setPendingDAS(f) {
  pendingDASFile = f;
  document.getElementById('file-name-das').textContent = f.name;
  document.getElementById('import-btn-das').disabled = false;
  dzDas.querySelector('.drop-text').textContent = f.name;
  dzDas.querySelector('.drop-sub').textContent  = (f.size/1024).toFixed(1) + ' KB';
}

function setPendingFile(f) {
  pendingFile = f;
  document.getElementById('file-name').textContent = f.name;
  document.getElementById('import-btn').disabled = false;
  dz.querySelector('.drop-text').textContent = f.name;
  dz.querySelector('.drop-sub').textContent  = (f.size/1024).toFixed(1) + ' KB';
}

function importFile() {
  if (!pendingFile) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb   = XLSX.read(e.target.result, { type:'binary', cellDates:false, raw:true });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header:1, raw:true, defval:'' });
      const parsed = parseBrokerRows(rows);
      if (!parsed.length) { toast('No se encontraron trades válidos', 'err'); return; }
      // Clear DAS preview when real data arrives
      clearDASPreview(true);
      trades = mergeTrades(trades, parsed);
      lastImport = new Date().toLocaleDateString('es-ES');
      save();
      renderAll();
      toast(`${parsed.length} trades importados`, 'ok');
      document.getElementById('import-btn').disabled = true;
      document.getElementById('file-name').textContent = '';
      dz.querySelector('.drop-text').textContent = 'Arrastra el ProPReport';
      dz.querySelector('.drop-sub').textContent  = '.xls · .xlsx · .csv';
      pendingFile = null;
    } catch(err) {
      console.error(err);
      toast('Error al parsear: ' + err.message, 'err');
    }
  };
  reader.readAsBinaryString(pendingFile);
}

// ═══════════════════════════════
// DAS PREVIEW
// ═══════════════════════════════
let dasPreview    = []; // [{dateISO, symbol, type, entry, exit, qty, net, isPreview:true}]
async function loadDASPreview() {
  try { const _r = await fetch('/api/store/das_preview'); dasPreview = (_r.ok ? await _r.json() : null) ?? []; } catch(e) { dasPreview = []; }
  refreshDASBtn();
}
async function saveDASPreview() {
  try { await fetch('/api/store/das_preview', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(dasPreview) }); } catch(e) {}
}

function refreshDASBtn() {
  const btn = document.getElementById('clear-das-btn');
  if (btn) btn.style.display = dasPreview.length ? '' : 'none';
}

function clearDASPreview(silent) {
  dasPreview = [];
  saveDASPreview();
  refreshDASBtn();
  const panel = document.getElementById('das-intraday-panel');
  if (panel) panel.style.display = 'none';
  if (!silent) { renderCalendario(); toast('Preview borrado', 'ok'); }
}

function importDAS() {
  if (!pendingDASFile) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const text = e.target.result;
      const parsed = parseDAScsv(text);
      if (!parsed.length) { toast('No se encontraron trades', 'err'); return; }
      dasPreview = parsed;
      saveDASPreview();
      refreshDASBtn();
      // Refresh calendar
      if (document.getElementById('page-calendario').classList.contains('active') ||
          document.getElementById('page-trades').classList.contains('active')) {
        renderCalendario();
      }
      toast(`${parsed.length} trades en preview`, 'ok');
      document.getElementById('import-btn-das').disabled = true;
      dzDas.querySelector('.drop-text').textContent = 'Trades.csv de DAS';
      dzDas.querySelector('.drop-sub').textContent  = 'Preview en calendario';
      pendingDASFile = null;
      renderIntradayChart(parsed);
    } catch(err) {
      console.error(err);
      toast('Error: ' + err.message, 'err');
    }
  };
  reader.readAsText(pendingDASFile);
}

function parseDAScsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => {
    const vals = l.split(',');
    const obj = {};
    header.forEach((h, i) => obj[h] = (vals[i]||'').trim());
    return obj;
  });

  // Group fills by symbol (all same date in DAS daily export)
  const bySymbol = {};
  for (const r of rows) {
    const sym = r['symb'] || r['Symbol'] || r['symbol'];
    if (!sym) continue;
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push(r);
  }

  const result = [];
  for (const [sym, fills] of Object.entries(bySymbol)) {
    const getField = (r, ...keys) => { for (const k of keys) if (r[k]!==undefined) return r[k]; return ''; };
    const buys  = fills.filter(f => getField(f,'B/S','bs') === 'B');
    const sells = fills.filter(f => getField(f,'B/S','bs') === 'S');
    const bQty  = buys.reduce((s,f)  => s + parseInt(getField(f,'qty','Qty')||0), 0);
    const sQty  = sells.reduce((s,f) => s + parseInt(getField(f,'qty','Qty')||0), 0);
    if (!bQty || !sQty) continue; // skip unclosed positions

    const bVal = buys.reduce((s,f)  => s + parseInt(getField(f,'qty','Qty')||0)*parseFloat(getField(f,'price','Price')||0), 0);
    const sVal = sells.reduce((s,f) => s + parseInt(getField(f,'qty','Qty')||0)*parseFloat(getField(f,'price','Price')||0), 0);
    const net = sVal - bVal;

    // Direction: if first fill is SHORT=Y → short trade
    const firstSHORT = getField(fills[0], 'SHORT', 'Short');
    const type = firstSHORT === 'Y' ? 'Short' : 'Long';

    // Date from first fill time MM/DD/YY
    const rawTime = getField(fills[0], 'time', 'Time', 'DateTime');
    let dateISO = '';
    const mMatch = rawTime.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
    if (mMatch) {
      const y = mMatch[3].length === 2 ? '20' + mMatch[3] : mMatch[3];
      dateISO = `${y}-${mMatch[1]}-${mMatch[2]}`;
    }

    const entryPrice = type === 'Short' ? (sVal/sQty) : (bVal/bQty);
    const exitPrice  = type === 'Short' ? (bVal/bQty) : (sVal/sQty);
    const qty = Math.min(bQty, sQty);

    // Compute time of last fill (trade close time)
    const lastFill = fills[fills.length - 1];
    const rawClose = getField(lastFill, 'time', 'Time', 'DateTime');
    const tMatch   = rawClose.match(/(\d{2}):(\d{2}):(\d{2})/);
    const closeHour = tMatch ? `${tMatch[1]}:${tMatch[2]}:${tMatch[3]}` : '';

    result.push({
      id: 'das_' + sym + '_' + dateISO,
      symbol: sym,
      dateISO,
      type,
      entry: +entryPrice.toFixed(4),
      exit:  +exitPrice.toFixed(4),
      qty,
      net: +net.toFixed(2),
      gross: +net.toFixed(2),
      resultado: net >= 0 ? 'P' : 'L',
      closeHour,
      isPreview: true,
      _fills: fills.map(f => ({
        time: getField(f,'time','Time','DateTime'),
        qty:  parseInt(getField(f,'qty','Qty')||0),
        price:parseFloat(getField(f,'price','Price')||0),
        bs:   getField(f,'B/S','bs'),
        short:getField(f,'SHORT','Short')
      }))
    });
  }
  return result;
}

// ─── Parse broker rows ───
let _intradayChart = null;

function renderIntradayChart(parsed) {
  const panel = document.getElementById('das-intraday-panel');
  if (!parsed || !parsed.length) { panel.style.display = 'none'; return; }

  // Collect ALL raw fills from all parsed trades, sort chronologically
  const allFills = [];
  parsed.forEach(trade => {
    if (!trade._fills) return;
    trade._fills.forEach(f => allFills.push({ ...f, _sym: trade.symbol }));
  });

  const toMins = str => {
    const m = (str || '').match(/(\d{1,2}):(\d{2}):(\d{2})/);
    return m ? parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3]) / 60 : null;
  };
  const toHHMM = m => {
    const h = Math.floor(m / 60), mn = Math.floor(m % 60);
    return String(h).padStart(2,'0') + ':' + String(mn).padStart(2,'0');
  };

  allFills.sort((a, b) => (toMins(a.time) || 0) - (toMins(b.time) || 0));

  // Running net-position P&L per symbol
  // pos > 0 = long shares, pos < 0 = short shares
  const positions = {};  // sym → { qty: 0, avg: 0 }
  const pnlEvents = [];
  let cumPnL = 0;

  allFills.forEach(f => {
    const sym   = f._sym;
    const qty   = f.qty   || 0;
    const price = f.price || 0;
    const mins  = toMins(f.time);
    if (!qty || !price || mins === null) return;

    if (!positions[sym]) positions[sym] = { qty: 0, avg: 0 };
    const pos = positions[sym];

    const signed = f.bs === 'B' ? qty : -qty;
    const prevQty = pos.qty;
    const newQty  = prevQty + signed;

    let pnl = 0;

    if (prevQty === 0) {
      // Opening from flat
      pos.qty = signed;
      pos.avg = price;
    } else if (Math.sign(prevQty) === Math.sign(signed)) {
      // Adding to existing position (same direction)
      const total = Math.abs(prevQty) + qty;
      pos.avg = (pos.avg * Math.abs(prevQty) + price * qty) / total;
      pos.qty = newQty;
    } else {
      // Reducing or crossing
      const closeQty = Math.min(Math.abs(signed), Math.abs(prevQty));
      pnl = prevQty > 0
        ? (price - pos.avg) * closeQty   // closing long
        : (pos.avg - price) * closeQty;  // closing short
      cumPnL += pnl;
      pnlEvents.push({
        mins,
        cumPnL: +cumPnL.toFixed(2),
        pnl:    +pnl.toFixed(2),
        label:  `${f.time ? f.time.slice(0,8) : toHHMM(mins)} ${sym}`
      });

      const remaining = Math.abs(signed) - closeQty;
      if (remaining > 0) {
        // Crossed zero — open new position in other direction
        pos.qty = Math.sign(signed) * remaining;
        pos.avg = price;
      } else {
        pos.qty = newQty;
        if (newQty === 0) pos.avg = 0;
      }
      return; // already pushed event
    }

    // No P&L realized on entry fills — no event pushed
  });

  if (!pnlEvents.length) { panel.style.display = 'none'; return; }

  // Add zero-origin point just before first event
  const points = [
    { mins: pnlEvents[0].mins - 0.5, cumPnL: 0, pnl: 0, label: '' },
    ...pnlEvents
  ];

  const totalNet  = points[points.length - 1].cumPnL;
  const maxProfit = Math.max(...points.map(p => p.cumPnL));
  const maxDD     = Math.min(...points.map(p => p.cumPnL));
  const dateISO   = parsed[0].dateISO;

  document.getElementById('das-intraday-date').textContent = dateISO;
  document.getElementById('das-intraday-kpis').innerHTML = [
    { label: 'Net P&L',      val: (totalNet >= 0 ? '+$' : '-$') + Math.abs(totalNet).toFixed(2),  col: totalNet >= 0 ? '#3dba6f' : '#e05252' },
    { label: 'Max profit',   val: '+$' + maxProfit.toFixed(2),                                      col: '#3dba6f' },
    { label: 'Max drawdown', val: (maxDD >= 0 ? '+$' : '-$') + Math.abs(maxDD).toFixed(2),         col: maxDD < 0 ? '#e05252' : '#3dba6f' },
    { label: 'Trades',       val: parsed.length,                                                     col: 'var(--text)' },
  ].map(k => `<div style="text-align:right">
    <div style="font-size:9px;color:var(--dim);font-family:var(--sans);text-transform:uppercase;letter-spacing:.05em">${k.label}</div>
    <div style="font-size:15px;font-family:var(--mono);font-weight:700;color:${k.col}">${k.val}</div>
  </div>`).join('');

  if (_intradayChart) { _intradayChart.destroy(); _intradayChart = null; }

  const lineCol = totalNet >= 0 ? '#3dba6f' : '#e05252';
  const ctx = document.getElementById('das-intraday-chart').getContext('2d');
  _intradayChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => toHHMM(p.mins)),
      datasets: [{
        data: points.map(p => p.cumPnL),
        borderColor: lineCol,
        borderWidth: 2,
        pointRadius: points.map((_, i) => i === 0 ? 0 : 3),
        pointBackgroundColor: points.map(p => p.pnl > 0 ? '#3dba6f' : p.pnl < 0 ? '#e05252' : '#555'),
        pointBorderColor: 'transparent',
        tension: 0.1,
        fill: true,
        backgroundColor: totalNet >= 0 ? 'rgba(61,186,111,0.07)' : 'rgba(224,82,82,0.07)',
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c1c1c', borderColor: '#2a2a2a', borderWidth: 1,
          titleFont: { family: 'DM Sans', size: 10 },
          bodyFont:  { family: 'DM Sans', size: 12 },
          callbacks: {
            title: items => points[items[0].dataIndex].label || items[0].label,
            label: item => {
              const p = points[item.dataIndex];
              return [
                `  Acum: ${item.parsed.y >= 0 ? '+$' : '-$'}${Math.abs(item.parsed.y).toFixed(2)}`,
                `  Realizado: ${p.pnl >= 0 ? '+$' : '-$'}${Math.abs(p.pnl).toFixed(2)}`
              ];
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,.04)' },
          ticks: { color: '#666', font: { family: 'DM Sans', size: 9 }, maxTicksLimit: 12 },
          border: { color: 'transparent' }
        },
        y: {
          grid: { color: 'rgba(255,255,255,.04)' },
          ticks: {
            color: '#666', font: { family: 'DM Sans', size: 9 },
            callback: v => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(0)
          },
          border: { color: 'transparent' }
        }
      }
    }
  });

  panel.style.display = 'block';
  setTab('calendario');


}


function parseBrokerRows(rows) {
  const result = [];
  let headers  = null;
  for (let i = 0; i < rows.length; i++) {
    const row   = rows[i];
    if (!row || row.length < 2) continue;
    const first = String(row[0]).trim();
    if (first === 'Opened') { headers = row.map(c => String(c).trim()); continue; }
    if (!headers) continue;
    if (!first) continue;
    if (first.toLowerCase() === 'equities') continue;
    if (first.toLowerCase().startsWith('fee:')) continue;
    if (first.match(/^\d{1,2}\/\d{1,2}\/\d{2,4}$/) && row.slice(1).every(c => !c)) continue;
    if (first === 'Total') continue;

    const get = name => { const idx = headers.indexOf(name); return idx >= 0 ? row[idx] : ''; };
    const openedStr = first;
    const closedStr = String(get('Closed')).trim();
    const heldStr   = String(get('Held')).trim();
    if (!openedStr) continue;

    let fecha, openedHour, dateObj, year, month, day;
    if (openedStr.includes('/') || openedStr.includes('-')) {
      const parts = openedStr.split(' ');
      const dp    = parts[0].split(/[\/\-]/);
      openedHour  = parts[1] || '';
      year = parseInt(dp[2]); if (year < 100) year += 2000;
      month = parseInt(dp[0]); day = parseInt(dp[1]);
      dateObj = new Date(year, month-1, day);
      fecha   = pad(day)+'/'+pad(month)+'/'+year;
    } else {
      const serial = parseFloat(openedStr);
      if (isNaN(serial)) continue;
      dateObj    = excelDateToJS(serial);
      year  = dateObj.getFullYear();
      month = dateObj.getMonth() + 1;
      day   = dateObj.getDate();
      fecha      = pad(day)+'/'+pad(month)+'/'+year;
      openedHour = secToHMS(Math.round((serial % 1) * 86400));
    }

    let closedHour = '';
    if (closedStr.includes(':')) closedHour = closedStr;
    else { const s = parseFloat(closedStr); if (!isNaN(s)) closedHour = secToHMS(Math.round((s%1)*86400)); }

    let minutos = 0, heldFmt = heldStr;
    if (heldStr.includes(':')) {
      const hp = heldStr.split(':').map(Number);
      minutos  = (hp[0]||0)*60 + (hp[1]||0) + (hp[2]||0)/60;
    } else {
      const s = parseFloat(heldStr);
      if (!isNaN(s)) { minutos = s*1440; heldFmt = secToHMS(Math.round(s*86400)); }
    }

    const entry=parseNum(get('Entry')), exit=parseNum(get('Exit')), qty=parseNum(get('Qty'));
    const gross=parseNum(get('Gross')), comm=parseNum(get('Comm')), ecnFee=parseNum(get('Ecn Fee'));
    const sec=parseNum(get('SEC')), taf=parseNum(get('TAF')), nscc=parseNum(get('NSCC'));
    const clr=parseNum(get('Clr')), cat=parseNum(get('CAT')), misc=parseNum(get('Misc'));
    const net=parseNum(get('Net'));

    const totalComm = comm + ecnFee + sec + taf + nscc + clr + cat;
    const recorrido = entry !== 0 ? Math.abs((exit - entry) / entry) : 0;
    const resultado = net > 0 ? 'P' : 'L';
    const hora      = openedHour ? parseInt(openedHour.split(':')[0]) : 0;
    const cierreH   = closedHour ? parseInt(closedHour.split(':')[0]) : 0;
    const mes       = dateObj ? MONTHS_ES[dateObj.getMonth()] : '';
    const dia       = dateObj ? DAYS_ES[dateObj.getDay()] : '';
    const priceLow  = Math.floor(entry / 0.5) * 0.5;
    const precio    = fmtN(priceLow,1)+' – '+fmtN(priceLow+0.5,1);
    const dateISO   = dateObj ? `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}` : '';

    result.push({
      _id: openedStr+'_'+String(get('Symbol')).trim(),
      opened:openedStr, closed:closedStr, held:heldFmt,
      symbol:String(get('Symbol')).trim().toUpperCase(),
      type:String(get('Type')).trim(),
      entry, exit, qty, gross, comm, ecnFee, sec, taf, nscc, clr, cat, misc, net,
      fecha, openedHour, mes, hora, cierreH, dia, precio, recorrido,
      resultado, hold:heldFmt, totalComm,
      minutos:parseFloat(minutos.toFixed(2)),
      dateISO,
      riesgo:'', rs:'', patron:'', confirm:'', volHist:'',
      noticia:'', pais:'', float:'', instit:'', insiders:'',
    });
  }
  return result;
}

function mergeTrades(existing, incoming) {
  const map = {};
  existing.forEach(t => map[t._id] = t);
  incoming.forEach(t => { if (!map[t._id]) map[t._id] = t; });
  return Object.values(map).sort((a,b) => a.opened.localeCompare(b.opened));
}

// ═══════════════════════════════
// FILTERS
// ═══════════════════════════════
function applyFilters() {
  const search = document.getElementById('search-input').value.trim().toUpperCase();
  displayed = trades.filter(t => {
    if (search && !t.symbol.includes(search)) return false;
    return true;
  });
  // Always sort by date desc, then by time desc
  displayed.sort((a,b) => {
    const d = (b.dateISO||'').localeCompare(a.dateISO||'');
    if (d !== 0) return d;
    return (b.openedHour||'').localeCompare(a.openedHour||'');
  });
  renderTableBody();
  updateStats();
}

function updateActiveFilterTags() {}
function clearOneFilter(i) {}

function clearFilters() {
  document.getElementById('search-input').value = '';
  applyFilters();
}


// ═══════════════════════════════
// RENDER ALL
// ═══════════════════════════════
function computeReentradas() {
  // Group by symbol + dateISO + type
  const groups = {};
  trades.forEach(t => {
    const key = `${t.symbol}|${t.dateISO}|${(t.type||'').toUpperCase()}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  // Reset all
  trades.forEach(t => { t.reentradas = 0; });

  Object.values(groups).forEach(group => {
    if (group.length < 2) return;
    // Sort by open time
    group.sort((a,b) => timeToMins(a.openedHour) - timeToMins(b.openedHour));
    // Mark each trade's re-entry count = how many prior trades in same cluster
    // A "cluster" resets if gap > RE_WINDOW_MIN
    let clusterStart = 0;
    for (let i = 1; i < group.length; i++) {
      const gap = timeToMins(group[i].openedHour) - timeToMins(group[i-1].openedHour);
      if (gap <= RE_WINDOW_MIN) {
        group[i].reentradas = i - clusterStart;
      } else {
        clusterStart = i;
        group[i].reentradas = 0;
      }
    }
  });
}

// ── Compute R's for ALL trades eagerly (don't rely on table render side-effect) ──
function computeAllRS() {
  trades.forEach(t => {
    const risk  = parseFloat(t.riesgo);
    const gross = typeof t.gross === 'number' ? t.gross : (t.net || 0);
    if (t.riesgo && !isNaN(risk) && risk !== 0) {
      t.rs = (gross / risk).toFixed(2);
    } else {
      t.rs = '';
    }
  });
}

function renderAll() {
  computeAllRS();
  displayed = [...trades].sort((a,b) => {
    const d = (b.dateISO||'').localeCompare(a.dateISO||'');
    if (d !== 0) return d;
    return (b.openedHour||'').localeCompare(a.openedHour||'');
  });
  updateStats();
  renderTable();
  const has = trades.length > 0;
  document.getElementById('export-btn').style.display   = has ? '' : 'none';
  document.getElementById('topbar-stats').style.display = has ? '' : 'none';
}

function renderPatronSelect() {
  // patron select removed from sidebar — no-op
}

// ─── Stats ───
function updateStats() {
  const vis   = displayed.length ? displayed : trades;
  if (!vis.length) return;
  const total = vis.length;
  const wins  = vis.filter(t => t.resultado === 'P').length;
  const netSum= vis.reduce((s,t) => s+t.net, 0);
  const gSum  = vis.reduce((s,t) => s+t.gross, 0);
  const best  = Math.max(...vis.map(t=>t.net));
  const worst = Math.min(...vis.map(t=>t.net));
  const rsArr = vis.filter(t=>t.rs!=='').map(t=>parseFloat(t.rs));
  const avgR  = rsArr.length ? rsArr.reduce((a,b)=>a+b,0)/rsArr.length : null;
  const wr    = total ? (wins/total*100).toFixed(1)+'%' : '—';
  const winsR = rsArr.filter(r=>r>0).reduce((a,b)=>a+b,0);
  const lossR = Math.abs(rsArr.filter(r=>r<0).reduce((a,b)=>a+b,0));
  const pf    = lossR > 0 ? (winsR/lossR).toFixed(2) : '—';

  const $ = (id,v,cls) => { const el=document.getElementById(id); if(!el)return; el.textContent=v; if(cls) el.className=el.className.replace(/\b(pos|neg|amber|neutral)\b/g,'')+' '+cls; };
  $('ss-total',total); $('ss-wr',wr,'amber');
  $('ss-pnl',fmtMoney(netSum),netSum>=0?'pos':'neg');
  $('ss-gross',fmtMoney(gSum),gSum>=0?'pos':'neg');
  $('ss-best',fmtMoney(best),'pos'); $('ss-worst',fmtMoney(worst),'neg');
  $('ts-total',total,'amber');
  $('ts-pnl',fmtMoney(netSum),netSum>=0?'pos':'neg');
  $('ts-wr',wr,'amber');
  $('ts-r',avgR!==null?avgR.toFixed(2)+'R':'—','amber');
  $('ts-pf',pf,'amber');
  document.getElementById('row-count').textContent = displayed.length + ' trade' + (displayed.length!==1?'s':'');
}

// ─── Table ───
const COL_DEFS = [
  {key:'contador',   label:'#',        auto:true,  sticky:true, left:0,   fmt:(t,i)=>`<span style="color:var(--muted)">${i+1}</span>`},
  {key:'fecha',      label:'Fecha',    auto:true,  sticky:true, left:32,  fmt:t=>t.fecha},
  {key:'openedHour', label:'H.Ent',    auto:true,  sticky:true, left:120, fmt:t=>t.openedHour},
  {key:'symbol',     label:'Symbol',   auto:true,  sticky:true, left:190, fmt:t=>`<span class="c-symbol" style="cursor:pointer;text-decoration:underline;text-underline-offset:3px" onclick="openTradeChart('${t.symbol}','${t.dateISO}')">${t.symbol}</span>`},
  {key:'type',       label:'Tipo',     auto:true,  sticky:true, left:248, fmt:t=>`<span class="badge badge-${t.type.toLowerCase()}">${t.type.toUpperCase()}</span>`},
  {key:'entry',      label:'Entry',    auto:true,  fmt:t=>fmtN(t.entry,4)},
  {key:'exit',       label:'Exit',     auto:true,  fmt:t=>fmtN(t.exit,4)},
  {key:'qty',        label:'Qty',      auto:true,  fmt:t=>t.qty.toLocaleString()},
  {key:'gross',      label:'Gross',    auto:true,  fmt:t=>`<span class="c-pnl ${t.gross>=0?'pos':'neg'}">${fmtMoney(t.gross)}</span>`},
  {key:'net',        label:'Net',      auto:true,  fmt:t=>`<span class="c-pnl ${t.net>=0?'pos':'neg'}">${fmtMoney(t.net)}</span>`},
  {key:'resultado',  label:'P/L',      auto:true,  fmt:t=>`<span class="badge badge-${t.resultado.toLowerCase()}">${t.resultado}</span>`},
  {key:'recorrido',  label:'Recorr.',  auto:true,  fmt:t=>{const p=(t.recorrido*100).toFixed(2)+'%';const w=Math.min(100,t.recorrido*180);return`<div class="recorrido-wrap">${p}<div class="recorrido-bar"><div class="recorrido-fill" style="width:${w}%"></div></div></div>`;}},
  {key:'minutos',    label:'Min.',     auto:true,  fmt:t=>fmtN(t.minutos,1)},
  // Manual
  {key:'riesgo',     label:'Riesgo$',  auto:false, editable:true, type:'number', placeholder:'20'},
  {key:'rs', label:"R's", auto:true, fmt:t=>{
    const risk = parseFloat(t.riesgo);
    if (!t.riesgo || isNaN(risk) || risk === 0) return `<span style="color:var(--muted)">—</span>`;
    const gross = typeof t.gross === 'number' ? t.gross : (t.net || 0);
    const r = gross / risk;
    t.rs = r.toFixed(2);
    return `<span class="c-rs ${r>=0?'pos':'neg'}">${r.toFixed(2)}</span>`;
  }},
  {key:'patron',     label:'Patrón',   auto:false, editable:true, type:'select', options:null},
  {key:'confirm',    label:'Confirm.', auto:false, editable:true, type:'select', options:null},
  {key:'instit',     label:'Inst.%',   auto:true, massive:true, fmt:t=>t.mInstitPct!=null?`<span style="color:var(--dim)">${t.mInstitPct}%</span>`:(t.instit?`<span style="color:var(--dim);font-style:italic">${t.instit}%</span>`:`<span style="color:var(--muted)">—</span>`)},
  {key:'insiders',   label:'Insid.%',  auto:true, massive:true, fmt:t=>t.mInsidPct!=null?`<span style="color:var(--dim)">${t.mInsidPct}%</span>`:(t.insiders?`<span style="color:var(--dim);font-style:italic">${t.insiders}%</span>`:`<span style="color:var(--muted)">—</span>`)},
  {key:'mNews',      label:'Noticias', auto:true, massive:true, fmt:t=>{
    if (!t.mNewsCount && t.mNewsCount !== 0) return `<span style="color:var(--muted)">—</span>`;
    if (t.mNewsCount === 0) return `<span style="color:var(--muted);font-size:9px">Sin noticias</span>`;
    const count = t.mNewsCount;
    const badge = `<span style="background:var(--amber);color:#000;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;cursor:pointer" onclick="openNewsModal(${trades.indexOf(t)})">${count} ●</span>`;
    return badge;
  }},
  // More auto
  {key:'precio',     label:'Precio',   auto:true,  fmt:t=>t.precio},
  {key:'mes',        label:'Mes',      auto:true,  fmt:t=>t.mes},
  {key:'dia',        label:'Día',      auto:true,  fmt:t=>t.dia},
  {key:'hora',       label:'H.Ent#',   auto:true,  fmt:t=>t.hora},
  {key:'totalComm',  label:'T.Comm',   auto:true,  fmt:t=>fmtMoney(t.totalComm)},
  {key:'held',       label:'Hold',     auto:true,  fmt:t=>t.held},
  // Massive API enriched
  {key:'mGapPct',    label:'Gap%',     auto:true,  massive:true, fmt:t=>t.mGapPct!=null?`<span class="${t.mGapPct>=0?'pos':'neg'}">${t.mGapPct.toFixed(1)}%</span>`:`<span style="color:var(--muted)">—</span>`},
  {key:'mPMGapPct',  label:'PM Gap%',  auto:true,  massive:true, fmt:t=>t.mPMGapPct!=null?`<span class="${t.mPMGapPct>=0?'pos':'neg'}">${t.mPMGapPct.toFixed(1)}%</span>`:`<span style="color:var(--muted)">—</span>`},
  {key:'mPMHigh',    label:'PM High',  auto:true,  massive:true, fmt:t=>t.mPMHigh!=null?`$${t.mPMHigh.toFixed(2)}`:`<span style="color:var(--muted)">—</span>`},
  {key:'mPMVol',     label:'PM Vol',   auto:true,  massive:true, fmt:t=>t.mPMVol!=null?fmtVol(t.mPMVol):`<span style="color:var(--muted)">—</span>`},
  {key:'mPMVol4',    label:'PM 4h',    auto:true,  massive:true, fmt:t=>t.mPMVol4!=null?fmtVol(t.mPMVol4):`<span style="color:var(--muted)">—</span>`},
  {key:'mPMVol5',    label:'PM 5h',    auto:true,  massive:true, fmt:t=>t.mPMVol5!=null?fmtVol(t.mPMVol5):`<span style="color:var(--muted)">—</span>`},
  {key:'mPMVol6',    label:'PM 6h',    auto:true,  massive:true, fmt:t=>t.mPMVol6!=null?fmtVol(t.mPMVol6):`<span style="color:var(--muted)">—</span>`},
  {key:'mPMVol7',    label:'PM 7h',    auto:true,  massive:true, fmt:t=>t.mPMVol7!=null?fmtVol(t.mPMVol7):`<span style="color:var(--muted)">—</span>`},
  {key:'mPMVol8',    label:'PM 8h',    auto:true,  massive:true, fmt:t=>t.mPMVol8!=null?fmtVol(t.mPMVol8):`<span style="color:var(--muted)">—</span>`},
  {key:'mPMVol9',    label:'PM 9h',    auto:true,  massive:true, fmt:t=>t.mPMVol9!=null?fmtVol(t.mPMVol9):`<span style="color:var(--muted)">—</span>`},
  {key:'mMarketCap', label:'Mkt Cap',  auto:true,  massive:true, fmt:t=>t.mMarketCap!=null?fmtFloat(t.mMarketCap):`<span style="color:var(--muted)">—</span>`},
  {key:'mFloat',     label:'Float',    auto:true,  massive:true, fmt:t=>t.mFloat!=null?fmtFloat(t.mFloat):`<span style="color:var(--muted)">—</span>`},
  {key:'mDayVol',    label:'Day Vol',  auto:true,  massive:true, fmt:t=>t.mDayVol!=null?fmtVol(t.mDayVol):`<span style="color:var(--muted)">—</span>`},
  {key:'mSector',    label:'SIC',      auto:true,  massive:true, fmt:t=>t.mSector?`<span style="font-size:9px;color:var(--dim);white-space:normal;max-width:140px;display:block">${t.mSector}</span>`:`<span style="color:var(--muted)">—</span>`},
  {key:'mCountry',   label:'País',     auto:true,  massive:true, fmt:t=>{
    const FLAG = {USA:'🇺🇸',China:'🇨🇳','Hong Kong':'🇭🇰',Canada:'🇨🇦','United Kingdom':'🇬🇧',Israel:'🇮🇱',Australia:'🇦🇺',Germany:'🇩🇪',France:'🇫🇷',Netherlands:'🇳🇱',Sweden:'🇸🇪',Switzerland:'🇨🇭',Japan:'🇯🇵',Ireland:'🇮🇪',Singapore:'🇸🇬',Brazil:'🇧🇷',India:'🇮🇳',Taiwan:'🇹🇼',Korea:'🇰🇷'};
    if (!t.mCountry) return `<span style="color:var(--muted)">—</span>`;
    const flag = FLAG[t.mCountry] || '🌐';
    return `<span style="font-size:11px" title="${t.mCountry}">${flag} ${t.mCountry}</span>`;
  }},
  {key:'sector',     label:'Sector',   auto:true,  fmt:t=>renderSectorCell(t)},
];

function renderTable() {
  displayed = [...trades];
  applyFilters();
}

function renderTableBody() {
  const empty = document.getElementById('empty-state');
  const tbl   = document.getElementById('main-table');
  if (!displayed.length) {
    empty.style.display = ''; tbl.style.display = 'none';
    document.getElementById('row-count').textContent = '0 trades'; return;
  }
  empty.style.display = 'none'; tbl.style.display = '';

  // Sort
  if (sortBy.col) {
    displayed.sort((a,b) => {
      // Use dateISO for fecha sorting to get correct chronological order
      const colA = sortBy.col === 'fecha' ? 'dateISO' : sortBy.col;
      const colB = sortBy.col === 'fecha' ? 'dateISO' : sortBy.col;
      let va=a[colA], vb=b[colB];
      if (typeof va==='number') return sortBy.dir==='asc'?va-vb:vb-va;
      return sortBy.dir==='asc'?String(va).localeCompare(String(vb)):String(vb).localeCompare(String(va));
    });
  }

  // Header
  const thead = document.getElementById('thead');
  thead.innerHTML = '<tr>' + COL_DEFS.map(c => {
    const cls = [c.auto ? (c.massive ? 'massive-col-header' : '') : 'manual-col', c.sticky ? 'sticky-col' : '', sortBy.col===c.key ? (sortBy.dir==='asc'?' sorted-asc':' sorted-desc') : ''].join(' ').trim();
    const style = c.sticky ? `style="left:${c.left}px"` : '';
    return `<th class="${cls}" ${style} onclick="sortCol('${c.key}')">${c.label}</th>`;
  }).join('') + '</tr>';

  // Body
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = displayed.map((t,i) => {
    const idx = trades.indexOf(t);
    const hasMassive = t.mGapPct != null || t.mFloat != null;
    return `<tr class="${hasMassive?'has-massive':''}" title="${hasMassive?'Click para ver datos Massive':''}">` + COL_DEFS.map(c => {
      const stickyStyle = c.sticky ? `position:sticky;left:${c.left}px;` : '';
      const stickyClass = c.sticky ? 'sticky-col' : '';
      if (c.editable) {
        if (c.type === 'select') {
          const opts = PATTERNS.map(o => `<option value="${o}" ${t[c.key]===o?'selected':''}>${o||'—'}</option>`).join('');
          return `<td class="editable-cell ${stickyClass}" style="${stickyStyle}" data-row="${idx}" data-col="${c.key}"><select class="cell-select" onchange="editTrade(${idx},'${c.key}',this.value)">${opts}</select><div class="fill-handle" onmousedown="startFill(event,${idx},'${c.key}')"></div></td>`;
        }
        const val = t[c.key] !== undefined ? t[c.key] : '';
        return `<td class="editable-cell ${stickyClass}" style="${stickyStyle}" data-row="${idx}" data-col="${c.key}"><span class="editable" contenteditable="true" data-placeholder="${c.placeholder||''}" onblur="editTrade(${idx},'${c.key}',this.textContent.trim())" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}">${val}</span><div class="fill-handle" onmousedown="startFill(event,${idx},'${c.key}')"></div></td>`;
      }
      const cellCls = `${c.massive ? 'massive-col' : ''} ${stickyClass}`.trim();
      return `<td class="${cellCls}" style="${stickyStyle}" onclick="${c.massive||c.key==='symbol'?`openInspector(${idx})`:''}"">${c.fmt(t,i)}</td>`;
    }).join('') + '</tr>';
  }).join('');
}

function sortCol(col) {
  if (sortBy.col===col) sortBy.dir = sortBy.dir==='asc'?'desc':'asc';
  else { sortBy.col=col; sortBy.dir='asc'; }
  renderTableBody();
}

function editTrade(idx, key, val) {
  trades[idx][key] = val;
  if (key==='riesgo') {
    const r = parseFloat(val);
    trades[idx].rs = (!isNaN(r)&&r!==0) ? (trades[idx].gross/r).toFixed(2) : '';
  }
  save(); updateStats();
}

// ═══════════════════════════════
// DRAG TO FILL
// ═══════════════════════════════
let fillState = null;
function startFill(e, rowIdx, colKey) {
  e.preventDefault(); e.stopPropagation();
  const sourceTd = e.target.closest('td');
  fillState = { rowIdx, colKey, sourceVal: trades[rowIdx][colKey], sourceTd, targets: [] };
  sourceTd.classList.add('fill-source');
  document.addEventListener('mousemove', onFillMove);
  document.addEventListener('mouseup',   onFillUp);
}
function onFillMove(e) {
  if (!fillState) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el) return;
  const td = el.closest('td[data-col]');
  fillState.targets.forEach(t => t.classList.remove('fill-target'));
  fillState.targets = [];
  if (!td || td.dataset.col !== fillState.colKey) return;
  const tbody = document.getElementById('tbody');
  const all   = Array.from(tbody.querySelectorAll(`td[data-col="${fillState.colKey}"]`));
  const si    = all.findIndex(c => parseInt(c.dataset.row) === fillState.rowIdx);
  const ti    = all.indexOf(td);
  if (si<0||ti<0) return;
  const from=Math.min(si,ti), to=Math.max(si,ti);
  all.slice(from,to+1).forEach(c => { if(parseInt(c.dataset.row)!==fillState.rowIdx){c.classList.add('fill-target');fillState.targets.push(c);} });
}
function onFillUp(e) {
  if (!fillState) return;
  document.removeEventListener('mousemove', onFillMove);
  document.removeEventListener('mouseup',   onFillUp);
  fillState.targets.forEach(td => {
    td.classList.remove('fill-target');
    const idx = parseInt(td.dataset.row);
    trades[idx][fillState.colKey] = fillState.sourceVal;
    if (fillState.colKey==='riesgo') {
      const r = parseFloat(fillState.sourceVal);
      trades[idx].rs = (!isNaN(r)&&r!==0)?(trades[idx].gross/r).toFixed(2):'';
    }
    const span = td.querySelector('.editable');
    if (span) span.textContent = fillState.sourceVal;
    const sel = td.querySelector('.cell-select');
    if (sel) sel.value = fillState.sourceVal;
  });
  fillState.sourceTd.classList.remove('fill-source');
  if (fillState.targets.length > 0) {
    save(); updateStats();
    toast(`Aplicado a ${fillState.targets.length} trade${fillState.targets.length>1?'s':''}`, 'ok');
  }
  fillState = null;
}

// ═══════════════════════════════
// ANALYTICS
// ═══════════════════════════════
// ═══════════════════════════════
// ANALYTICS TIME WINDOW
// ═══════════════════════════════
let analyticsWindow = 'all';
let analyticsFrom   = null;
let analyticsTo     = null;

function setAnalyticsWindow(preset) {
  analyticsWindow = preset;
  const now  = new Date();
  const todayISO = now.toISOString().slice(0,10);

  // Deactivate all buttons, activate selected
  document.querySelectorAll('.an-tw-btn').forEach(b => b.classList.remove('active'));
  const btnMap = {all:0,ytd:1,'3m':2,'1m':3,'2w':4,'1w':5,today:6};
  const btns = document.querySelectorAll('.an-tw-btn');
  if (preset !== 'custom' && btnMap[preset] !== undefined) btns[btnMap[preset]].classList.add('active');

  if (preset === 'all') {
    analyticsFrom = null; analyticsTo = null;
  } else if (preset === 'today') {
    analyticsFrom = todayISO; analyticsTo = todayISO;
  } else if (preset === '1w') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    analyticsFrom = d.toISOString().slice(0,10); analyticsTo = todayISO;
  } else if (preset === '2w') {
    const d = new Date(now); d.setDate(d.getDate() - 14);
    analyticsFrom = d.toISOString().slice(0,10); analyticsTo = todayISO;
  } else if (preset === '1m') {
    analyticsFrom = todayISO.slice(0,7) + '-01'; analyticsTo = todayISO;
  } else if (preset === '3m') {
    const d = new Date(now); d.setMonth(d.getMonth() - 3);
    analyticsFrom = d.toISOString().slice(0,10); analyticsTo = todayISO;
  } else if (preset === 'ytd') {
    analyticsFrom = todayISO.slice(0,4) + '-01-01'; analyticsTo = todayISO;
  } else if (preset === 'custom') {
    analyticsFrom = document.getElementById('an-date-from').value || null;
    analyticsTo   = document.getElementById('an-date-to').value   || null;
  }

  // Sync date inputs
  if (preset !== 'custom') {
    if (document.getElementById('an-date-from')) {
      document.getElementById('an-date-from').value = analyticsFrom || '';
      document.getElementById('an-date-to').value   = analyticsTo   || '';
    }
  }

  renderAnalytics();
}

function getAnalyticsData() {
  if (!analyticsFrom && !analyticsTo) return trades;
  return trades.filter(t => {
    if (analyticsFrom && t.dateISO < analyticsFrom) return false;
    if (analyticsTo   && t.dateISO > analyticsTo)   return false;
    return true;
  });
}

function updateAnalyticsInfo(data) {
  const el = document.getElementById('an-tw-info');
  if (!el) return;
  if (!data.length) { el.textContent = 'Sin trades'; return; }
  const dates  = data.map(t => t.dateISO).filter(Boolean).sort();
  const days   = new Set(dates).size;
  const label  = analyticsWindow === 'all'  ? 'Todo el historial' :
                 analyticsWindow === 'today' ? 'Hoy' :
                 analyticsWindow === '1w'   ? 'Última semana' :
                 analyticsWindow === '2w'   ? 'Últimas 2 semanas' :
                 analyticsWindow === '1m'   ? 'Este mes' :
                 analyticsWindow === '3m'   ? 'Últimos 3 meses' :
                 analyticsWindow === 'ytd'  ? 'Este año' : 'Rango personalizado';
  el.innerHTML = `${label} · <strong>${data.length}</strong> trades · ${days} días · ${dates[0]} → ${dates[dates.length-1]}`;
}

function renderAnalytics() {
  const data = getAnalyticsData();
  updateAnalyticsInfo(data);
  if (!data.length) {
    document.getElementById('kpi-row').innerHTML = '<div style="color:var(--dim);font-family:var(--sans);font-size:13px;padding:20px">Sin datos en este rango de fechas.</div>';
    // Clear all charts so old data doesn't linger
    if (equityChart) { equityChart.destroy(); equityChart = null; }
    ['chart-patron','chart-precio','chart-hold','chart-weekday','chart-hora-wrap',
     'chart-sector','chart-symbol-wr','chart-daily-pnl'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div style="color:var(--dim);font-family:var(--sans);font-size:12px;padding:16px 0">Sin datos</div>';
    });
    const ec = document.getElementById('equity-chart');
    if (ec) { const p = ec.parentNode; ec.remove(); const c = document.createElement('canvas'); c.id='equity-chart'; p.appendChild(c); }
    return;
  }

  // KPIs
  const total = data.length;
  const wins  = data.filter(t=>t.resultado==='P').length;
  const netSum= data.reduce((s,t)=>s+t.net,0);
  const gSum  = data.reduce((s,t)=>s+t.gross,0);
  const commSum= data.reduce((s,t)=>s+t.totalComm,0);
  const rsArr = data.filter(t=>t.rs!=='').map(t=>parseFloat(t.rs));
  const avgR  = rsArr.length ? rsArr.reduce((a,b)=>a+b,0)/rsArr.length : 0;
  const winsR = rsArr.filter(r=>r>0).reduce((a,b)=>a+b,0);
  const lossR = Math.abs(rsArr.filter(r=>r<0).reduce((a,b)=>a+b,0));
  const pf    = lossR>0 ? winsR/lossR : null;
  const streak = calcStreak(data);

  document.getElementById('kpi-row').innerHTML = [
    {label:'TOTAL TRADES', val:total, sub:'', cls:'neutral'},
    {label:'WIN RATE',     val:(wins/total*100).toFixed(1)+'%', sub:`${wins}W / ${total-wins}L`, cls:'amber'},
    {label:'NET P&L',      val:'$'+netSum.toFixed(2), sub:'Total neto', cls:netSum>=0?'pos':'neg'},
    {label:'AVG R',        val:avgR?avgR.toFixed(2)+'R':'—', sub:'Media por trade', cls:avgR>=0?'pos':'neg'},
    {label:'PROFIT FACTOR',val:pf?pf.toFixed(2):'—', sub:'Bruto wins/losses', cls:pf&&pf>=1?'pos':'neg'},
    {label:'RACHA ACTUAL', val:streak.val, sub:streak.label, cls:streak.val>0?'pos':streak.val<0?'neg':'neutral'},
  ].map(k=>`<div class="kpi-card"><div class="kpi-label">${k.label}</div><div class="kpi-val ${k.cls}">${k.val}</div><div class="kpi-sub">${k.sub}</div></div>`).join('');

  // Equity curve
  renderEquityChart(data);

  // Bar charts
  renderPatronChart(data);
  renderBarChart('chart-precio', groupWinRate(data, t => precioBucket(parseFloat(t.precio))));
  renderBarChart('chart-hold',   groupWinRate(data, t=>holdBucket(t.minutos)));
  renderBarChart('chart-dia',    groupWinRate(data, t=>t.dia||'—'));
  renderHourChart(data);
  renderShortsBySector(data);
  renderSectorChart('chart-long-sector', data, 'long');
  renderLongShortComparison(data);
  renderTopTickers(data);
  renderMassiveChart('chart-gap',   data, gapBucket,   'Gap%');
  renderMassiveChart('chart-float', data, floatBucket, 'Float');
  renderMassiveChart('chart-pmvol', data, pmvolBucket, 'PM Vol');
  renderSessionChart(data);
  renderDayOfMonthChart(data);
  renderHoldByPatron(data);
  renderHeatmap(data);
  renderOwnershipBySide('chart-long-instit',    data, 'mInstitPct', 'long');
  renderOwnershipBySide('chart-short-instit',   data, 'mInstitPct', 'short');
  renderOwnershipBySide('chart-long-insiders',  data, 'mInsidPct',  'long');
  renderOwnershipBySide('chart-short-insiders', data, 'mInsidPct',  'short');
  renderGapScatter(data);
  renderSizeScatter(data);
  renderMFEMAE(data);
  renderMonthly(data);
}

function calcStreak(data) {
  if (!data.length) return {val:0, label:''};
  const sorted = [...data].sort((a,b)=>a.opened.localeCompare(b.opened));
  let streak = 0;
  const last = sorted[sorted.length-1].resultado;
  for (let i = sorted.length-1; i>=0; i--) {
    if (sorted[i].resultado === last) streak++;
    else break;
  }
  return { val: last==='P' ? streak : -streak, label: last==='P' ? `${streak} wins seguidas` : `${streak} losses seguidas` };
}

function groupWinRate(data, keyFn) {
  const map = {};
  data.forEach(t => {
    const k = keyFn(t);
    if (!map[k]) map[k] = {wins:0,total:0};
    map[k].total++;
    if (t.resultado==='P') map[k].wins++;
  });
  const rows = Object.entries(map)
    .filter(([k,v]) => k && k!=='—' && v.total >= 1)
    .map(([k,v]) => ({label:k, wr:v.wins/v.total, n:v.total}));
  // Named patterns sorted by WR descending, "Sin patrón" always last
  const named = rows.filter(r => r.label !== 'Sin patrón').sort((a,b) => b.n - a.n || b.wr - a.wr);
  const noP   = rows.filter(r => r.label === 'Sin patrón');
  return [...named, ...noP];
}

function precioBucket(p) {
  if (!p || isNaN(p)) return '—';
  if (p < 1)   return '<$1';
  if (p < 2)   return '$1–2';
  if (p < 3)   return '$2–3';
  if (p < 5)   return '$3–5';
  if (p < 7)   return '$5–7';
  if (p < 10)  return '$7–10';
  if (p < 15)  return '$10–15';
  return '$15+';
}

function holdBucket(m) {
  if (m < 5)   return '0–5 min';
  if (m < 10)  return '5–10 min';
  if (m < 20)  return '10–20 min';
  if (m < 30)  return '20–30 min';
  if (m < 60)  return '30–60 min';
  if (m < 90)  return '60–90 min';
  return '90+ min';
}

// ── Unified bar row renderer ──
function barRow(label, wr, n, net, labelWidth='110px') {
  const pctColor = wr >= 58 ? 'var(--green)' : wr >= 45 ? '#e2e2e2' : 'var(--red)';
  const netStr = net != null
    ? `<span style="font-family:var(--mono);font-size:10px;color:${net>=0?'var(--green)':'var(--red)'};min-width:64px;text-align:right">${(net>=0?'+':'')+fmtMoney(net)}</span>`
    : '';
  return `<div style="display:grid;grid-template-columns:${labelWidth} 1fr 46px 30px ${net!=null?'64px':''};align-items:center;gap:8px">
    <span style="font-family:var(--sans);font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${label}">${label}</span>
    <div class="bar-track"><div class="bar-fill-g" style="width:${wr}%"></div></div>
    <span class="bar-pct" style="color:${pctColor}">${wr.toFixed(1)}%</span>
    <span class="bar-n">${n}T</span>
    ${netStr}
  </div>`;
}

function renderBarChart(id, rows) {
  const el = document.getElementById(id);
  if (!rows.length) { el.innerHTML = '<span style="color:var(--muted);font-size:11px;font-family:var(--sans)">Sin datos suficientes</span>'; return; }
  el.innerHTML = rows.map(r => barRow(r.label, r.wr*100, r.n, null)).join('');
}

function renderPatronChart(data) {
  const el = document.getElementById('chart-patron');
  if (!el) return;
  // Group by patron with net P&L
  const map = {};
  data.forEach(t => {
    const k = t.patron || 'Sin patrón';
    if (!map[k]) map[k] = {wins:0, total:0, net:0};
    map[k].total++;
    map[k].net += t.net || 0;
    if (t.resultado === 'P') map[k].wins++;
  });
  const rows = Object.entries(map)
    .filter(([k]) => k && k !== '—')
    .map(([k,v]) => ({label:k, wr:v.wins/v.total, n:v.total, net:v.net}));
  const named = rows.filter(r => r.label !== 'Sin patrón').sort((a,b) => b.n - a.n || b.wr - a.wr);
  const noP   = rows.filter(r => r.label === 'Sin patrón');
  const all   = [...named, ...noP];
  if (!all.length) { el.innerHTML = '<span style="color:var(--muted);font-size:11px;font-family:var(--sans)">Sin patrones asignados</span>'; return; }
  el.innerHTML = all.map(r => barRow(r.label, r.wr*100, r.n, r.net, '100px')).join('');
}

function renderSectorBars(el, data, side) {
  const filtered = data.filter(t => {
    const isShortT = t.type?.toLowerCase() === 'short';
    if (side === 'long'  && isShortT)  return false;
    if (side === 'short' && !isShortT) return false;
    return effectiveSector(t) !== null;
  });
  if (!filtered.length) { el.innerHTML=`<div style="color:var(--dim);font-size:11px;padding:8px;font-family:var(--sans)">Sin datos. Enriquece con Massive o asigna sector manual.</div>`; return; }
  const grouped = {};
  filtered.forEach(t => {
    const s = effectiveSector(t);
    if (!grouped[s]) grouped[s]={wins:0,total:0,net:0};
    grouped[s].total++; if(t.resultado==='P') grouped[s].wins++; grouped[s].net+=t.net;
  });
  const rows = Object.entries(grouped).sort((a,b)=>b[1].total-a[1].total);
  el.innerHTML = rows.map(([s,v])=>barRow(s, v.wins/v.total*100, v.total, v.net, '130px')).join('');
}

function renderHourChart(data) {
  _renderHourGrid('chart-hora', data, t => t.hora);
  // Exit hour: parse from closedTime or derive from openedHour + minutos
  _renderHourGrid('chart-hora-salida', data, t => {
    if (t.closedHour != null) return t.closedHour;
    // estimate: entry hour + hold minutes
    if (t.hora != null && t.minutos != null) {
      const exitH = Math.floor((t.hora * 60 + (t.minutos || 0)) / 60);
      return exitH >= 7 && exitH <= 16 ? exitH : null;
    }
    return null;
  });
}

function _renderHourGrid(id, data, hourFn) {
  const el = document.getElementById(id);
  if (!el) return;
  const hours = {};
  for (let h = 7; h <= 16; h++) hours[h] = {wins:0, total:0};
  data.forEach(t => {
    const h = hourFn(t);
    if (h != null && h >= 7 && h <= 16) {
      hours[h].total++;
      if (t.resultado === 'P') hours[h].wins++;
    }
  });
  el.innerHTML = Object.entries(hours).map(([h, v]) => {
    const pct = v.total ? (v.wins / v.total * 100).toFixed(0) : null;
    const intensity = pct !== null ? v.wins / v.total : 0;
    const bg = pct === null ? 'var(--bg3)' :
      intensity >= 0.6  ? `rgba(61,186,111,${0.1 + intensity * 0.3})` :
      intensity >= 0.45 ? `rgba(30,155,255,${0.1 + intensity * 0.25})` :
                          `rgba(224,82,82,${0.1 + (1-intensity) * 0.25})`;
    const col = pct === null ? 'var(--muted)' :
      intensity >= 0.6  ? 'var(--green)' :
      intensity >= 0.45 ? '#1e9bff' : 'var(--red)';
    return `<div class="hour-cell" style="background:${bg}">
      <div class="h-time">${h}:00</div>
      <div class="h-pct" style="color:${col}">${pct !== null ? pct + '%' : '—'}</div>
      <div class="h-n">${v.total || ''}</div>
    </div>`;
  }).join('');
}

function setEquityMode(mode) {
  equityMode = mode;
  ['r','dollar','gross'].forEach(m => {
    const btn = document.getElementById(`equity-btn-${m}`);
    if (btn) btn.classList.toggle('active', m === mode);
  });
  const titles = { r: "Curva de Equity — R's Acumuladas", dollar: "Curva de Equity — Net P&L ($)", gross: "Curva de Equity — Gross P&L ($)" };
  const el = document.getElementById('equity-chart-title');
  if (el) el.textContent = titles[mode];
  const data = getAnalyticsData();
  if (data.length) renderEquityChart(data);
}

function renderEquityChart(data) {
  const sorted = [...data].sort((a,b)=>a.opened.localeCompare(b.opened));

  // Determine series based on mode
  let series, getValue, fmt, decimals;
  if (equityMode === 'r') {
    series   = sorted.filter(t => t.rs !== '');
    getValue = t => parseFloat(t.rs) || 0;
    fmt      = v => v + 'R';
    decimals = 3;
    if (!series.length) { series = sorted; getValue = t => t.net; fmt = v => '$'+v; decimals = 2; }
  } else if (equityMode === 'dollar') {
    series   = sorted;
    getValue = t => t.net;
    fmt      = v => '$'+v;
    decimals = 2;
  } else { // gross
    series   = sorted;
    getValue = t => t.gross;
    fmt      = v => '$'+v;
    decimals = 2;
  }

  let cumR=[], cum=0, xLabels=[];
  cumR.push(0); xLabels.push('');
  series.forEach((t, i) => {
    cum += getValue(t);
    cumR.push(parseFloat(cum.toFixed(decimals)));
    const prev = series[i-1];
    xLabels.push(t.dateISO && t.dateISO !== prev?.dateISO ? t.dateISO.slice(5) : '');
  });

  if (equityChart) equityChart.destroy();
  const ctx = document.getElementById('equity-chart').getContext('2d');

  // Build a gradient that's green above zero and red below zero
  const minVal = Math.min(...cumR, 0);
  const maxVal = Math.max(...cumR, 0);
  const range  = maxVal - minVal || 1;
  const zeroRatio = maxVal / range; // 0 = all below, 1 = all above

  const h = ctx.canvas.offsetHeight || ctx.canvas.parentElement?.offsetHeight || 300;

  const lineGrad = ctx.createLinearGradient(0, 0, 0, h);
  lineGrad.addColorStop(0,                                        '#3dba6f');
  lineGrad.addColorStop(Math.max(0, Math.min(0.9999, zeroRatio)), '#3dba6f');
  lineGrad.addColorStop(Math.max(0, Math.min(0.9999, zeroRatio)), '#e05252');
  lineGrad.addColorStop(1,                                        '#e05252');

  const fillGrad = ctx.createLinearGradient(0, 0, 0, h);
  fillGrad.addColorStop(0,                                        'rgba(61,186,111,0.12)');
  fillGrad.addColorStop(Math.max(0, Math.min(0.9999, zeroRatio)), 'rgba(61,186,111,0.04)');
  fillGrad.addColorStop(Math.max(0, Math.min(0.9999, zeroRatio)), 'rgba(224,82,82,0.04)');
  fillGrad.addColorStop(1,                                        'rgba(224,82,82,0.12)');

  // Fallback colors when all values same side of zero
  const allPos = minVal >= 0;
  const allNeg = maxVal <= 0;

  equityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: xLabels,
      datasets: [{
        data: cumR,
        borderColor: allPos ? '#3dba6f' : allNeg ? '#e05252' : lineGrad,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.1,
        fill: true,
        backgroundColor: allPos ? 'rgba(61,186,111,0.08)' : allNeg ? 'rgba(224,82,82,0.08)' : fillGrad,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend:{display:false},
        tooltip:{
          callbacks:{
            title: ctx => {
              const i = ctx[0].dataIndex;
              const t = series[i-1]; // offset by 1 because of leading 0
              return t ? `${t.symbol} · ${t.fecha || t.dateISO}` : 'Inicio';
            },
            label: ctx => {
              const i = ctx.dataIndex;
              return [`Trade #${i}`, `Acum: ${fmt(cumR[i])}`];
            }
          }
        }
      },
      scales: {
        x: {
          display: true,
          ticks: {
            color: '#444',
            font: { family: 'DM Mono', size: 9 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 20,
          },
          grid: { display: false },
          border: { color: 'rgba(255,255,255,0.06)' }
        },
        y: {
          grid:{color:'rgba(255,255,255,0.04)'},
          ticks:{color:'#555', font:{family:'DM Mono', size:9},
            callback: v => fmt(v)
          },
          border:{color:'transparent'}
        }
      }
    }
  });
}

// SIC → broad sector mapping (Yahoo Finance style)
// ── Manual Sector System ──────────────────────────────────
const MANUAL_SECTORS = [
  { label: 'Salud & Biotech',    color: '#4ecdc4' },
  { label: 'Tecnología',         color: '#2d7dd2' },
  { label: 'Energía',            color: '#f4a261' },
  { label: 'Financiero',         color: '#2dba6f' },
  { label: 'Consumo',            color: '#e76f51' },
  { label: 'Industrial',         color: '#a8dadc' },
  { label: 'Materias Primas',    color: '#c77dff' },
  { label: 'Construcción',       color: '#e9c46a' },
  { label: 'Servicios',          color: '#ffd166' },
  { label: 'Media & Ocio',       color: '#f72585' },
  { label: 'Cripto / Fintech',   color: '#06d6a0' },
  { label: 'Otros',              color: '#888' },
];

function effectiveSector(t) {
  // Manual sector takes priority; fall back to auto-classified Massive sector
  if (t.manualSector) return t.manualSector;
  if (t.mSector)      return broadSector(t.mSector);
  return null;
}

function renderSectorCell(t) {
  const manual = t.manualSector ? MANUAL_SECTORS.find(s=>s.label===t.manualSector) : null;
  const auto   = t.mSector ? broadSector(t.mSector) : null;
  const editBtn = `<button class="sector-edit-btn" onclick="openSectorPicker(event,'${t.symbol}','${t.dateISO}','${(t.openedHour||'')}')">✎</button>`;
  if (manual) {
    return `<div class="sector-cell">
      <span class="sector-manual-tag" style="background:${manual.color}">${manual.label}</span>
      ${editBtn}
    </div>`;
  }
  if (auto) {
    return `<div class="sector-cell">
      <span class="sector-auto-tag">${auto}</span>
      ${editBtn}
    </div>`;
  }
  return `<div class="sector-cell"><span style="color:var(--muted);font-size:11px">—</span>${editBtn}</div>`;
}

let _sectorPickerClose = null;
function openNewsModal(idx) {
  const t = trades[idx];
  if (!t || !t.mNews) return;
  const articles = t.mNews.split(' | ');
  const html = articles.map(a => {
    // Try to extract [Source] from end
    const m = a.match(/^(.*)\[(.+)\]$/);
    const title  = m ? m[1].trim() : a;
    const source = m ? m[2] : '';
    return `<div style="padding:8px 0;border-bottom:1px solid var(--border2)">
      <div style="font-size:12px;color:var(--text);line-height:1.4">${title}</div>
      ${source ? `<div style="font-size:10px;color:var(--amber);margin-top:3px">${source}</div>` : ''}
    </div>`;
  }).join('');
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:20px;max-width:560px;width:90%;max-height:70vh;overflow-y:auto">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-size:13px;font-weight:700;color:var(--text)">${t.symbol} · Noticias ${t.dateISO}</div>
      <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;color:var(--dim);font-size:18px;cursor:pointer">✕</button>
    </div>
    ${html}
  </div>`;
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

function openSectorPicker(e, symbol, dateISO, openedHour) {
  e.stopPropagation();
  document.getElementById('sector-dropdown')?.remove();
  if (_sectorPickerClose) { _sectorPickerClose(); _sectorPickerClose = null; return; }

  const t = trades.find(x => x.symbol===symbol && x.dateISO===dateISO && (x.openedHour||'')===(openedHour||''));
  if (!t) return;

  const dd = document.createElement('div');
  dd.id = 'sector-dropdown';
  dd.className = 'sector-dropdown';
  // Clear option
  dd.innerHTML = `<div class="sector-opt" onclick="setSectorManual('${symbol}','${dateISO}','${openedHour}',null)">
    <span class="sector-opt-dot" style="background:var(--muted)"></span>
    <span style="color:var(--muted)">Sin sector (automático)</span>
  </div>` + MANUAL_SECTORS.map(s =>
    `<div class="sector-opt ${t.manualSector===s.label?'selected':''}" onclick="setSectorManual('${symbol}','${dateISO}','${openedHour}','${s.label}')">
      <span class="sector-opt-dot" style="background:${s.color}"></span>
      <span>${s.label}</span>
      ${t.manualSector===s.label ? '<span style="margin-left:auto;color:var(--amber)">✓</span>' : ''}
    </div>`
  ).join('');

  const rect = e.target.getBoundingClientRect();
  dd.style.left = Math.min(rect.left, window.innerWidth-200) + 'px';
  dd.style.top  = (rect.bottom + 4) + 'px';
  document.body.appendChild(dd);

  _sectorPickerClose = () => { dd.remove(); _sectorPickerClose = null; };
  setTimeout(() => document.addEventListener('click', _sectorPickerClose, {once:true}), 10);
}

function setSectorManual(symbol, dateISO, openedHour, sector) {
  const t = trades.find(x => x.symbol===symbol && x.dateISO===dateISO && (x.openedHour||'')===(openedHour||''));
  if (!t) return;
  if (sector === null) delete t.manualSector;
  else t.manualSector = sector;
  document.getElementById('sector-dropdown')?.remove();
  _sectorPickerClose = null;
  saveToIDB();
  renderTableBody();
}

function broadSector(sicStr) {
  if (!sicStr) return 'Otros';
  const s = sicStr.toUpperCase();

  // Salud & Biotech
  if (/PHARMA|DRUG|BIOTECH|BIOLOGICAL|SURGICAL|ELECTROMED|OPHTHALM|ORTHOPED|HEALTH SERV|MEDICAL|HOME HEALTH|HOSPITAL|DENTAL|OPTOM|CHIROPRAC|NURSING|CLINIC|DIAGNOSTIC|THERAPEUT|LIFE SCIENCE|GENOMIC|ONCOL|CARDIOL|IMMUNOL|VACCINE|LABORATOR|CLINICAL TRIAL|BIOPHARMA|BIOSCIENCE|NUTRACEUTIC|VETERINA|ANIMAL HEALTH|CANNABIS|HEMP|CBD|MARIJUANA/.test(s)) return 'Salud & Biotech';

  // Tecnología
  if (/SEMICONDUCTOR|ELECTRONIC COMP|COMPUTER|SOFTWARE|SERVICES-COMP|SERVICES-PREPACK|TELEPHONE|RADIO|COMMUNICATION|SERVICES-MANAGE|INTERNET|CLOUD|CYBERSEC|ARTIFICIAL INTEL|MACHINE LEARN|DATA CENTER|NETWORK|WIRELESS|TELECOM|FIBER|SATELLITE|TECH|DIGITAL|PLATFORM|SAAS|FINTECH|INFORMATION TECH|IT SERV|MICROCHIP|PROCESSOR|CIRCUIT|HARDWARE|PERIPHERAL|DISPLAY|SEMICONDUCTOR|MEMORY|STORAGE|SENSOR|DRONE|ROBOT|AUTOMATION|STREAMING|SOCIAL MEDIA|E-COMMERCE|ECOMMERCE|SEARCH ENGINE|CYBERSECURITY|BLOCKCHAIN|CRYPTO/.test(s)) return 'Tecnología';

  // Energía
  if (/PETROLEUM|CRUDE|OIL|NATURAL GAS|GAS & OIL|COAL|POWER|ELECTRIC UTIL|NUCLEAR|SOLAR|ENERGY|WIND POWER|GEOTHERMAL|HYDRO|REFIN|PIPELINE|LNG|LPG|BIOFUEL|RENEWABL|CLEAN ENERGY|FOSSIL|DRILLING|EXPLOR.*PRODUC|OIL FIELD|OFFSHORE/.test(s)) return 'Energía';

  // Financiero
  if (/BANK|FINANCE|INSURANCE|INVEST|REAL ESTATE|MORTGAGE|SAVINGS|CREDIT|REIT|BROKERAGE|ASSET MANAGEMENT|WEALTH|PRIVATE EQUITY|HEDGE FUND|CAPITAL MARKETS|TRADING|EXCHANGE|CLEARING|PAYMENT|LENDING|LEASING|TRUST|ANNUIT|UNDERWR|MUTUAL FUND|ETF/.test(s)) return 'Financiero';

  // Consumo
  if (/RETAIL|WHOLESALE|FOOD|BEVERAGE|CONSUMER|APPAREL|FURNITURE|PERFUME|COSMETIC|CLOTH|SHOES|FASHION|LUXURY|RESTAURANT|FAST FOOD|GROCERY|SUPERMARKET|TOY|GAME|SPORT GOODS|BEAUTY|PERSONAL CARE|HOUSEHOLD|TOBACCO|ALCOHOL|WINE|BREW|DISTIL|E-RETAIL|ONLINE RETAIL/.test(s)) return 'Consumo';

  // Industrial & Manufactura
  if (/AIRCRAFT|AUTO|MOTOR VEHICLE|AEROSPACE|GUIDED MISSILE|SHIP|RAILROAD|AIR TRANSPORT|MANUFACTUR|MACHIN|EQUIPMENT|TOOL|PUMP|VALVE|BEARING|INDUSTRIAL|DEFENSE|WEAPON|MILITAR|CONSTRUCT.*EQUIP|HEAVY EQUIP|TRUCK|TRAILER|PACKAGING|CONTAINER|PRINT|PAPET|TEXTILE|PLASTIC|RUBBER|CHEMICAL|CEMENT|GLASS|CERAMIC|METAL FABRICAT/.test(s)) return 'Industrial';

  // Materias Primas
  if (/MINING|METAL|STEEL|COPPER|GOLD|SILVER|ALUMINUM|IRON|ZINC|NICKEL|LITHIUM|COBALT|RARE EARTH|MINERAL|ORE|COMMODITY|AGRICULTURAL|TIMBER|LUMBER|FORESTRY|PAPER MILL|PULP/.test(s)) return 'Materias Primas';

  // Construcción & Real Estate
  if (/CONSTRUCTION|LUMBER|CEMENT|BUILDING|WOOD|ARCHITECT|ENGINEER.*SERV|HOME BUILD|PROPERTY|LAND DEVEL|INFRA/.test(s)) return 'Construcción';

  // Servicios
  if (/SERVICES-EDUC|SERVICES-HEALTH|SERVICES-BUSINESS|SERVICES-COMMER|REFUSE|PATENT|STAFFING|CONSULTING|OUTSOURC|ADVERTISING|MARKET.*SERV|PUBLIC RELATION|RESEARCH SERV|AUDIT|ACCOUNTING|LEGAL|LAW|NOTARY|SECURITY SERV|FACILITIES|CLEANING|WASTE|RECYCL|COURIER|POSTAL|LOGISTIC|TRANSPORT|WAREHOUSING|STORAGE SERV/.test(s)) return 'Servicios';

  // Media & Entretenimiento
  if (/ENTERTAIN|MEDIA|FILM|MOVIE|MUSIC|GAMING|CASINO|BROADCAST|PUBLISH|NEWSPAPER|MAGAZINE|CONTENT|STREAMING|SPORT|RECREATION|THEME PARK|LEISURE|HOTEL|RESORT|TRAVEL|TOURISM|AIRLINE/.test(s)) return 'Media & Ocio';

  // Cripto & Web3
  if (/CRYPTO|BITCOIN|ETHEREUM|BLOCKCHAIN|WEB3|NFT|DECENTRALI|DIGITAL ASSET/.test(s)) return 'Cripto / Fintech';

  return 'Otros';
}

function renderShortsBySector(data) {
  renderSectorBars(document.getElementById('chart-short-sector'), data, 'short');
}
function renderSectorChart(elId, data, side) {
  renderSectorBars(document.getElementById(elId), data, side);
}

function renderTopTickers(data) {
  const el = document.getElementById('chart-tickers');
  const map = {};
  data.forEach(t => {
    if (!map[t.symbol]) map[t.symbol]={wins:0,total:0,net:0};
    map[t.symbol].total++;
    if (t.resultado==='P') map[t.symbol].wins++;
    map[t.symbol].net += t.net;
  });
  const rows = Object.entries(map).sort((a,b)=>b[1].net-a[1].net).slice(0,15);
  el.innerHTML = rows.map(([sym,v]) => barRow(sym, v.wins/v.total*100, v.total, v.net, '65px')).join('');
}

// Bucket helpers
function gapBucket(t) {
  if (t.mGapPct==null) return null;
  const g=t.mGapPct;
  if(g<10) return '<10%'; if(g<25) return '10-25%'; if(g<50) return '25-50%';
  if(g<100) return '50-100%'; if(g<200) return '100-200%'; return '>200%';
}
function floatBucket(t) {
  if (t.mFloat==null) return null;
  const f=t.mFloat/1e6;
  if(f<1) return '<1M'; if(f<5) return '1-5M'; if(f<10) return '5-10M';
  if(f<20) return '10-20M'; if(f<50) return '20-50M'; return '>50M';
}
function pmvolBucket(t) {
  if (t.mPMVol==null) return null;
  const v=t.mPMVol/1e6;
  if(v<0.5) return '<500K'; if(v<2) return '500K-2M'; if(v<5) return '2-5M';
  if(v<15) return '5-15M'; if(v<50) return '15-50M'; return '>50M';
}
const BUCKET_ORDER = {
  '<10%':1,'10-25%':2,'25-50%':3,'50-100%':4,'100-200%':5,'>200%':6,
  '<1M':1,'1-5M':2,'5-10M':3,'10-20M':4,'20-50M':5,'>50M':6,
  '<500K':1,'500K-2M':2,'2-5M':3,'5-15M':4,'15-50M':5,
};

function renderMassiveChart(elId, data, bucketFn) {
  const el = document.getElementById(elId);
  const withData = data.filter(t => bucketFn(t) !== null);
  if (withData.length < 3) { el.innerHTML=`<div style="color:var(--dim);font-size:11px;padding:8px;font-family:var(--sans)">Sin datos de Massive (${withData.length}). Enriquece más trades.</div>`; return; }
  const grouped = {};
  withData.forEach(t => {
    const b=bucketFn(t);
    if(!grouped[b]) grouped[b]={wins:0,total:0,net:0};
    grouped[b].total++; if(t.resultado==='P') grouped[b].wins++; grouped[b].net+=t.net;
  });
  el.innerHTML = Object.entries(grouped)
    .sort((a,b)=>(BUCKET_ORDER[a[0]]||99)-(BUCKET_ORDER[b[0]]||99))
    .map(([bucket,v]) => barRow(bucket, v.wins/v.total*100, v.total, v.net, '80px'))
    .join('');
}

function renderOwnershipBySide(elId, data, field, side) {
  const el = document.getElementById(elId);
  const BUCKETS = ['<5%','5–15%','15–30%','30–50%','50–70%','70%+'];
  const bucket = v => {
    if (v == null) return null;
    if (v <  5)  return '<5%';
    if (v < 15)  return '5–15%';
    if (v < 30)  return '15–30%';
    if (v < 50)  return '30–50%';
    if (v < 70)  return '50–70%';
    return '70%+';
  };
  const filtered = data.filter(t => {
    const isSide = side === 'short'
      ? t.type?.toLowerCase() === 'short'
      : t.type?.toLowerCase() !== 'short';
    return isSide && t[field] != null;
  });
  if (filtered.length < 2) {
    el.innerHTML = `<div style="color:var(--dim);font-size:11px;padding:8px;font-family:var(--sans)">Sin datos suficientes (${filtered.length} trades).</div>`;
    return;
  }
  const map = {};
  BUCKETS.forEach(b => { map[b] = {wins:0, total:0, net:0}; });
  filtered.forEach(t => {
    const b = bucket(t[field]);
    if (!b) return;
    map[b].total++;
    if (t.resultado === 'P') map[b].wins++;
    map[b].net += t.net;
  });
  const rows = BUCKETS.filter(b => map[b].total > 0);
  if (!rows.length) { el.innerHTML = '<div style="color:var(--dim);font-size:11px;padding:8px;font-family:var(--sans)">Sin datos.</div>'; return; }

  el.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding-top:4px';
  el.innerHTML = rows.map(b => {
    const v   = map[b];
    const wr  = v.wins / v.total * 100;
    const col = wr >= 58 ? '#3dba6f' : wr < 45 ? '#e05252' : 'var(--text)';
    const bar = `<div style="height:100%;width:${wr}%;background:#1e9bff;border-radius:2px;opacity:0.85"></div>`;
    const net = (v.net >= 0 ? '+' : '') + fmtMoney(v.net);
    const netCol = v.net >= 0 ? 'var(--green)' : 'var(--red)';
    return `<div style="display:grid;grid-template-columns:52px 1fr 36px 28px 56px;align-items:center;gap:6px"
      title="${b} · ${v.total} trades · WR ${wr.toFixed(1)}% · ${net}">
      <span style="font-family:var(--mono);font-size:10px;color:var(--dim);text-align:right">${b}</span>
      <div style="background:rgba(255,255,255,0.06);border-radius:2px;height:6px;overflow:hidden">${bar}</div>
      <span style="font-family:var(--mono);font-size:12px;color:${col};font-weight:700;text-align:right">${wr.toFixed(0)}%</span>
      <span style="font-family:var(--sans);font-size:9px;color:var(--dim);text-align:right">${v.total}T</span>
      <span style="font-family:var(--mono);font-size:10px;color:${netCol};text-align:right">${net}</span>
    </div>`;
  }).join('');
}


function renderSessionChart(data) {
  const el = document.getElementById('chart-session');
  const groups={'Premarket 4-9:30':{wins:0,total:0,net:0},'Open 9:30-10:00':{wins:0,total:0,net:0},'Mid-day 10-14h':{wins:0,total:0,net:0},'Close 14-16h':{wins:0,total:0,net:0}};
  data.forEach(t => {
    const h=t.hora??parseInt(t.openedHour?.split(':')[0]??'0');
    const m=parseInt(t.openedHour?.split(':')[1]??'0');
    const tm=h*60+m;
    const grp=tm<9*60+30?'Premarket 4-9:30':tm<10*60?'Open 9:30-10:00':tm<14*60?'Mid-day 10-14h':'Close 14-16h';
    groups[grp].total++; if(t.resultado==='P') groups[grp].wins++; groups[grp].net+=t.net;
  });
  el.innerHTML = Object.entries(groups).filter(([,v])=>v.total>0)
    .map(([grp,v]) => barRow(grp, v.wins/v.total*100, v.total, v.net, '140px'))
    .join('');
}

function renderDayOfMonthChart(data) {
  const el = document.getElementById('chart-dom');
  const map = {};
  data.forEach(t => {
    if (!t.dateISO) return;
    const day = parseInt(t.dateISO.slice(8,10));
    if (!map[day]) map[day] = {net:0,total:0,wins:0};
    map[day].net += t.net;
    map[day].total++;
    if (t.resultado==='P') map[day].wins++;
  });
  const days = Object.entries(map).sort((a,b)=>Number(a[0])-Number(b[0]));
  if (!days.length) { el.innerHTML=''; return; }
  const maxAbs = Math.max(...days.map(d=>Math.abs(d[1].net)));

  // Use a table-like row layout instead of flex with % heights
  el.style.cssText = 'display:flex;flex-direction:column;gap:3px';
  el.innerHTML = days.map(([day, v]) => {
    const pct = Math.round(Math.abs(v.net)/maxAbs*100);
    const col = v.net>=0 ? 'var(--green)' : 'var(--red)';
    const netStr = (v.net>=0?'+':'')+fmtMoney(v.net);
    return `<div style="display:grid;grid-template-columns:22px 1fr 70px;align-items:center;gap:8px" title="${netStr} · ${v.total}T">
      <span style="font-family:var(--mono);font-size:9px;color:var(--dim);text-align:right">${day}</span>
      <div style="background:var(--bg4);border-radius:2px;height:5px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${col};border-radius:2px"></div>
      </div>
      <span style="font-family:var(--mono);font-size:9px;color:${col};text-align:right">${netStr}</span>
    </div>`;
  }).join('');
}

function renderHoldByPatron(data) {
  const el = document.getElementById('chart-hold-patron');
  const map = {};
  data.forEach(t => {
    const p = t.patron || 'Sin patrón';
    if (!map[p]) map[p] = {mins:[], net:0};
    if (t.minutos > 0) map[p].mins.push(t.minutos);
    map[p].net += t.net;
  });
  const rows = Object.entries(map)
    .filter(([,v])=>v.mins.length>0)
    .map(([p,v])=>[p, v.mins.reduce((a,b)=>a+b,0)/v.mins.length, v.mins.length, v.net])
    .sort((a,b)=>a[1]-b[1]);
  if (!rows.length) { el.innerHTML=''; return; }
  const maxMin = Math.max(...rows.map(r=>r[1]));
  el.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  el.innerHTML = rows.map(([patron, avgMin, n, net]) => {
    const col = net>=0?'var(--green)':'var(--red)';
    const hm = avgMin >= 60 ? `${Math.floor(avgMin/60)}h ${Math.round(avgMin%60)}m` : `${Math.round(avgMin)}m`;
    return `<div style="display:grid;grid-template-columns:100px 1fr 50px 36px 60px;align-items:center;gap:10px">
      <span style="font-family:var(--sans);font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${patron}</span>
      <div style="background:var(--bg4);border-radius:3px;height:9px;overflow:hidden"><div style="height:100%;width:${avgMin/maxMin*100}%;background:var(--amber);border-radius:3px"></div></div>
      <span style="font-family:var(--mono);font-size:13px;color:var(--amber);font-weight:700;text-align:right">${hm}</span>
      <span style="font-family:var(--mono);font-size:10px;color:var(--dim);text-align:right">${n}T</span>
      <span style="font-family:var(--mono);font-size:10px;color:${col};text-align:right">${(net>=0?'+':'')+fmtMoney(net)}</span>
    </div>`;
  }).join('');
}

function renderLongShortComparison(data) {
  const el = document.getElementById('chart-long-short');
  const longs  = data.filter(t => t.type?.toLowerCase() !== 'short');
  const shorts = data.filter(t => t.type?.toLowerCase() === 'short');

  const stats = (arr) => {
    if (!arr.length) return null;
    const wins   = arr.filter(t=>t.resultado==='P').length;
    const net    = arr.reduce((s,t)=>s+t.net,0);
    const gross  = arr.reduce((s,t)=>s+t.gross,0);
    const rsArr  = arr.filter(t=>t.rs!=='').map(t=>parseFloat(t.rs));
    const avgR   = rsArr.length ? rsArr.reduce((a,b)=>a+b,0)/rsArr.length : null;
    return { total:arr.length, wins, wr:(wins/arr.length*100), net, gross, avgR };
  };

  const L = stats(longs), S = stats(shorts);

  const row = (label, lVal, sVal, fmt='') => {
    const lStr = lVal != null ? (fmt==='$'?fmtMoney(lVal):fmt==='%'?lVal.toFixed(1)+'%':fmt==='R'?lVal.toFixed(2)+'R':lVal) : '—';
    const sStr = sVal != null ? (fmt==='$'?fmtMoney(sVal):fmt==='%'?sVal.toFixed(1)+'%':fmt==='R'?sVal.toFixed(2)+'R':sVal) : '—';
    return `<div style="display:grid;grid-template-columns:90px 1fr 1fr;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);align-items:center">
      <span style="font-family:var(--sans);font-size:10px;color:var(--dim)">${label}</span>
      <span style="font-family:var(--mono);font-size:11px;text-align:center">${lStr}</span>
      <span style="font-family:var(--mono);font-size:11px;text-align:center">${sStr}</span>
    </div>`;
  };

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:90px 1fr 1fr;gap:8px;padding:4px 0 8px;margin-bottom:4px">
      <span></span>
      <span style="font-family:var(--sans);font-size:9px;font-weight:700;color:var(--green);letter-spacing:.08em;text-align:center">LONGS</span>
      <span style="font-family:var(--sans);font-size:9px;font-weight:700;color:var(--red);letter-spacing:.08em;text-align:center">SHORTS</span>
    </div>
    ${row('Trades',   L?.total,  S?.total)}
    ${row('Win Rate', L?.wr,     S?.wr,     '%')}
    ${row('Net P&L',  L?.net,    S?.net,    '$')}
    ${row('Gross',    L?.gross,  S?.gross,  '$')}
    ${row('Avg R',    L?.avgR,   S?.avgR,   'R')}
  `;
}

// ═══════════════════════════════════════════════════
// 🔥 HEATMAP — Win Rate Hora × Día de la Semana
// ═══════════════════════════════════════════════════
function renderHeatmap(data) {
  const el = document.getElementById('chart-heatmap');
  if (!el) return;

  const DAYS  = ['Lun','Mar','Mié','Jue','Vie'];
  const HOURS = ['9','10','11','12','13','14','15'];
  const dayIdx = {1:0,2:1,3:2,4:3,5:4}; // getDay() → index

  // Build map: day[0-4][hour] = {wins, total}
  const map = Array.from({length:5}, () => Object.fromEntries(HOURS.map(h=>[h,{wins:0,total:0}])));
  data.forEach(t => {
    const d = new Date((t.dateISO||'') + 'T12:00:00');
    const di = dayIdx[d.getDay()];
    if (di === undefined) return;
    const h = String(t.hora ?? parseInt(t.openedHour?.split(':')[0] ?? '0'));
    if (!map[di][h]) return;
    map[di][h].total++;
    if (t.resultado === 'P') map[di][h].wins++;
  });

  // Color scale: no data = muted, 0-40% red→orange, 40-60% neutral, 60-100% green
  function cellColor(wins, total) {
    if (!total) return ['rgba(255,255,255,0.04)', 'var(--muted)'];
    const wr = wins / total;
    if (wr >= 0.65) return ['rgba(45,186,111,0.35)', '#2dba6f'];
    if (wr >= 0.55) return ['rgba(45,186,111,0.18)', '#2dba6f'];
    if (wr >= 0.45) return ['rgba(255,255,255,0.07)', 'var(--dim)'];
    if (wr >= 0.35) return ['rgba(224,82,82,0.18)', '#e05252'];
    return ['rgba(224,82,82,0.35)', '#e05252'];
  }

  let html = `<table class="hm-table"><thead><tr><th></th>${HOURS.map(h=>`<th>${h}:00</th>`).join('')}</tr></thead><tbody>`;
  DAYS.forEach((day, di) => {
    html += `<tr><td class="hm-day-label">${day}</td>`;
    HOURS.forEach(h => {
      const {wins, total} = map[di][h];
      const [bg, fg] = cellColor(wins, total);
      const pct = total ? Math.round(wins/total*100)+'%' : '—';
      const n   = total ? `<div style="font-size:9px;opacity:.6;margin-top:2px">${total}t</div>` : '';
      html += `<td><div class="hm-cell" style="background:${bg};color:${fg}">${pct}${n}</div></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';

  // Legend
  html += `<div style="display:flex;gap:12px;margin-top:10px;font-family:var(--sans);font-size:10px;color:var(--dim);align-items:center">
    <span>Leyenda:</span>
    <span style="background:rgba(45,186,111,0.35);color:#2dba6f;padding:2px 8px;border-radius:3px">≥65%</span>
    <span style="background:rgba(45,186,111,0.18);color:#2dba6f;padding:2px 8px;border-radius:3px">55-64%</span>
    <span style="background:rgba(255,255,255,0.07);color:var(--dim);padding:2px 8px;border-radius:3px">45-54%</span>
    <span style="background:rgba(224,82,82,0.18);color:#e05252;padding:2px 8px;border-radius:3px">35-44%</span>
    <span style="background:rgba(224,82,82,0.35);color:#e05252;padding:2px 8px;border-radius:3px">&lt;35%</span>
    <span style="background:rgba(255,255,255,0.04);color:var(--muted);padding:2px 8px;border-radius:3px">Sin datos</span>
  </div>`;
  el.innerHTML = html;
}

// ═══════════════════════════════════════════════════
// 📐 GAP% vs RESULTADO — Scatter
// ═══════════════════════════════════════════════════
let _gapChart = null;
function renderGapScatter(data) {
  const withGap = data.filter(t => t.mGapPct != null);
  const canvas  = document.getElementById('chart-gap-scatter');
  if (!canvas) return;
  if (_gapChart) { _gapChart.destroy(); _gapChart = null; }
  if (!withGap.length) { canvas.parentNode.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:20px">Sin datos de Gap% (requiere Massive)</div>'; return; }

  // Remove extreme outliers: use 5th–95th percentile of gap% for axis range
  const sorted  = [...withGap].sort((a,b) => a.mGapPct - b.mGapPct);
  const p05     = sorted[Math.floor(sorted.length * 0.05)]?.mGapPct ?? -50;
  const p95     = sorted[Math.floor(sorted.length * 0.95)]?.mGapPct ?? 500;
  const pad     = (p95 - p05) * 0.1 || 10;
  const xMin    = Math.floor(p05 - pad);
  const xMax    = Math.ceil(p95 + pad);

  // Mark outliers separately (outside range)
  const inRange  = withGap.filter(t => t.mGapPct >= xMin && t.mGapPct <= xMax);
  const outliers = withGap.filter(t => t.mGapPct < xMin || t.mGapPct > xMax);

  const wins   = inRange.filter(t => t.resultado === 'P');
  const losses = inRange.filter(t => t.resultado !== 'P');

  _gapChart = new Chart(canvas.getContext('2d'), {
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Win',  data: wins.map(t  => ({x: t.mGapPct, y: t.net, t})),
          backgroundColor: 'rgba(45,186,111,0.65)', pointRadius: 4, pointHoverRadius: 7 },
        { label: 'Loss', data: losses.map(t => ({x: t.mGapPct, y: t.net, t})),
          backgroundColor: 'rgba(224,82,82,0.65)',  pointRadius: 4, pointHoverRadius: 7 },
        ...(outliers.length ? [{ label: `Outliers (${outliers.length})`,
          data: [], backgroundColor: 'transparent' }] : []),
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#888', font: { family: 'DM Mono', size: 10 },
          filter: item => item.text !== `Outliers (${outliers.length})` || outliers.length > 0 } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const t = ctx.raw.t;
              return [`${t.symbol} ${t.dateISO}`, `Gap: ${t.mGapPct.toFixed(1)}%`, `Net: $${t.net.toFixed(2)}`];
            }
          }
        }
      },
      scales: {
        x: {
          min: xMin, max: xMax,
          title: { display: true, text: 'Gap% apertura', color: '#555', font: { size: 10 } },
          grid:  { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#666', font: { family: 'DM Mono', size: 9 },
            callback: v => v + '%' }
        },
        y: {
          title: { display: true, text: 'Net P&L ($)', color: '#555', font: { size: 10 } },
          grid:  { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#666', font: { family: 'DM Mono', size: 9 },
            callback: v => '$' + v }
        }
      }
    }
  });

  // Show outlier note if any
  if (outliers.length) {
    const note = document.createElement('div');
    note.style.cssText = 'font-size:10px;color:var(--muted);font-family:var(--sans);padding:4px 0 0';
    note.textContent = `${outliers.length} outlier${outliers.length>1?'s':''} excluido${outliers.length>1?'s':''} del eje (Gap% > ${xMax.toFixed(0)}%): ${outliers.map(t=>t.symbol).join(', ')}`;
    canvas.parentNode.appendChild(note);
  }
}

// ═══════════════════════════════════════════════════
// 📦 P&L POR TAMAÑO DE POSICIÓN — Scatter
// ═══════════════════════════════════════════════════
let _sizeChart = null;
function renderSizeScatter(data) {
  const withQty = data.filter(t => t.qty > 0);
  const canvas  = document.getElementById('chart-size-scatter');
  if (!canvas) return;
  if (_sizeChart) { _sizeChart.destroy(); _sizeChart = null; }
  if (!withQty.length) { canvas.parentNode.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:20px">Sin datos de shares</div>'; return; }

  // Bucket shares into groups for color coding
  const allQty = withQty.map(t => t.qty);
  const q33    = allQty.sort((a,b)=>a-b)[Math.floor(allQty.length*0.33)];
  const q66    = allQty[Math.floor(allQty.length*0.66)];

  function getColor(qty) {
    if (qty <= q33) return 'rgba(100,160,255,0.65)';   // pequeño: azul
    if (qty <= q66) return 'rgba(232,160,32,0.65)';   // medio: amber
    return 'rgba(180,100,255,0.65)';                   // grande: morado
  }

  // Also group by size bucket and compute avg R
  const buckets = { pequeño: {rs:[], net:[]}, medio: {rs:[], net:[]}, grande: {rs:[], net:[]} };
  withQty.forEach(t => {
    const b = t.qty <= q33 ? 'pequeño' : t.qty <= q66 ? 'medio' : 'grande';
    buckets[b].net.push(t.net);
    if (t.rs !== '') buckets[b].rs.push(parseFloat(t.rs));
  });

  _sizeChart = new Chart(canvas.getContext('2d'), {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Trades',
        data: withQty.map(t => ({ x: t.qty, y: t.net, t })),
        backgroundColor: withQty.map(t => getColor(t.qty)),
        pointRadius: 4, pointHoverRadius: 6,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const t = ctx.raw.t;
              const r = t.rs !== '' ? ` · ${t.rs}R` : '';
              return [`${t.symbol} ${t.dateISO}`, `Shares: ${t.qty}`, `Net: $${t.net.toFixed(2)}${r}`];
            }
          }
        }
      },
      scales: {
        x: { title: { display: true, text: 'Shares', color: '#555' },
             grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#555', font: { family: 'DM Mono', size: 9 } } },
        y: { title: { display: true, text: 'Net P&L ($)', color: '#555' },
             grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#555', font: { family: 'DM Mono', size: 9 },
             callback: v => '$'+v } }
      }
    }
  });

  // Summary below chart
  // Append stats BELOW the chart-wrap, inside the a-card parent
  const chartWrap = canvas.parentNode;
  const card = chartWrap.parentNode;
  const oldSub = card.querySelector('.size-scatter-summary');
  if (oldSub) oldSub.remove();

  const rows = Object.entries(buckets).map(([label, d]) => {
    if (!d.net.length) return '';
    const avg = d.net.reduce((a,b)=>a+b,0)/d.net.length;
    const wr  = d.net.filter(n=>n>0).length / d.net.length * 100;
    const avgR= d.rs.length ? (d.rs.reduce((a,b)=>a+b,0)/d.rs.length).toFixed(2) : '—';
    const col = avg >= 0 ? 'var(--green)' : 'var(--red)';
    return `<span style="font-size:10px;font-family:var(--mono);color:var(--dim);margin-right:16px">
      <b style="color:var(--text)">${label}</b> · Avg $<span style="color:${col}">${avg.toFixed(2)}</span> · WR ${wr.toFixed(0)}% · AvgR ${avgR}
    </span>`;
  }).join('');
  const sub = document.createElement('div');
  sub.className = 'size-scatter-summary';
  sub.style.cssText = 'padding:8px 0 0;display:flex;flex-direction:column;gap:4px';
  sub.innerHTML = `<div style="font-size:10px;color:var(--dim);font-family:var(--sans)">
    🔵 Pequeño (&lt;${q33}sh) · 🟡 Medio (${q33}–${q66}sh) · 🟣 Grande (&gt;${q66}sh)
  </div><div style="display:flex;flex-wrap:wrap;gap:4px">${rows}</div>`;
  card.appendChild(sub);
}

function renderMFEMAE(data) {
  const el = document.getElementById('chart-mfe-mae');
  const withMFE = data.filter(t => t.mMFE != null);
  if (withMFE.length < 5) {
    el.innerHTML = `<div style="color:var(--dim);font-size:12px;padding:12px;font-family:var(--sans)">
      Sin datos de MFE/MAE (${withMFE.length} trades). Re-enriquece trades con Massive para calcularlos.
      <span style="color:#1e9bff;margin-left:8px">Se añade automáticamente durante el enriquecimiento.</span>
    </div>`; return;
  }

  const longs  = withMFE.filter(t => t.type?.toLowerCase() !== 'short');
  const shorts = withMFE.filter(t => t.type?.toLowerCase() === 'short');
  const wins   = withMFE.filter(t => t.resultado === 'P');
  const losses = withMFE.filter(t => t.resultado !== 'P');

  const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
  const pct = v => v != null ? v.toFixed(2)+'%' : '—';
  const fmt2 = v => v != null ? v.toFixed(1)+'%' : '—';

  // ── KPI strip ──
  const avgMFE       = avg(withMFE.map(t=>t.mMFE));
  const avgMAE       = avg(withMFE.map(t=>t.mMAE));
  const avgCapture   = avg(withMFE.filter(t=>t.mCapture!=null&&t.mCapture<=200).map(t=>t.mCapture));
  const avgMFEwins   = avg(wins.filter(t=>t.mMFE!=null).map(t=>t.mMFE));
  const avgMAEwins   = avg(wins.filter(t=>t.mMAE!=null).map(t=>t.mMAE));
  const avgMFElosses = avg(losses.filter(t=>t.mMFE!=null).map(t=>t.mMFE));
  const avgMAElosses = avg(losses.filter(t=>t.mMAE!=null).map(t=>t.mMAE));
  const avgMFElong   = avg(longs.map(t=>t.mMFE));
  const avgMFEshort  = avg(shorts.map(t=>t.mMFE));
  const avgMAElong   = avg(longs.map(t=>t.mMAE));
  const avgMAEshort  = avg(shorts.map(t=>t.mMAE));

  const kpi = (label, val, col='var(--text)', sub='') =>
    `<div style="background:var(--bg3);border-radius:8px;padding:12px 16px;display:flex;flex-direction:column;gap:4px">
      <span style="font-size:10px;color:var(--dim);font-family:var(--sans);font-weight:700;text-transform:uppercase;letter-spacing:.05em">${label}</span>
      <span style="font-size:20px;font-family:var(--mono);color:${col};font-weight:700">${val}</span>
      ${sub ? `<span style="font-size:10px;color:var(--dim);font-family:var(--sans)">${sub}</span>` : ''}
    </div>`;

  // ── Capture rate distribution ──
  const capBuckets = {'<25%':0,'25–50%':0,'50–75%':0,'75–100%':0,'>100%':0};
  withMFE.filter(t=>t.mCapture!=null).forEach(t => {
    const c = t.mCapture;
    if (c < 25) capBuckets['<25%']++;
    else if (c < 50) capBuckets['25–50%']++;
    else if (c < 75) capBuckets['50–75%']++;
    else if (c <= 100) capBuckets['75–100%']++;
    else capBuckets['>100%']++;
  });
  const capTotal = Object.values(capBuckets).reduce((a,b)=>a+b,0);
  const capRows = Object.entries(capBuckets).filter(([,n])=>n>0).map(([label,n]) => {
    const pctBar = capTotal ? n/capTotal*100 : 0;
    const col = label === '75–100%' || label === '>100%' ? '#3dba6f' : label === '<25%' ? '#e05252' : '#1e9bff';
    return `<div style="display:grid;grid-template-columns:70px 1fr 36px 36px;align-items:center;gap:8px">
      <span style="font-family:var(--mono);font-size:10px;color:var(--dim);text-align:right">${label}</span>
      <div style="background:rgba(255,255,255,0.06);border-radius:2px;height:6px;overflow:hidden">
        <div style="height:100%;width:${pctBar}%;background:${col};border-radius:2px"></div></div>
      <span style="font-family:var(--mono);font-size:11px;color:${col};font-weight:700;text-align:right">${n}</span>
      <span style="font-family:var(--sans);font-size:9px;color:var(--dim);text-align:right">${pctBar.toFixed(0)}%</span>
    </div>`;
  }).join('');

  // ── MFE by pattern ──
  const patMap = {};
  withMFE.forEach(t => {
    const p = t.patron || 'Sin patrón';
    if (!patMap[p]) patMap[p] = {mfe:[],mae:[],cap:[]};
    patMap[p].mfe.push(t.mMFE);
    patMap[p].mae.push(t.mMAE);
    if (t.mCapture != null && t.mCapture <= 200) patMap[p].cap.push(t.mCapture);
  });
  const patRows = Object.entries(patMap)
    .filter(([,v]) => v.mfe.length >= 2)
    .map(([p,v]) => ({
      p,
      avgMFE: avg(v.mfe),
      avgMAE: avg(v.mae),
      avgCap: avg(v.cap),
      n: v.mfe.length
    }))
    .sort((a,b) => b.avgMFE - a.avgMFE);
  const maxPatMFE = Math.max(...patRows.map(r=>r.avgMFE), 0.01);
  const patHtml = patRows.map(r => {
    const capCol = r.avgCap == null ? 'var(--dim)' : r.avgCap >= 70 ? '#3dba6f' : r.avgCap < 40 ? '#e05252' : 'var(--text)';
    return `<div style="display:grid;grid-template-columns:110px 1fr 52px 52px 52px 28px;align-items:center;gap:8px"
      title="${r.p} · MFE avg ${r.avgMFE.toFixed(2)}% · MAE avg ${r.avgMAE.toFixed(2)}% · Capture ${r.avgCap!=null?r.avgCap.toFixed(0)+'%':'—'}">
      <span style="font-family:var(--sans);font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.p}</span>
      <div style="background:rgba(255,255,255,0.06);border-radius:2px;height:6px;overflow:hidden">
        <div style="height:100%;width:${r.avgMFE/maxPatMFE*100}%;background:#3dba6f;border-radius:2px;opacity:0.8"></div></div>
      <span style="font-family:var(--mono);font-size:11px;color:#3dba6f;font-weight:700;text-align:right">${r.avgMFE.toFixed(2)}%</span>
      <span style="font-family:var(--mono);font-size:11px;color:#e05252;text-align:right">${r.avgMAE.toFixed(2)}%</span>
      <span style="font-family:var(--mono);font-size:11px;color:${capCol};font-weight:700;text-align:right">${r.avgCap!=null?r.avgCap.toFixed(0)+'%':'—'}</span>
      <span style="font-family:var(--sans);font-size:9px;color:var(--dim);text-align:right">${r.n}T</span>
    </div>`;
  }).join('');

  el.innerHTML = `
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px">
    ${kpi('Avg MFE', pct(avgMFE), '#3dba6f', `máx favorable desde entry`)}
    ${kpi('Avg MAE', pct(avgMAE), '#e05252', `máx adverso desde entry`)}
    ${kpi('Capture Rate', fmt2(avgCapture), '#1e9bff', `% del MFE capturado (${withMFE.filter(t=>t.mCapture!=null).length}T)`)}
    ${kpi('Trades', withMFE.length+'', 'var(--text)', `de ${data.length} totales con MFE/MAE`)}
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">

    <!-- Ganadores vs Perdedores -->
    <div>
      <div style="font-size:10px;font-weight:800;color:#b0b8c8;font-family:var(--sans);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;display:flex;gap:8px;align-items:center">
        <div style="width:3px;height:14px;background:#1e9bff;border-radius:2px"></div>
        Ganadores vs Perdedores
      </div>
      <div style="display:grid;grid-template-columns:80px 1fr 1fr;gap:6px;align-items:center">
        <span></span>
        <span style="font-size:9px;color:#3dba6f;font-family:var(--sans);font-weight:700;text-align:center">MFE avg</span>
        <span style="font-size:9px;color:#e05252;font-family:var(--sans);font-weight:700;text-align:center">MAE avg</span>
        <span style="font-size:11px;color:#3dba6f;font-family:var(--sans)">✓ Ganadores (${wins.length})</span>
        <span style="font-family:var(--mono);font-size:13px;color:#3dba6f;font-weight:700;text-align:center">${pct(avgMFEwins)}</span>
        <span style="font-family:var(--mono);font-size:13px;color:#e05252;text-align:center">${pct(avgMAEwins)}</span>
        <span style="font-size:11px;color:#e05252;font-family:var(--sans)">✗ Perdedores (${losses.length})</span>
        <span style="font-family:var(--mono);font-size:13px;color:#3dba6f;font-weight:700;text-align:center">${pct(avgMFElosses)}</span>
        <span style="font-family:var(--mono);font-size:13px;color:#e05252;text-align:center">${pct(avgMAElosses)}</span>
        <span style="font-size:10px;color:var(--dim);font-family:var(--sans)">Long (${longs.length})</span>
        <span style="font-family:var(--mono);font-size:12px;color:#3dba6f;text-align:center">${pct(avgMFElong)}</span>
        <span style="font-family:var(--mono);font-size:12px;color:#e05252;text-align:center">${pct(avgMAElong)}</span>
        <span style="font-size:10px;color:var(--dim);font-family:var(--sans)">Short (${shorts.length})</span>
        <span style="font-family:var(--mono);font-size:12px;color:#3dba6f;text-align:center">${pct(avgMFEshort)}</span>
        <span style="font-family:var(--mono);font-size:12px;color:#e05252;text-align:center">${pct(avgMAEshort)}</span>
      </div>
    </div>

    <!-- Capture Rate distribution -->
    <div>
      <div style="font-size:10px;font-weight:800;color:#b0b8c8;font-family:var(--sans);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;display:flex;gap:8px;align-items:center">
        <div style="width:3px;height:14px;background:#1e9bff;border-radius:2px"></div>
        Capture Rate <span style="font-size:9px;color:var(--dim);font-weight:400;text-transform:none">recorrido / MFE</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">${capRows}</div>
    </div>

    <!-- MFE/MAE por patrón -->
    <div>
      <div style="font-size:10px;font-weight:800;color:#b0b8c8;font-family:var(--sans);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;display:flex;gap:8px;align-items:center">
        <div style="width:3px;height:14px;background:#1e9bff;border-radius:2px"></div>
        MFE / MAE / Capture por Patrón
      </div>
      <div style="display:grid;grid-template-columns:110px 1fr 52px 52px 52px 28px;gap:4px;margin-bottom:6px">
        <span></span><span></span>
        <span style="font-size:9px;color:#3dba6f;font-family:var(--sans);font-weight:700;text-align:right">MFE</span>
        <span style="font-size:9px;color:#e05252;font-family:var(--sans);font-weight:700;text-align:right">MAE</span>
        <span style="font-size:9px;color:#1e9bff;font-family:var(--sans);font-weight:700;text-align:right">CAP%</span>
        <span></span>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">${patHtml || '<span style="color:var(--dim);font-size:11px;font-family:var(--sans)">Sin patrones con ≥2 trades</span>'}</div>
    </div>

  </div>`;
}

function renderMonthly(data) {
  const map = {};
  data.forEach(t => {
    const key = t.mes + ' ' + (t.fecha ? t.fecha.slice(-4) : '');
    if (!map[key]) map[key] = {trades:0,wins:0,gross:0,comm:0,net:0,rs:[]};
    map[key].trades++;
    if (t.resultado==='P') map[key].wins++;
    map[key].gross += t.gross;
    map[key].comm  += t.totalComm;
    map[key].net   += t.net;
    if (t.rs!=='') map[key].rs.push(parseFloat(t.rs));
  });

  const tbody = document.getElementById('monthly-body');
  const rows  = Object.entries(map);

  tbody.innerHTML = rows.map(([mes, v]) => {
    const wr   = (v.wins/v.trades*100).toFixed(1)+'%';
    const avgR = v.rs.length ? (v.rs.reduce((a,b)=>a+b,0)/v.rs.length).toFixed(2) : '—';
    return `<tr>
      <td>${mes}</td>
      <td>${v.trades}</td>
      <td>${v.wins}</td>
      <td>${wr}</td>
      <td style="color:${v.gross>=0?'var(--green)':'var(--red)'}">${fmtMoney(v.gross)}</td>
      <td style="color:var(--dim)">(${fmtMoney(v.comm)})</td>
      <td style="color:${v.net>=0?'var(--green)':'var(--red)'}"><strong>${fmtMoney(v.net)}</strong></td>
      <td style="color:${avgR>=0?'var(--green)':'var(--red)'}">${avgR}${avgR!=='—'?'R':''}</td>
    </tr>`;
  }).join('');

  // Totals row
  const tot = rows.reduce((acc,[,v])=>({
    trades:acc.trades+v.trades, wins:acc.wins+v.wins,
    gross:acc.gross+v.gross, comm:acc.comm+v.comm, net:acc.net+v.net,
    rs:[...acc.rs,...v.rs]
  }), {trades:0,wins:0,gross:0,comm:0,net:0,rs:[]});
  const tAvgR = tot.rs.length ? (tot.rs.reduce((a,b)=>a+b,0)/tot.rs.length).toFixed(2) : '—';
  tbody.innerHTML += `<tr style="border-top:2px solid var(--border2)">
    <td>TOTAL</td>
    <td>${tot.trades}</td>
    <td>${tot.wins}</td>
    <td>${(tot.wins/tot.trades*100).toFixed(1)}%</td>
    <td style="color:${tot.gross>=0?'var(--green)':'var(--red)'}">${fmtMoney(tot.gross)}</td>
    <td style="color:var(--dim)">(${fmtMoney(tot.comm)})</td>
    <td style="color:${tot.net>=0?'var(--green)':'var(--red)'}">${fmtMoney(tot.net)}</td>
    <td style="color:${tAvgR>=0?'var(--green)':'var(--red)'}">${tAvgR}${tAvgR!=='—'?'R':''}</td>
  </tr>`;
}

// ═══════════════════════════════
// SETTINGS
// ═══════════════════════════════
function renderSettings() {
  document.getElementById('cfg-total').textContent = trades.length + ' trades';
  if (trades.length) {
    const dates = trades.map(t=>t.dateISO).filter(Boolean).sort();
    document.getElementById('cfg-range').textContent = dates[0] + ' → ' + dates[dates.length-1];
  } else {
    document.getElementById('cfg-range').textContent = '—';
  }
  document.getElementById('cfg-last').textContent  = lastImport || '—';
  try {
    const kb = (JSON.stringify(trades).length / 1024).toFixed(1);
    const mb = (JSON.stringify(trades).length / 1024 / 1024).toFixed(2);
    document.getElementById('cfg-size').textContent = kb > 1000 ? mb + ' MB' : kb + ' KB';
  } catch(e) {}
  document.getElementById('cfg-patterns').textContent = PATTERNS.filter(p=>p).join(', ');
  document.getElementById('patterns-textarea').value = PATTERNS.filter(p=>p).join('\n');
}

function savePatterns() {
  const raw = document.getElementById('patterns-textarea').value;
  PATTERNS  = ['', ...raw.split('\n').map(p => p.trim()).filter(Boolean)];
  save();
  // Re-render the trades table so all patron/confirm dropdowns pick up the new list
  renderTable();
  renderSettings();
  toast('Patrones guardados ✓', 'ok');
}

function showDangerConfirm() {
  const el = document.getElementById('danger-confirm');
  const visible = getComputedStyle(el).display !== 'none';
  el.style.display = visible ? 'none' : 'block';
  document.getElementById('danger-input').value = '';
  document.getElementById('danger-btn').disabled = true;
}

function checkDangerInput() {
  const val = document.getElementById('danger-input').value;
  document.getElementById('danger-btn').disabled = val !== 'BORRAR';
}

async function clearAll() {
  try { await fetch('/api/trades', { method: 'DELETE' }); } catch(e) {}
  trades = []; displayed = []; lastImport = null;
  await save();
  document.getElementById('danger-confirm').style.display = 'none';
  document.getElementById('danger-input').value = '';
  renderAll();
  renderSettings();
  toast('Todos los datos eliminados', 'info');
}

// ═══════════════════════════════
// EXPORT / IMPORT JSON
// ═══════════════════════════════
function exportJSON() {
  const data = {
    version: 2,
    exported: new Date().toISOString(),
    trades: trades,
    meta: { lastImport, patterns: PATTERNS }
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'trading-journal-backup-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  toast('Backup exportado (' + trades.length + ' trades)', 'ok');
}

function importJSON(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.trades || !Array.isArray(data.trades)) throw new Error('Formato inválido');
      trades = data.trades;
      migrateDateISO();
      if (data.meta) {
        if (data.meta.lastImport) lastImport = data.meta.lastImport;
        if (data.meta.patterns)   PATTERNS   = data.meta.patterns;
      }
      save();
      renderAll();
      renderSettings();
      toast(trades.length + ' trades restaurados desde backup', 'ok');
    } catch(err) {
      toast('Error al leer el JSON: ' + err.message, 'err');
    }
    input.value = '';
  };
  reader.readAsText(file);
}

// ═══════════════════════════════
// EXPORT CSV
// ═══════════════════════════════
function exportCSV() {
  const headers = ['Opened','Closed','Held','Symbol','Type','Entry','Exit','Qty',
    'Gross','Comm','Ecn Fee','SEC','TAF','NSCC','Clr','CAT','Misc','Net',
    'Fecha','Opened Hour','Mes','Hora','Cierre','Día','Precio','Recorrido',
    'Resultado','Hold','Total Comm','Minutos','Riesgo',"R's",'Patrón',
    'Confirmación','Noticia','Float(M)','Institucional(%)','Insiders(%)'];
  const rows = trades.map((t,i) => [
    t.opened,t.closed,t.held,t.symbol,t.type,t.entry,t.exit,t.qty,
    t.gross,t.comm,t.ecnFee,t.sec,t.taf,t.nscc,t.clr,t.cat,t.misc,t.net,
    t.fecha,t.openedHour,t.mes,t.hora,t.cierreH,t.dia,t.precio,
    (t.recorrido*100).toFixed(4)+'%',t.resultado,t.hold,t.totalComm,t.minutos,
    t.riesgo,t.rs,t.patron,t.confirm,t.noticia,t.float,t.instit,t.insiders
  ]);
  const csv = [headers,...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download = 'trading_journal_'+new Date().toISOString().slice(0,10)+'.csv';
  a.click();
  toast('CSV exportado', 'ok');
}

// ═══════════════════════════════
// UTILS
// ═══════════════════════════════
function parseNum(v) { if(v===''||v==null)return 0; const s=String(v).replace(/[,\s]/g,'').replace('(','-').replace(')',''); return parseFloat(s)||0; }
function fmtMoney(n) { const a=Math.abs(n).toFixed(2); return n<0?'('+a+')':a; }
function fmtN(n,d) { return typeof n==='number'?n.toFixed(d):'—'; }
function pad(n) { return String(n).padStart(2,'0'); }
function secToHMS(s) { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60; return pad(h)+':'+pad(m)+':'+pad(sc); }
function excelDateToJS(serial) { return new Date((serial-25569)*86400000); }

function toast(msg, type='info') {
  const wrap = document.getElementById('toasts');
  const el   = document.createElement('div');
  el.className = 'toast '+type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(()=>el.remove(), 3000);
}


// ═══════════════════════════════
// CALENDARIO
// ═══════════════════════════════
let calYear  = new Date().getFullYear();
let calMonth = new Date().getMonth(); // 0-indexed
let calMode  = 'dollar'; // 'dollar' | 'rs'
let calChart = null;

const MONTH_NAMES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function setCalMode(mode) {
  calMode = mode;
  document.getElementById('mode-dollar').classList.toggle('active', mode==='dollar');
  document.getElementById('mode-rs').classList.toggle('active', mode==='rs');
  renderCalendario();
}
function calPrev() { calMonth--; if(calMonth<0){calMonth=11;calYear--;} renderCalendario(); }
function calNext() { calMonth++; if(calMonth>11){calMonth=0;calYear++;} renderCalendario(); }

function renderCalendario() {
  document.getElementById('cal-month-label').textContent = MONTH_NAMES_ES[calMonth] + ' ' + calYear;

  // Build day map for this month — include DAS preview trades
  const dayMap = {};
  const allCalTrades = [...trades, ...dasPreview];
  allCalTrades.forEach(t => {
    if (!t.dateISO) return;
    const [y,m] = t.dateISO.split('-').map(Number);
    if (y !== calYear || m-1 !== calMonth) return;
    const d = t.dateISO;
    if (!dayMap[d]) dayMap[d] = { net:0, gross:0, rs:0, rsCount:0, trades:0, wins:0, hasPreview:false };
    dayMap[d].net   += t.net || 0;
    const g = typeof t.gross === 'number' ? t.gross : (t.net || 0);
    dayMap[d].gross += g;
    dayMap[d].trades++;
    if (t.resultado==='P') dayMap[d].wins++;
    // Compute R inline from riesgo+gross — never trust stale t.rs string
    const risk = parseFloat(t.riesgo);
    if (t.riesgo && !isNaN(risk) && risk !== 0) {
      dayMap[d].rs += g / risk;
      dayMap[d].rsCount++;
    }
    if (t.isPreview) dayMap[d].hasPreview = true;
  });

  // Month strip summary
  const allDays = Object.values(dayMap);
  const mTrades = allDays.reduce((s,d)=>s+d.trades,0);
  const mWins   = allDays.reduce((s,d)=>s+d.wins,0);
  const mNet    = allDays.reduce((s,d)=>s+d.net,0);
  const mGross  = allDays.reduce((s,d)=>s+d.gross,0);
  const mRs     = allDays.reduce((s,d)=>s+d.rs,0);
  const mDays   = allDays.length;
  const mWinDays= allDays.filter(d=>(calMode==='rs'?d.rs:d.net)>0).length;

  const mRsCount = allDays.reduce((s,d)=>s+(d.rsCount||0),0);
  const mRsLabel = mRsCount < mTrades
    ? `${mRs.toFixed(2)}R <span style="font-size:10px;color:var(--amber)" title="${mTrades-mRsCount} trades sin Riesgo">⚠${mRsCount}/${mTrades}</span>`
    : `${mRs.toFixed(2)}R`;

  document.getElementById('cal-strip').innerHTML = [
    {label:'Días operados', val:mDays, cls:'neutral'},
    {label:'D\u00edas ganadores', val: mDays ? mWinDays+'/'+mDays : '0/0', cls: mDays && mWinDays/mDays>=0.5 ? 'pos':'neg'},
    {label:'Win rate trades', val: mTrades ? (mWins/mTrades*100).toFixed(1)+'%':'—', cls:'amber'},
    {label:'Net P&L', val:'$'+mNet.toFixed(2), cls:mNet>=0?'pos':'neg'},
    {label:"R's totales", val:mRsLabel, cls:mRs>=0?'pos':'neg', raw:true},
    {label:'Total trades', val:mTrades, cls:'neutral'},
  ].map(s=>`<div class="cal-strip-card"><div class="sc-label">${s.label}</div><div class="sc-val ${s.cls}">${s.raw?s.val:s.val}</div></div>`).join('');

  // Calendar grid — 6 cols: Mon–Fri + Semana total
  // Sat/Sun are invisible: their trades go into the week bucket, no cell rendered
  const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
  const today = new Date();
  const todayISO = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  // Helper: day-of-week Mon=0 … Sun=6
  const dowMon = d => { const w = new Date(calYear, calMonth, d).getDay(); return w === 0 ? 6 : w - 1; };

  // Find first Monday <= 1 (i.e. how many empty Mon-Fri slots before day 1)
  const d1dow = dowMon(1); // 0=Mon … 6=Sun
  // If month starts on Sat(5) or Sun(6) there are no empty slots in the first visible row
  const leadEmpty = d1dow <= 4 ? d1dow : 0;

  // Build weeks: array of { slots: [{d,iso,data} or null] x5, net, rs, trades, wins }
  const weeks = [];
  let week = { slots: Array(leadEmpty).fill(null), net:0, rs:0, trades:0, wins:0, rsCount:0 };

  // Days 1…N that fall on Sat/Sun before day 1 of first visible week don't exist,
  // but we may have Mon start days already in leadEmpty. Process each day:
  for (let d = 1; d <= daysInMonth; d++) {
    const iso  = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const data = dayMap[iso];
    const dow  = dowMon(d);

    // Accumulate to week totals regardless of Sat/Sun
    if (data) {
      week.net    += data.net;
      week.rs     += data.rs;
      week.rsCount+= data.rsCount || 0;
      week.trades += data.trades;
      week.wins   += data.wins;
    }

    if (dow <= 4) {
      // Weekday → add slot
      week.slots.push({ d, iso, data });
      // Friday or last day → close week
      if (dow === 4 || d === daysInMonth) {
        // Pad to 5 slots
        while (week.slots.length < 5) week.slots.push(null);
        weeks.push(week);
        week = { slots: [], net:0, rs:0, trades:0, wins:0, rsCount:0 };
      }
    } else {
      // Weekend: on Sunday close the week if it has any slots started
      if (dow === 6 && week.slots.length > 0) {
        while (week.slots.length < 5) week.slots.push(null);
        weeks.push(week);
        week = { slots: [], net:0, rs:0, trades:0, wins:0, rsCount:0 };
      }
    }
  }
  // Flush remaining partial week
  if (week.slots.length > 0) {
    while (week.slots.length < 5) week.slots.push(null);
    weeks.push(week);
  }

  // Render
  let cells = '';
  weeks.forEach(wk => {
    // 5 day cells
    wk.slots.forEach(slot => {
      if (!slot) { cells += '<div class="cal-day empty"></div>'; return; }
      const { d, iso, data } = slot;
      const val = data ? (calMode==='rs' ? data.rs : data.net) : null;
      const cls = ['cal-day', data?'has-data':'', iso===todayISO?'today':'',
        val!==null&&val>0?'win-day':'', val!==null&&val<0?'loss-day':'',
        dayNotes[iso]?'has-note':'',
        data?.hasPreview?'preview-day':''].filter(Boolean).join(' ');
      let inner = `<div class="cal-day-num">${d}</div>`;
      if (data && val !== null) {
        const sign = val>0?'+':'';
        const pc   = val>0?'pos':val<0?'neg':'';
        inner += `<div class="cal-day-pnl ${pc}">${calMode==='dollar'?(val>=0?'+$':'-$')+Math.abs(val).toFixed(2):sign+val.toFixed(2)+'R'}</div>`;
        inner += `<div class="cal-day-meta">${data.wins}W / ${data.trades-data.wins}L</div>`;
        inner += `<div class="cal-day-trades">${data.trades} trade${data.trades!==1?'s':''}${data.hasPreview?' 👁':''}</div>`;
        // Show secondary metric only as small subtitle
        if (calMode==='dollar' && data.rsCount > 0) {
          const rSign = data.rs >= 0 ? '+' : '';
          inner += `<div style="font-size:9px;color:var(--dim);font-family:var(--mono)">${rSign}${data.rs.toFixed(2)}R</div>`;
        } else if (calMode==='rs') {
          inner += `<div style="font-size:9px;color:var(--dim);font-family:var(--mono)">${data.net>=0?'+$':'-$'}${Math.abs(data.net).toFixed(2)}</div>`;
        }
      }
      const clickAttr = data ? `onclick="openJournal('${iso}')"` : '';
      cells += `<div class="${cls}" ${clickAttr}>${inner}</div>`;
    });

    // Semana total cell
    const wVal    = calMode==='rs' ? wk.rs : wk.net;
    const wNetStr = (wk.net>=0?'+$':'-$')+Math.abs(wk.net).toFixed(2);
    const wRsStr  = wk.rsCount > 0 ? (wk.rs>=0?'+':'')+wk.rs.toFixed(2)+'R' : '—';
    const wWrStr  = wk.trades ? (wk.wins/wk.trades*100).toFixed(0)+'%' : '—';
    const bgCls   = wk.trades===0?'':wVal>0?'pos-week':'neg-week';
    const valCls  = wVal>0?'pos':wVal<0?'neg':'';
    // Show warning if not all trades have riesgo assigned
    const missingR = wk.trades - wk.rsCount;
    const rsWarning = (calMode==='rs' && missingR > 0)
      ? `<span title="${missingR} trade(s) sin Riesgo asignado — R's parciales" style="font-size:9px;color:var(--amber);font-family:var(--sans);margin-top:2px;display:block">⚠ ${wk.rsCount}/${wk.trades} con R</span>`
      : '';
    cells += `<div class="cal-week-cell ${bgCls}">
      ${wk.trades===0 ? '' : `
        <span class="wc-label">Semana</span>
        <span class="wc-pnl ${valCls}">${calMode==='dollar'?wNetStr:wRsStr}</span>
        <span class="wc-meta">${wk.trades}t · ${wWrStr}</span>
        ${rsWarning}
      `}
    </div>`;
  });

  document.getElementById('cal-days').innerHTML = cells;

  // Line chart: cumulative by trading day this month
  const sortedDays = Object.entries(dayMap).sort(([a],[b])=>a.localeCompare(b));
  const labels = sortedDays.map(([iso]) => {
    const d = new Date(iso+'T00:00:00');
    return d.getDate()+'/'+(d.getMonth()+1);
  });
  let cum = 0;
  const cumData = sortedDays.map(([,d]) => {
    cum += calMode==='rs' ? d.rs : d.net;
    return parseFloat(cum.toFixed(2));
  });

  if (calChart) calChart.destroy();
  if (!sortedDays.length) return;

  const lastVal = cumData[cumData.length-1] || 0;
  const lineColor = lastVal >= 0 ? '#3dba6f' : '#e05252';
  const ctx = document.getElementById('cal-chart').getContext('2d');

  calChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: cumData,
        borderColor: lineColor,
        borderWidth: 2,
        pointRadius: 4,
        pointBackgroundColor: cumData.map(v => v >= 0 ? '#3dba6f' : '#e05252'),
        pointBorderColor: 'transparent',
        tension: 0.3,
        fill: true,
        backgroundColor: lastVal>=0 ? 'rgba(61,186,111,0.07)' : 'rgba(224,82,82,0.07)',
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend:{display:false},
        tooltip:{
          backgroundColor:'#1c1c1c',
          borderColor:'#2a2a2a',
          borderWidth:1,
          titleFont:{family:'DM Sans',size:11},
          bodyFont:{family:'DM Sans',size:12},
          callbacks:{
            label: ctx => {
              const v = ctx.parsed.y;
              return calMode==='rs'
                ? `  Acum: ${v>=0?'+':''}${v.toFixed(2)}R`
                : `  Acum: ${v>=0?'+$':'-$'}${Math.abs(v).toFixed(2)}`;
            }
          }
        }
      },
      scales: {
        x: { grid:{color:'rgba(255,255,255,.04)'}, ticks:{color:'#666',font:{family:'DM Sans',size:10}}, border:{color:'transparent'} },
        y: {
          grid:{color:'rgba(255,255,255,.04)'},
          ticks:{color:'#666',font:{family:'DM Sans',size:10},
            callback: v => calMode==='rs' ? v+'R' : '$'+v
          },
          border:{color:'transparent'}
        }
      }
    }
  });
}

// ═══════════════════════════════
// NOTAS — Notion-style editor
// ═══════════════════════════════
let notas = [];          // [{id, title, blocks, tags, created, updated}]
let notaActiveId = null;
let notasSearchQ = '';
let notasCalYear  = new Date().getFullYear();
let notasCalMonth = new Date().getMonth();
let notasCalDay   = null; // YYYY-MM-DD string or null = all

const TAG_COLORS = {
  'Estrategia': {bg:'rgba(45,125,210,.25)', text:'#4a94e8'},
  'Mercado':    {bg:'rgba(61,186,111,.2)',  text:'#3dba6f'},
  'Error':      {bg:'rgba(224,82,82,.2)',   text:'#e05252'},
  'Setup':      {bg:'rgba(232,160,32,.2)', text:'#e8a020'},
  'Psicología': {bg:'rgba(160,100,220,.25)',text:'#b07add'},
  'Reglas':     {bg:'rgba(45,200,200,.2)', text:'#2dc8c8'},
};
const ALL_TAGS = Object.keys(TAG_COLORS);

async function loadNotas() {
  try { const _r = await fetch('/api/store/notas'); notas = (_r.ok ? await _r.json() : null) ?? []; } catch(e) { notas = []; }
}
async function saveNotas() {
  try { await fetch('/api/store/notas', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(notas) }); } catch(e) {}
}

function renderNotas() {
  renderNotasBigCal();
  renderNotasList();
  if (notaActiveId) renderNotaEditor(notaActiveId);
  else {
    document.getElementById('notas-editor-panel').style.display = 'none';
  }
}

// ── Calendar note drag & drop ──────────────────────────
let _nbcDragId = null;

function nbcDragStart(e, notaId) {
  _nbcDragId = notaId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', notaId);
  setTimeout(() => e.target.classList.add('dragging'), 0);
}

function nbcDragEnd(e) {
  e.target.classList.remove('dragging');
  document.querySelectorAll('.nbc-cell.drop-over').forEach(el => el.classList.remove('drop-over'));
  _nbcDragId = null;
}

function nbcDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const cell = e.currentTarget;
  if (!cell.classList.contains('drop-over')) cell.classList.add('drop-over');
}

function nbcDragLeave(e) {
  e.currentTarget.classList.remove('drop-over');
}

function nbcDrop(e, iso) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drop-over');
  const id = _nbcDragId || e.dataTransfer.getData('text/plain');
  if (!id) return;
  const nota = getNota(id);
  if (!nota) return;
  nota.noteDate = iso;
  nota.updated  = Date.now();
  saveNotas();
  renderNotasBigCal();
  renderNotasList();
  // Refresh editor date label if this note is open
  if (notaActiveId === id) {
    const lbl = document.getElementById('nota-date-label');
    if (lbl) {
      lbl.textContent = new Date(iso+'T12:00:00').toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
      const picker = document.getElementById('nota-date-picker');
      if (picker) picker.value = iso;
    }
  }
}

// ── Reflexiones ───────────────────────────────────────────
let reflexiones      = [];   // [{id, title, created, updated, blocks:[]}]
let reflActiveId     = null;
let _reflNicExpanded = new Set();
let _reflNicInstances= {};

function reflId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,5); }

async function loadReflexiones() {
  try {
    const _r = await fetch('/api/store/reflexiones');
    reflexiones = (_r.ok ? await _r.json() : null) ?? [];
    if (!Array.isArray(reflexiones)) reflexiones = [];
  } catch(e) { reflexiones = []; }
  renderReflList();
  if (reflexiones.length) openReflexion(reflexiones[0].id);
}

async function saveReflexiones() {
  try { await fetch('/api/store/reflexiones', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(reflexiones) }); } catch(e) {}
}

function renderReflList() {
  const el = document.getElementById('refl-list');
  if (!el) return;
  if (!reflexiones.length) {
    el.innerHTML = '<div style="padding:14px 12px;font-size:11px;color:var(--muted)">Sin reflexiones aún</div>';
    return;
  }
  const sorted = [...reflexiones].sort((a,b) => b.updated - a.updated);
  el.innerHTML = sorted.map(r => {
    const d    = new Date(r.created);
    const ds   = `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;
    const act  = r.id === reflActiveId ? ' active' : '';
    return `<div class="refl-item${act}" onclick="openReflexion('${r.id}')">
      <div class="refl-item-title">${r.title || 'Sin título'}</div>
      <div class="refl-item-date">${ds}</div>
    </div>`;
  }).join('');
}

function openReflexion(id) {
  reflActiveId = id;
  const r = reflexiones.find(x => x.id === id);
  if (!r) return;
  renderReflList();
  document.getElementById('refl-empty').style.display = 'none';
  const wrap = document.getElementById('refl-editor-wrap');
  wrap.style.display = 'flex';
  document.getElementById('refl-title-input').value = r.title || '';
  const d = new Date(r.created);
  document.getElementById('refl-editor-date').textContent =
    `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;
  renderReflBlocks(r);
}

function newReflexion() {
  const r = { id: reflId(), title: '', created: Date.now(), updated: Date.now(),
    blocks: [{ id: blkId(), type: 'text', content: '' }] };
  reflexiones.unshift(r);
  saveReflexiones();
  openReflexion(r.id);
  setTimeout(() => document.getElementById('refl-title-input')?.focus(), 50);
}

function deleteReflexion() {
  if (!reflActiveId) return;
  if (!confirm('¿Eliminar esta reflexión?')) return;
  reflexiones = reflexiones.filter(r => r.id !== reflActiveId);
  reflActiveId = null;
  saveReflexiones();
  renderReflList();
  document.getElementById('refl-empty').style.display = 'flex';
  document.getElementById('refl-editor-wrap').style.display = 'none';
  if (reflexiones.length) openReflexion(reflexiones[0].id);
}

function onReflTitleChange(val) {
  const r = reflexiones.find(x => x.id === reflActiveId);
  if (!r) return;
  r.title = val;
  r.updated = Date.now();
  saveReflexiones();
  renderReflList();
}

function getActiveRefl() { return reflexiones.find(x => x.id === reflActiveId) || null; }

// ── Block rendering for reflexiones ────────────────────────
function renderReflBlocks(r) {
  const el = document.getElementById('refl-blocks-wrap');
  if (!el || !r) return;
  if (!r.blocks || !r.blocks.length) r.blocks = [{ id: blkId(), type:'text', content:'' }];
  el.innerHTML = r.blocks.map((b,i) => renderReflBlock(b, r, i)).join('');
  // Auto-focus last text block
  const last = el.querySelector('.refl-text-block:last-child');
}

function renderReflBlock(b, r, idx) {
  if (b.type === 'trade-ref') return renderReflTradeBlock(b, r);
  const val = b.content || '';
  return `<div class="nota-block refl-block" data-id="${b.id}">
    <textarea class="refl-text-area nota-text-block"
      data-bid="${b.id}"
      placeholder="${idx === 0 ? 'Escribe tu reflexión… usa @ para mencionar un trade' : ''}"
      oninput="onReflTextInput(this,'${b.id}')"
      onkeydown="onReflKeydown(event,'${b.id}')"
      rows="1">${escHtml(val)}</textarea>
  </div>`;
}

function renderReflTradeBlock(b, r) {
  const g        = b.tradeGroup || {};
  const symbol   = g.symbol || '?';
  const dateISO  = g.dateISO || '';
  const isShort  = (g.type||'').toLowerCase() === 'short';
  const totalNet = g.trades ? g.trades.reduce((s,t)=>s+t.net,0) : 0;
  const typeColor= isShort ? '#e05252' : '#2dba6f';
  const pnlColor = totalNet >= 0 ? '#2dba6f' : '#e05252';
  const pnlStr   = (totalNet>=0?'+$':'-$') + Math.abs(totalNet).toFixed(2);
  const cid      = 'refl-nic-' + b.id;
  const open     = _reflNicExpanded.has(b.id);

  const chartHTML = open ? `
  <div class="nota-inline-chart-wrap" id="wrap-${cid}">
    <div class="nic-bar">
      <span class="nic-sym">${symbol}</span>
      <span class="nic-date">${dateISO}</span>
      <button class="nic-tf active" id="${cid}-tf1"  onclick="reflNicSetTF('${b.id}','${symbol}','${dateISO}',1)">1m</button>
      <button class="nic-tf"        id="${cid}-tf5"  onclick="reflNicSetTF('${b.id}','${symbol}','${dateISO}',5)">5m</button>
      <button class="nic-tf"        id="${cid}-tf15" onclick="reflNicSetTF('${b.id}','${symbol}','${dateISO}',15)">15m</button>
      <button class="nic-close" onclick="reflNicToggle('${b.id}','${symbol}','${dateISO}')">▲ cerrar</button>
    </div>
    <div class="nic-body" id="${cid}">
      <div class="nic-loading" id="${cid}-loading">Cargando velas…</div>
    </div>
  </div>` : '';

  return `<div class="nota-block refl-block" data-id="${b.id}" style="flex-direction:column;align-items:stretch">
    <div style="display:flex;align-items:center;gap:6px">
      <div class="nota-trade-block" style="flex:1">
        <span class="nota-trade-symbol" onclick="openTradeChart('${symbol}','${dateISO}')" title="Modal">${symbol}</span>
        <span class="nota-trade-date" style="color:var(--dim)">${dateISO}</span>
        <span class="nota-trade-type" style="background:${typeColor}22;color:${typeColor}">${isShort?'SHORT':'LONG'}</span>
        <span class="nota-trade-pnl" style="color:${pnlColor};font-size:15px;font-weight:700">${pnlStr}</span>
        <button class="nic-show-btn" onclick="reflNicToggle('${b.id}','${symbol}','${dateISO}')">${open?'▲ chart':'📈 chart'}</button>
      </div>
      <button class="nota-trade-remove" onclick="reflDeleteBlock('${b.id}')" title="Quitar">✕</button>
    </div>
    ${chartHTML}
  </div>`;
}

function onReflTextInput(ta, bid) {
  autoResize(ta);
  const r = getActiveRefl(); if (!r) return;
  const b = r.blocks.find(x => x.id === bid); if (!b) return;
  b.content = ta.value;
  r.updated = Date.now();
  // @Trade trigger
  const val = ta.value;
  const at  = val.lastIndexOf('@');
  if (at !== -1 && at === val.length - 1) {
    openReflTradeMentionMenu(ta, bid);
  }
  debounceSave();
  saveReflexiones();
}

function onReflKeydown(e, bid) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const r = getActiveRefl(); if (!r) return;
    const idx = r.blocks.findIndex(x => x.id === bid);
    const newB = { id: blkId(), type:'text', content:'' };
    r.blocks.splice(idx + 1, 0, newB);
    r.updated = Date.now();
    renderReflBlocks(r);
    saveReflexiones();
    // Focus new block
    setTimeout(() => {
      const el = document.querySelector(`[data-bid="${newB.id}"]`);
      if (el) { el.focus(); autoResize(el); }
    }, 20);
  }
  if (e.key === 'Backspace') {
    const ta = e.target;
    if (!ta.value.trim()) {
      e.preventDefault();
      const r = getActiveRefl(); if (!r) return;
      if (r.blocks.length <= 1) return;
      const idx = r.blocks.findIndex(x => x.id === bid);
      r.blocks.splice(idx, 1);
      r.updated = Date.now();
      renderReflBlocks(r);
      saveReflexiones();
      setTimeout(() => {
        const prevId = r.blocks[Math.max(0, idx-1)]?.id;
        const el = document.querySelector(`[data-bid="${prevId}"]`);
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      }, 20);
    }
  }
}

function reflDeleteBlock(bid) {
  const r = getActiveRefl(); if (!r) return;
  r.blocks = r.blocks.filter(x => x.id !== bid);
  if (!r.blocks.length) r.blocks = [{ id: blkId(), type:'text', content:'' }];
  r.updated = Date.now();
  renderReflBlocks(r);
  saveReflexiones();
}

// ── NIC (inline chart) for reflexiones ───────────────────
async function reflNicToggle(bid, symbol, dateISO) {
  const cid = 'refl-nic-' + bid;
  if (_reflNicExpanded.has(bid)) {
    _reflNicExpanded.delete(bid);
    if (_reflNicInstances[bid]) { try { _reflNicInstances[bid].chart.remove(); } catch(e){} delete _reflNicInstances[bid]; }
    const r = getActiveRefl(); if (r) renderReflBlocks(r); return;
  }
  _reflNicExpanded.add(bid);
  const r = getActiveRefl(); if (r) renderReflBlocks(r);
  await reflNicLoad(bid, symbol, dateISO, 1);
}

async function reflNicLoad(bid, symbol, dateISO, tf) {
  const cid   = 'refl-nic-' + bid;
  const body  = document.getElementById(cid);
  const load  = document.getElementById(cid + '-loading');
  if (!body) return;
  if (load) load.style.display = '';
  const apiKey = document.getElementById('cfg-polygon-key')?.value?.trim() || '';
  if (!apiKey) { if (body) body.innerHTML = '<div class="nic-error">Sin API key Polygon</div>'; return; }
  try {
    const candles = await fetchNicCandles(symbol, dateISO, tf, apiKey);
    if (!candles.length) { body.innerHTML = '<div class="nic-error">Sin datos</div>'; return; }
    if (load) load.style.display = 'none';
    const dayTrades = trades.filter(t => t.symbol===symbol && t.dateISO===dateISO);
    const inst = nicDrawChart(cid, candles, dayTrades);
    _reflNicInstances[bid] = inst;
  } catch(ex) { if (body) body.innerHTML = `<div class="nic-error">${ex.message}</div>`; }
}

async function reflNicSetTF(bid, symbol, dateISO, tf) {
  const cid = 'refl-nic-' + bid;
  ['tf1','tf5','tf15'].forEach(s => document.getElementById(`${cid}-${s}`)?.classList.remove('active'));
  document.getElementById(`${cid}-tf${tf}`)?.classList.add('active');
  if (_reflNicInstances[bid]) { try { _reflNicInstances[bid].chart.remove(); } catch(e){} delete _reflNicInstances[bid]; }
  await reflNicLoad(bid, symbol, dateISO, tf);
}

// ── @Trade mention for reflexiones ───────────────────────
let _reflMentionBid = null;

function openReflTradeMentionMenu(ta, bid) {
  _reflMentionBid = bid;
  // Reuse the same trade mention menu but point insertion to refl system
  const rect = ta.getBoundingClientRect();
  let menu = document.getElementById('trade-mention-menu');
  if (menu) menu.remove();
  menu = document.createElement('div');
  menu.id = 'trade-mention-menu';
  menu.className = 'trade-mention-menu';
  menu.innerHTML = `<div class="trade-mention-search">
      <input id="trade-mention-input" type="text" placeholder="Buscar ticker, fecha…" autocomplete="off"
        oninput="tradeMentionFilter(this.value)"
        onkeydown="tradeMentionKeydown(event)">
    </div>
    <div id="trade-mention-results"></div>`;
  menu.style.top  = (rect.bottom + 4) + 'px';
  menu.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
  document.body.appendChild(menu);
  document.getElementById('trade-mention-input')?.focus();
  tradeMentionFilter('');
  // Override insertion to use refl system
  window._mentionInsertFn = (idx) => insertReflTradeMention(idx);
  setTimeout(() => document.addEventListener('mousedown', closeReflMentionOnOutside), 10);
}

function closeReflMentionOnOutside(e) {
  if (!document.getElementById('trade-mention-menu')?.contains(e.target)) {
    document.getElementById('trade-mention-menu')?.remove();
    document.removeEventListener('mousedown', closeReflMentionOnOutside);
    window._mentionInsertFn = null;
  }
}

function insertReflTradeMention(idx) {
  const el = document.getElementById('trade-mention-results');
  const g  = el?._results?.[idx]; if (!g) return;
  const r  = getActiveRefl(); if (!r) return;
  const bid = _reflMentionBid;
  const tIdx = r.blocks.findIndex(b => b.id === bid);
  const newB = { id: blkId(), type: 'trade-ref', content: '', tradeGroup: g };
  // Remove empty trigger block or insert after
  const triggerB = r.blocks[tIdx];
  if (triggerB && triggerB.type === 'text' && triggerB.content.trim() === '@') {
    r.blocks.splice(tIdx, 1, newB);
  } else {
    r.blocks.splice(tIdx >= 0 ? tIdx + 1 : r.blocks.length, 0, newB);
  }
  // Always add a new empty text block after
  r.blocks.splice(r.blocks.indexOf(newB) + 1, 0, { id: blkId(), type:'text', content:'' });
  r.updated = Date.now();
  renderReflBlocks(r);
  saveReflexiones();
  document.getElementById('trade-mention-menu')?.remove();
  window._mentionInsertFn = null;
  // Auto-expand chart
  setTimeout(() => reflNicToggle(newB.id, g.symbol, g.dateISO), 80);
}



function setNotasView(view) {
  const isRefl = view === 'reflexiones';
  document.getElementById('vtab-calendar').classList.toggle('active', !isRefl);
  document.getElementById('vtab-reflexiones').classList.toggle('active', isRefl);
  document.getElementById('notas-view-calendar').style.display = isRefl ? 'none' : 'flex';
  document.getElementById('notas-view-reflexiones').style.display = isRefl ? 'flex' : 'none';
  // Hide the whole left sidebar when reflexiones (it has its own internal sidebar)
  const sidebar = document.getElementById('notas-sidebar');
  if (sidebar) sidebar.style.display = isRefl ? 'none' : '';
  // Adjust grid to full-width when reflexiones
  const layout = document.querySelector('.notas-layout');
  if (layout) layout.style.gridTemplateColumns = isRefl ? '1fr' : '220px 1fr';
  if (isRefl) loadReflexiones();
}

function renderNotasBigCal() {
  const el = document.getElementById('notas-bigcal');
  if (!el) return;
  const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const DOWS = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

  // Map: 'YYYY-MM-DD' → [nota, nota, ...]
  const dayMap = {};
  notas.forEach(n => {
    const iso = notaDateISO(n);
    const [y, m] = iso.split('-').map(Number);
    if (y !== notasCalYear || m-1 !== notasCalMonth) return;
    if (!dayMap[iso]) dayMap[iso] = [];
    dayMap[iso].push(n);
  });

  const todayD  = new Date();
  const todayISO = `${todayD.getFullYear()}-${String(todayD.getMonth()+1).padStart(2,'0')}-${String(todayD.getDate()).padStart(2,'0')}`;
  const daysInMonth = new Date(notasCalYear, notasCalMonth+1, 0).getDate();
  const dowMon = d => { const w = new Date(notasCalYear, notasCalMonth, d).getDay(); return w===0?6:w-1; };
  const leadEmpty = dowMon(1);

  let cells = '';
  for (let i=0; i<leadEmpty; i++) cells += `<div class="nbc-cell empty"></div>`;

  for (let d=1; d<=daysInMonth; d++) {
    const iso  = `${notasCalYear}-${String(notasCalMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayNotas = dayMap[iso] || [];
    const isToday  = iso === todayISO;
    const cls = ['nbc-cell', isToday?'today':'', dayNotas.length?'has-nota':''].filter(Boolean).join(' ');

    let chips = '';
    const maxShow = 3;
    dayNotas.slice(0, maxShow).forEach(n => {
      const title = n.title?.trim() || '';
      const tagColor = n.tags?.length ? (TAG_COLORS[n.tags[0]]?.text || 'var(--amber)') : 'var(--amber)';
      chips += `<div class="nbc-nota-chip ${title?'':'untitled'}"
        style="border-left-color:${tagColor}"
        draggable="true"
        ondragstart="nbcDragStart(event,'${n.id}')"
        ondragend="nbcDragEnd(event)"
        onclick="event.stopPropagation();openNota('${n.id}')"
        title="${title||'Sin título'}">${title||'Sin título'}</div>`;
    });
    if (dayNotas.length > maxShow) {
      chips += `<div class="nbc-more" onclick="event.stopPropagation();notasCalFilterDay('${iso}')">+${dayNotas.length-maxShow} más</div>`;
    }

    const newClick = `onclick="notaNewOnDay('${iso}')"`;
    cells += `<div class="${cls}"
      ondragover="nbcDragOver(event)"
      ondragleave="nbcDragLeave(event)"
      ondrop="nbcDrop(event,'${iso}')"
      onclick="notasCalFilterDay('${iso}')">
      <div class="nbc-day-num">${d}</div>
      ${chips}
      <button class="nbc-new-btn" ${newClick} title="Nueva nota este día">+ nota</button>
    </div>`;
  }

  // Trailing empty cells to complete last row
  const totalCells = leadEmpty + daysInMonth;
  const numRows = Math.ceil(totalCells / 7);
  const remainder = totalCells % 7;
  if (remainder) for (let i=0; i<7-remainder; i++) cells += `<div class="nbc-cell empty"></div>`;

  el.innerHTML = `
    <div class="nbc-header">
      <span class="nbc-label">${MONTHS_ES[notasCalMonth]} ${notasCalYear}</span>
      <div class="nbc-nav">
        <button class="nbc-today-btn" onclick="notasCalToday()">Hoy</button>
        <button class="nbc-arrow" onclick="notasCalNav(-1)">‹</button>
        <button class="nbc-arrow" onclick="notasCalNav(1)">›</button>
        <button class="nbc-expand-btn" onclick="toggleNotasCal()" title="Expandir calendario">
          <span class="nbc-collapse-icon">▼</span> calendario
        </button>
      </div>
    </div>
    <div class="nbc-dow-row">${DOWS.map(d=>`<div class="nbc-dow">${d}</div>`).join('')}</div>
    <div class="nbc-grid rows-${numRows}">${cells}</div>
  `;
}

function notasCalNav(dir) {
  notasCalMonth += dir;
  if (notasCalMonth > 11) { notasCalMonth=0; notasCalYear++; }
  if (notasCalMonth < 0)  { notasCalMonth=11; notasCalYear--; }
  renderNotasBigCal();
}
function notasCalToday() {
  notasCalYear  = new Date().getFullYear();
  notasCalMonth = new Date().getMonth();
  renderNotasBigCal();
}
function toggleNotasCal() {
  document.getElementById('notas-bigcal').classList.remove('collapsed');
  renderNotasBigCal();
}
function notasCalFilterDay(iso) {
  // Toggle: if already filtered to this day, clear
  notasCalDay = notasCalDay === iso ? null : iso;
  renderNotasList();
}
function notasCalClear() { notasCalDay = null; renderNotasList(); }

function notaNewOnDay(iso) {
  // Create note with timestamp set to that day
  const id = 'nota_' + Date.now();
  const [y,m,d] = iso.split('-').map(Number);
  const ts = new Date(y, m-1, d, 12, 0, 0).getTime();
  const nota = { id, title:'', blocks:[{id:blkId(), type:'text', content:''}], tags:[], created:ts, updated:ts };
  notas.unshift(nota);
  saveNotas();
  notaActiveId = id;
  // Navigate to that month
  notasCalYear  = y;
  notasCalMonth = m-1;
  renderNotasBigCal();
  renderNotasList();
  renderNotaEditor(id);
  setTimeout(() => document.getElementById('nota-title')?.focus(), 50);
}

function closeNotaEditor() {
  notaActiveId = null;
  document.getElementById('notas-editor-panel').style.display = 'none';
  document.getElementById('notas-bigcal').classList.remove('collapsed');
  renderNotasBigCal();
  renderNotasList();
}
function renderNotasList() {
  const el = document.getElementById('notas-list');
  let list = [...notas].sort((a,b) => b.updated - a.updated);

  // Filter by selected calendar day (only when not searching)
  if (notasCalDay && !notasSearchQ) {
    list = list.filter(n => notaDateISO(n) === notasCalDay);
  }

  if (notasSearchQ) {
    const q = notasSearchQ.toLowerCase();
    list = list.filter(n =>
      (n.title||'').toLowerCase().includes(q) ||
      notaDateISO(n).includes(q) ||
      new Date(n.noteDate||n.updated).toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).toLowerCase().includes(q) ||
      n.blocks?.some(b => (b.content||'').toLowerCase().includes(q))
    );
    el.innerHTML = list.map(n => notaItemHtml(n)).join('')
      || '<div style="padding:20px 16px;font-family:var(--sans);font-size:12px;color:var(--muted)">Sin resultados</div>';
    return;
  }

  if (!list.length) {
    el.innerHTML = '<div style="padding:20px 16px;font-family:var(--sans);font-size:12px;color:var(--muted)">Sin notas</div>';
    return;
  }

  // Group by: Esta semana / Semana pasada / [Mes Año] / [Año anterior]
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(today); weekStart.setDate(today.getDate() - today.getDay() + (today.getDay()===0?-6:1));
  const lastWeekStart = new Date(weekStart); lastWeekStart.setDate(weekStart.getDate() - 7);

  function getGroupKey(ts) {
    const d = new Date(ts);
    if (d >= weekStart)     return '__this_week__';
    if (d >= lastWeekStart) return '__last_week__';
    // Month + year
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }
  function getGroupLabel(key) {
    if (key === '__this_week__') return 'Esta semana';
    if (key === '__last_week__') return 'Semana pasada';
    const [y, m] = key.split('-');
    const d = new Date(parseInt(y), parseInt(m)-1, 1);
    const label = d.toLocaleDateString('es-ES', {month:'long', year:'numeric'});
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  // Build ordered groups
  const groupMap = {};
  const groupOrder = [];
  list.forEach(n => {
    const k = getGroupKey(n.noteDate ? new Date(n.noteDate+'T12:00:00').getTime() : n.updated);
    if (!groupMap[k]) { groupMap[k] = []; groupOrder.push(k); }
    groupMap[k].push(n);
  });

  el.innerHTML = groupOrder.map(key => {
    const label = getGroupLabel(key);
    const collapsed = _collapsedGroups.has(key);
    return `<div class="notas-group" data-key="${key}">
      <div class="notas-group-header" onclick="toggleNotasGroup('${key}')">
        <span>${label}</span>
        <span class="notas-group-chevron ${collapsed?'collapsed':''}">▾</span>
      </div>
      <div class="notas-group-body ${collapsed?'collapsed':''}">
        ${groupMap[key].map(n => notaItemHtml(n)).join('')}
      </div>
    </div>`;
  }).join('');
}

function notaItemHtml(n) {
  const title   = n.title?.trim() || '';
  const preview = n.blocks?.find(b=>b.type==='text'&&b.content)?.content?.slice(0,55) || '';
  const time    = new Date(n.updated).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'});
  const _nd     = n.noteDate ? new Date(n.noteDate+'T12:00:00') : new Date(n.updated);
  const dayNum  = _nd.getDate();
  const mon     = _nd.toLocaleDateString('es-ES',{month:'short'});
  const tagHtml = (n.tags||[]).slice(0,2).map(t => {
    const c = TAG_COLORS[t]||{bg:'var(--bg4)',text:'var(--dim)'};
    return `<span class="nota-tag" style="background:${c.bg};color:${c.text}">${t}</span>`;
  }).join('');
  const tradeCount = (n.blocks||[]).filter(b=>b.type==='trade-ref').length;
  const tradeChip  = tradeCount ? `<span style="font-size:9px;color:var(--amber)">@ ${tradeCount}</span>` : '';
  return `<div class="nota-item ${n.id===notaActiveId?'active':''}" onclick="openNota('${n.id}')">
    <div style="display:flex;gap:8px;align-items:flex-start">
      <div style="text-align:center;flex-shrink:0;width:28px">
        <div style="font-family:var(--mono);font-size:13px;font-weight:700;color:${n.id===notaActiveId?'var(--amber)':'var(--dim)'};line-height:1">${dayNum}</div>
        <div style="font-family:var(--sans);font-size:9px;color:var(--muted);text-transform:uppercase">${mon}</div>
      </div>
      <div style="flex:1;min-width:0">
        <div class="nota-item-title ${title?'':'untitled'}">${title||'Sin título'}</div>
        ${preview ? `<div style="font-family:var(--sans);font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${preview}</div>` : ''}
        <div class="nota-item-meta" style="margin-top:3px">${time} ${tagHtml} ${tradeChip}</div>
      </div>
    </div>
  </div>`;
}

const _collapsedGroups = new Set();
function toggleNotasGroup(key) {
  if (_collapsedGroups.has(key)) _collapsedGroups.delete(key);
  else _collapsedGroups.add(key);
  renderNotasList();
}

function showNotasEmpty() {
  const ed = document.getElementById('notas-editor');
  ed.innerHTML = `<div class="notas-empty">
    <div class="notas-empty-icon">📝</div>
    <div class="notas-empty-text">Crea una nota con el botón +</div>
  </div>`;
  document.getElementById('notas-tags-bar').innerHTML = '';
}

function notaNew() {
  const id = 'nota_' + Date.now();
  const nota = { id, title:'', blocks:[{id:blkId(), type:'text', content:''}], tags:[], created:Date.now(), updated:Date.now() };
  notas.unshift(nota);
  saveNotas();
  notaActiveId = id;
  // Navigate calendar to current month so dot appears
  notasCalYear  = new Date().getFullYear();
  notasCalMonth = new Date().getMonth();
  notasCalDay   = null;
  renderNotasCal();
  renderNotasList();
  renderNotaEditor(id);
  // Focus title
  setTimeout(() => document.getElementById('nota-title')?.focus(), 50);
}

function openNota(id) {
  notaActiveId = id;
  renderNotasList();
  renderNotaEditor(id);
}

function getNota(id) { return notas.find(n=>n.id===id); }

function renderNotaEditor(id) {
  const nota = getNota(id);
  if (!nota) { document.getElementById('notas-editor-panel').style.display='none'; return; }
  document.getElementById('notas-editor-panel').style.display = 'flex';
  document.getElementById('notas-bigcal').classList.add('collapsed');
  const ed = document.getElementById('notas-editor');
  const dateISO = notaDateISO(nota);
  const dateFmt = new Date(dateISO+'T12:00:00').toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});

  ed.innerHTML = `
    <textarea class="nota-title-input" id="nota-title" placeholder="Sin título" rows="1"
      oninput="notaTitleChange(this)" onkeydown="notaTitleKeydown(event)">${escHtml(nota.title||'')}</textarea>
    <div class="nota-date-display" style="display:flex;align-items:center;gap:8px">
      <span id="nota-date-label" style="cursor:pointer;border-bottom:1px dashed var(--border3)" onclick="toggleNotaDatePicker('${id}')" title="Cambiar fecha">${dateFmt}</span>
      <input type="date" id="nota-date-picker" value="${dateISO}" style="display:none;background:var(--bg3);border:1px solid var(--amber);color:var(--text);font-family:var(--sans);font-size:11px;padding:3px 6px;border-radius:4px;outline:none"
        onchange="setNotaDate('${id}',this.value)" onblur="document.getElementById('nota-date-picker').style.display='none'">
    </div>
    <div class="nota-blocks" id="nota-blocks"></div>
  `;
  autoResize(document.getElementById('nota-title'));
  renderBlocks(nota);
  renderTagsBar(nota);
}

function renderBlocks(nota) {
  const container = document.getElementById('nota-blocks');
  if (!container) return;
  container.innerHTML = nota.blocks.map((b,i) => renderBlock(b, i, nota.blocks.length)).join('');
  // Re-attach auto-resize
  container.querySelectorAll('.nota-block-input:not(.divider-input)').forEach(ta => {
    autoResize(ta);
  });
}

function renderBlock(b, i, total) {
  if (b.type === 'divider') {
    return `<div class="nota-block" data-id="${b.id}" draggable="true"
      ondragstart="blockDragStart(event,'${b.id}')" ondragend="blockDragEnd(event)"
      ondragover="blockDragOver(event,'${b.id}')" ondragleave="blockDragLeave(event)" ondrop="blockDrop(event,'${b.id}')">
      <div class="nota-block-handle">⋮⋮</div>
      <div class="nota-block-content"><hr class="nota-block-divider"></div>
      <button class="nota-delete-btn" onclick="notaDeleteBlock('${b.id}')">✕</button>
    </div>`;
  }
  if (b.type === 'trade-ref') {
    return renderTradeRefBlock(b);
  }
  const bullet = b.type === 'bullet' ? `<div class="nota-block-bullet">•</div>` : '';
  const ph = {text:'Escribe algo… (@ para mencionar un trade)',h1:'Título 1',h2:'Título 2',h3:'Título 3',quote:'Cita o reflexión…',bullet:'Elemento de lista',code:'// código…'}[b.type]||'';
  return `<div class="nota-block" data-id="${b.id}" draggable="true"
    ondragstart="blockDragStart(event,'${b.id}')" ondragend="blockDragEnd(event)"
    ondragover="blockDragOver(event,'${b.id}')" ondragleave="blockDragLeave(event)" ondrop="blockDrop(event,'${b.id}')">
    <div class="nota-block-handle">⋮⋮</div>
    <div class="nota-block-content" style="display:flex;gap:6px;align-items:flex-start">
      ${bullet}
      <textarea class="nota-block-input ${b.type}" data-id="${b.id}" rows="1"
        placeholder="${ph}"
        oninput="notaBlockChange(this)"
        onkeydown="notaBlockKeydown(event,this)"
      >${escHtml(b.content||'')}</textarea>
    </div>
    <button class="nota-delete-btn" onclick="notaDeleteBlock('${b.id}')">✕</button>
  </div>`;
}

// ── Inline chart state ──
const _nicInstances = {}; // blockId → { chart, rawBars, tf }
const _nicExpanded  = new Set();

function renderTradeRefBlock(b) {
  // Support both new tradeGroup (grouped) and legacy tradeRef (single trade)
  let symbol, dateISO, isShort, totalNet, totalQty, execCount, execSummary, typeStr;

  if (b.tradeGroup) {
    const g = b.tradeGroup;
    // Re-resolve from live trades so data is always fresh
    const live = trades.filter(t => t.symbol === g.symbol && t.dateISO === g.dateISO &&
                                    t.type?.toLowerCase() === g.type?.toLowerCase());
    symbol    = g.symbol;
    dateISO   = g.dateISO;
    isShort   = g.type?.toLowerCase() === 'short';
    typeStr   = g.type;
    totalNet  = live.length ? live.reduce((s,t)=>s+t.net,0) : g.totalNet;
    totalQty  = live.length ? live.reduce((s,t)=>s+(t.qty||0),0) : g.totalQty;
    execCount = live.length || g.trades?.length || 1;
    // Show entry range → exit range
    if (live.length) {
      const entries = live.map(t=>t.entry).filter(Boolean);
      const exits   = live.map(t=>t.exit).filter(Boolean);
      const entryMin = Math.min(...entries), entryMax = Math.max(...entries);
      const exitMin  = Math.min(...exits),   exitMax  = Math.max(...exits);
      const eStr = entries.length ? (entryMin===entryMax ? `$${entryMin.toFixed(2)}` : `$${entryMin.toFixed(2)}–$${entryMax.toFixed(2)}`) : '';
      const xStr = exits.length   ? (exitMin===exitMax   ? `$${exitMin.toFixed(2)}`  : `$${exitMin.toFixed(2)}–$${exitMax.toFixed(2)}`)   : '';
      execSummary = [totalQty?`${totalQty} acc`:'', eStr&&xStr?`${eStr}→${xStr}`:''].filter(Boolean).join(' · ');
    } else {
      execSummary = `${totalQty||'?'} acc`;
    }
  } else if (b.tradeRef) {
    // Legacy single-trade block — upgrade it on the fly
    const t = b.tradeRef;
    symbol    = t.symbol;
    dateISO   = t.dateISO;
    isShort   = t.type?.toLowerCase() === 'short';
    typeStr   = t.type;
    totalNet  = t.net || 0;
    totalQty  = t.qty || 0;
    execCount = 1;
    execSummary = [t.qty?`${t.qty} acc`:'', t.entry?`$${t.entry.toFixed(2)}→$${t.exit?.toFixed(2)}`:''].filter(Boolean).join(' · ');
  } else {
    return `<div class="nota-block" data-id="${b.id}"><div style="color:var(--muted);font-size:12px;padding:4px 0">Trade no encontrado</div><button class="nota-delete-btn" onclick="notaDeleteBlock('${b.id}')">✕</button></div>`;
  }

  const typeColor = isShort ? '#e05252' : '#2dba6f';
  const pnlColor  = totalNet >= 0 ? '#2dba6f' : '#e05252';
  const pnlStr    = (totalNet>=0?'+$':'-$') + Math.abs(totalNet).toFixed(2);
  const execBadge = execCount > 1 ? `<span style="font-size:10px;color:var(--dim);margin-left:4px">${execCount} exec</span>` : '';
  const open = _nicExpanded.has(b.id);
  const cid  = 'nic-' + b.id;

  const chartHTML = open ? `
  <div class="nota-inline-chart-wrap" id="wrap-${cid}">
    <div class="nic-bar">
      <span class="nic-sym">${symbol}</span>
      <span class="nic-date">${dateISO}</span>
      <button class="nic-tf active" id="${cid}-tf1"  onclick="nicSetTF('${b.id}','${symbol}','${dateISO}',1)">1m</button>
      <button class="nic-tf"        id="${cid}-tf5"  onclick="nicSetTF('${b.id}','${symbol}','${dateISO}',5)">5m</button>
      <button class="nic-tf"        id="${cid}-tf15" onclick="nicSetTF('${b.id}','${symbol}','${dateISO}',15)">15m</button>
      <button class="nic-close" onclick="nicToggle('${b.id}','${symbol}','${dateISO}')">▲ cerrar</button>
    </div>
    <div class="nic-body" id="${cid}">
      <div class="nic-loading" id="${cid}-loading">Cargando velas…</div>
    </div>
  </div>` : '';

  return `<div class="nota-block" data-id="${b.id}" style="flex-direction:column;align-items:stretch" draggable="true"
    ondragstart="blockDragStart(event,'${b.id}')" ondragend="blockDragEnd(event)"
    ondragover="blockDragOver(event,'${b.id}')" ondragleave="blockDragLeave(event)" ondrop="blockDrop(event,'${b.id}')">
    <div style="display:flex;align-items:center;gap:6px">
      <div class="nota-block-handle">⋮⋮</div>
      <div class="nota-trade-block" style="flex:1">
        <span class="nota-trade-symbol" onclick="openTradeChart('${symbol}','${dateISO}')" title="Abrir chart en modal">${symbol}</span>
        <span class="nota-trade-date" onclick="openJournal('${dateISO}')" style="cursor:pointer;color:var(--dim)" title="Ver journal">${dateISO}</span>
        <span class="nota-trade-type" style="background:${typeColor}22;color:${typeColor}">${isShort?'SHORT':'LONG'}${execBadge}</span>
        <span class="nota-trade-detail">${execSummary}</span>
        <span class="nota-trade-pnl" style="color:${pnlColor};font-size:16px;font-weight:700">${pnlStr}</span>
        <button class="nic-show-btn" onclick="nicToggle('${b.id}','${symbol}','${dateISO}')">${open?'▲ chart':'📈 chart'}</button>
      </div>
      <button class="nota-trade-remove" onclick="notaDeleteBlock('${b.id}')" title="Quitar">✕</button>
    </div>
    ${chartHTML}
  </div>`;
}

async function nicToggle(bid, symbol, dateISO) {
  if (_nicExpanded.has(bid)) {
    _nicExpanded.delete(bid);
    // destroy chart instance
    if (_nicInstances[bid]) {
      try { _nicInstances[bid].chart.remove(); } catch(e){}
      delete _nicInstances[bid];
    }
    // re-render just this block
    nicRerender(bid);
    return;
  }
  _nicExpanded.add(bid);
  nicRerender(bid);
  // Load data after DOM renders
  await nicLoad(bid, symbol, dateISO, 1);
}

function nicRerender(bid) {
  // Find the nota containing this block and re-render just the block node
  const nota = getNota(notaActiveId);
  if (!nota) return;
  const b = nota.blocks.find(x => x.id === bid);
  if (!b) return;
  const container = document.querySelector(`.nota-block[data-id="${bid}"]`)?.parentElement;
  if (!container) { renderNotaEditor(notaActiveId); return; }
  const wrapper = document.querySelector(`.nota-block[data-id="${bid}"]`);
  if (!wrapper) return;
  wrapper.outerHTML = renderTradeRefBlock(b);
  // After DOM update, if expanded, init chart
  if (_nicExpanded.has(bid) && _nicInstances[bid]?.rawBars) {
    nicDrawChart(bid, _nicInstances[bid].rawBars, _nicInstances[bid].tf, b.tradeRef);
  }
}

async function nicLoad(bid, symbol, dateISO, tf) {
  loadMassiveKey();
  const loadEl = document.getElementById(`nic-${bid}-loading`);
  if (!massiveKey) {
    if (loadEl) loadEl.textContent = 'Necesitas configurar tu API key en Ajustes.';
    return;
  }
  try {
    const utcOffset = isDST(new Date(dateISO + 'T12:00:00Z')) ? 4 : 5;
    const fromMs = new Date(`${dateISO}T${String(4  + utcOffset).padStart(2,'0')}:00:00Z`).getTime();
    const toMs   = new Date(`${dateISO}T${String(16 + utcOffset).padStart(2,'0')}:00:00Z`).getTime();
    const resp   = await massiveFetch(`/v2/aggs/ticker/${symbol}/range/1/minute/${fromMs}/${toMs}?adjusted=false&sort=asc&limit=2000`);
    const rawBars = resp.results || [];
    if (!rawBars.length) { if (loadEl) loadEl.textContent = 'Sin datos.'; return; }
    _nicInstances[bid] = { rawBars, tf };
    // find tradeRef or tradeGroup for markers
    const nota = getNota(notaActiveId);
    const blk  = nota?.blocks.find(x => x.id === bid);
    // Always use all live trades for the symbol+date for markers
    const refSymbol  = blk?.tradeGroup?.symbol  || blk?.tradeRef?.symbol;
    const refDateISO = blk?.tradeGroup?.dateISO || blk?.tradeRef?.dateISO;
    const tRef = refSymbol && refDateISO ? { symbol: refSymbol, dateISO: refDateISO } : null;
    nicDrawChart(bid, rawBars, tf, tRef);
  } catch(e) {
    if (loadEl) loadEl.textContent = 'Error: ' + e.message;
  }
}

function nicDrawChart(bid, rawBars, tf, t) {
  const cid    = 'nic-' + bid;
  const body   = document.getElementById(cid);
  if (!body) return;
  const loadEl = document.getElementById(cid + '-loading');
  if (loadEl) loadEl.style.display = 'none';

  // Remove old chart
  if (_nicInstances[bid]?.chart) {
    try { _nicInstances[bid].chart.remove(); } catch(e){}
  }

  const nicDateISO = t?.dateISO || new Date().toISOString().slice(0,10);
  const utcOffset  = isDST(new Date(nicDateISO + 'T12:00:00Z')) ? 4 : 5;
  const chart = LightweightCharts.createChart(body, {
    width: body.clientWidth, height: body.clientHeight,
    layout: { background:{type:'solid',color:'#0f0f0f'}, textColor:'#777', fontFamily:'DM Mono,monospace', fontSize:10 },
    grid: { vertLines:{color:'#161616'}, horzLines:{color:'#161616'} },
    crosshair: { mode:1 },
    rightPriceScale: { borderColor:'#1e1e1e', scaleMargins:{top:0.1, bottom:0.2} },
    leftPriceScale: { visible:false },
    timeScale: { borderColor:'#1e1e1e', timeVisible:true, secondsVisible:false, rightOffset:5,
      tickMarkFormatter: ts => {
        const et = new Date((ts - utcOffset * 3600) * 1000);
        const h = et.getUTCHours().toString().padStart(2,'0');
        const m = et.getUTCMinutes().toString().padStart(2,'0');
        return h + ':' + m;
      },
    },
    localization: {
      timeFormatter: ts => {
        const et = new Date((ts - utcOffset * 3600) * 1000);
        const h = et.getUTCHours().toString().padStart(2,'0');
        const m = et.getUTCMinutes().toString().padStart(2,'0');
        return h + ':' + m + ' ET';
      },
    },
    handleScroll:true, handleScale:true,
  });

  const candles = aggregateBars(rawBars, tf);
  const candleSeries = chart.addCandlestickSeries({
    upColor:'#2dba6f', downColor:'#e05252',
    borderUpColor:'#2dba6f', borderDownColor:'#e05252',
    wickUpColor:'#2dba6f', wickDownColor:'#e05252',
  });
  candleSeries.setData(candles);

  // ── VWAP + MA72 ──
  const { vwapData, ma72Data } = buildIndicators(candles);
  const vwapSeries = chart.addLineSeries({ color:'#f0a500', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false, title:'VWAP' });
  vwapSeries.setData(vwapData);
  const ma72Series = chart.addLineSeries({ color:'#8888ff', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false, title:'MA72', lineStyle:1 });
  ma72Series.setData(ma72Data);

  const volSeries = chart.addHistogramSeries({ priceFormat:{type:'volume'}, priceScaleId:'vol' });
  volSeries.priceScale().applyOptions({ scaleMargins:{top:0.82,bottom:0} });
  volSeries.setData(candles.map(c => ({ time:c.time, value:c.volume, color: c.close>=c.open?'rgba(45,186,111,0.2)':'rgba(224,82,82,0.2)' })));

  // Trade markers & price lines
  if (t) {
    const dateISO = t.dateISO;
    const utcOffset = isDST(new Date(dateISO + 'T12:00:00Z')) ? 4 : 5;
    const dayTrades = trades.filter(x => x.symbol===t.symbol && x.dateISO===t.dateISO);
    const markers = buildTradeMarkers(dayTrades, candles, tf);
    const openTimeS = new Date(`${dateISO}T${String(9+utcOffset).padStart(2,'0')}:30:00Z`).getTime()/1000;
    const openCandle = candles.find(c => c.time >= openTimeS);
    if (openCandle) markers.push({ time:openCandle.time, position:'aboveBar', shape:'arrowDown', color:'#ffffff', text:'◀ OPEN 9:30', size:0 });
    const seen = {};
    markers.sort((a,b)=>a.time-b.time).forEach(m => { const k=`${m.time}-${m.position}`; if(seen[k]) m.time+=1; seen[k]=true; });
    try { candleSeries.setMarkers(markers.sort((a,b)=>a.time-b.time)); } catch(e){}
    dayTrades.forEach(tr => {
    });
  }

  chart.timeScale().fitContent();
  _nicInstances[bid] = { ..._nicInstances[bid], chart, rawBars, tf };

  const ro = new ResizeObserver(() => { if (chart) chart.applyOptions({ width:body.clientWidth, height:body.clientHeight }); });
  ro.observe(body);
}

function nicSetTF(bid, symbol, dateISO, tf) {
  // Update active button
  [1,5,15].forEach(t => {
    const btn = document.getElementById(`nic-${bid}-tf${t}`);
    if (btn) btn.classList.toggle('active', t===tf);
  });
  if (_nicInstances[bid]?.rawBars) {
    const nota = getNota(notaActiveId);
    const blk  = nota?.blocks.find(x => x.id === bid);
    const refSymbol  = blk?.tradeGroup?.symbol  || blk?.tradeRef?.symbol;
    const refDateISO = blk?.tradeGroup?.dateISO || blk?.tradeRef?.dateISO;
    const tRef = refSymbol && refDateISO ? { symbol: refSymbol, dateISO: refDateISO } : null;
    nicDrawChart(bid, _nicInstances[bid].rawBars, tf, tRef);
  } else {
    nicLoad(bid, symbol, dateISO, tf);
  }
}

function renderTagsBar(nota) {
  const bar = document.getElementById('notas-tags-bar');
  const activeTags = nota.tags || [];
  bar.innerHTML = ALL_TAGS.map(t => {
    const c = TAG_COLORS[t];
    const active = activeTags.includes(t);
    return `<button class="nota-tag-btn" style="background:${active?c.bg:'var(--bg3)'};color:${active?c.text:'var(--dim)'};border:1px solid ${active?c.text+'44':'transparent'}"
      onclick="notaToggleTag('${t}')">${t}</button>`;
  }).join('');
}

function notaTitleChange(el) {
  const nota = getNota(notaActiveId); if (!nota) return;
  nota.title = el.value;
  nota.updated = Date.now();
  autoResize(el);
  debounceSave();
  renderNotasBigCal();
  renderNotasList();
}

function notaTitleKeydown(e) {
  if (e.key === 'Enter') { e.preventDefault(); notaInsertBlock('text'); }
}

function notaBlockChange(el) {
  const nota = getNota(notaActiveId); if (!nota) return;
  const b = nota.blocks.find(b=>b.id===el.dataset.id); if (!b) return;
  b.content = el.value;
  nota.updated = Date.now();
  autoResize(el);
  debounceSave();
  renderNotasList();
}

function notaBlockKeydown(e, el) {
  const nota = getNota(notaActiveId); if (!nota) return;
  const bid = el.dataset.id;
  const idx = nota.blocks.findIndex(b=>b.id===bid);

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const newId = blkId();
    const curType = nota.blocks[idx].type;
    // Continue bullet lists, otherwise text
    const newType = curType === 'bullet' && nota.blocks[idx].content ? 'bullet' : 'text';
    nota.blocks.splice(idx+1, 0, {id:newId, type:newType, content:''});
    nota.updated = Date.now();
    renderBlocks(nota);
    setTimeout(() => {
      const ta = document.querySelector(`.nota-block-input[data-id="${newId}"]`);
      if (ta) ta.focus();
    }, 10);
    debounceSave();
  } else if (e.key === 'Backspace' && el.value === '' && nota.blocks.length > 1) {
    e.preventDefault();
    nota.blocks.splice(idx, 1);
    nota.updated = Date.now();
    renderBlocks(nota);
    setTimeout(() => {
      const prev = nota.blocks[Math.max(0,idx-1)];
      const ta = document.querySelector(`.nota-block-input[data-id="${prev?.id}"]`);
      if (ta) { ta.focus(); ta.selectionStart = ta.value.length; }
    }, 10);
    debounceSave();
  } else if (e.key === 'ArrowUp') {
    const prev = nota.blocks[idx-1];
    if (prev) { const ta = document.querySelector(`.nota-block-input[data-id="${prev.id}"]`); ta?.focus(); }
  } else if (e.key === 'ArrowDown') {
    const next = nota.blocks[idx+1];
    if (next) { const ta = document.querySelector(`.nota-block-input[data-id="${next.id}"]`); ta?.focus(); }
  } else if (e.key === '/' && el.value === '') {
    e.preventDefault();
    showBlockMenu(e, bid);
  } else if (e.key === '@') {
    e.preventDefault();
    showTradeMentionMenu(e, bid);
  }
}

function notaInsertBlock(type) {
  const nota = getNota(notaActiveId); if (!nota) return;
  const newId = blkId();
  nota.blocks.push({id:newId, type, content:''});
  nota.updated = Date.now();
  renderBlocks(nota);
  setTimeout(() => {
    const ta = document.querySelector(`.nota-block-input[data-id="${newId}"]`);
    if (ta) ta.focus();
  }, 10);
  debounceSave();
}

function insertPlantilla(tipo) {
  const nota = getNota(notaActiveId); if (!nota) return;
  const semana = [
    '🏆 Mejor play y por qué:',
    '💀 Peor play y por qué:',
    '🔧 ¿Qué mejorar?',
    '✅ ¿Qué he hecho bien?',
    '📌 ¿Qué recordar mañana?',
  ];
  const finde = [
    '🌍 Entorno de mercado esta semana:',
    '🎯 Plays que mejor han funcionado:',
    '⚠️ Con qué tener cuidado la semana que viene:',
    '📚 ¿Qué he aprendido esta semana?',
    '🚀 Objetivo / foco para la próxima semana:',
  ];
  const preguntas = tipo === 'finde' ? finde : semana;
  const titulo    = tipo === 'finde' ? '📅 Reflexión semanal' : '📅 Reflexión del día';
  // Insert a divider, then a H2 title, then one h3+text pair per question
  nota.blocks.push({ id: blkId(), type: 'divider', content: '' });
  nota.blocks.push({ id: blkId(), type: 'h2', content: titulo });
  let lastId;
  preguntas.forEach(q => {
    nota.blocks.push({ id: blkId(), type: 'h3', content: q });
    lastId = blkId();
    nota.blocks.push({ id: lastId, type: 'text', content: '' });
  });
  nota.updated = Date.now();
  renderBlocks(nota);
  setTimeout(() => {
    const ta = document.querySelector(`.nota-block-input[data-id="${lastId}"]`);
    if (ta) ta.focus();
  }, 30);
  debounceSave();
}

function notaDeleteBlock(bid) {
  const nota = getNota(notaActiveId); if (!nota) return;
  if (nota.blocks.length <= 1) { nota.blocks[0].content=''; renderBlocks(nota); return; }
  nota.blocks = nota.blocks.filter(b=>b.id!==bid);
  nota.updated = Date.now();
  renderBlocks(nota);
  debounceSave();
}

function notaToggleTag(tag) {
  const nota = getNota(notaActiveId); if (!nota) return;
  const idx = nota.tags.indexOf(tag);
  if (idx>=0) nota.tags.splice(idx,1); else nota.tags.push(tag);
  nota.updated = Date.now();
  renderTagsBar(nota);
  renderNotasList();
  debounceSave();
}

function notaDelete() {
  if (!notaActiveId) return;
  const nota = getNota(notaActiveId);
  const title = nota?.title || 'Sin título';
  if (!confirm(`¿Eliminar "${title}"?`)) return;
  notas = notas.filter(n=>n.id!==notaActiveId);
  notaActiveId = notas[0]?.id || null;
  saveNotas();
  renderNotas();
}

function toggleNotaDatePicker(id) {
  const picker = document.getElementById('nota-date-picker');
  if (!picker) return;
  if (picker.style.display === 'none') {
    picker.style.display = '';
    picker.focus();
    picker.showPicker?.();
  } else {
    picker.style.display = 'none';
  }
}

function setNotaDate(id, dateISO) {
  const nota = getNota(id);
  if (!nota || !dateISO) return;
  nota.noteDate = dateISO;
  nota.updated = Date.now();
  document.getElementById('nota-date-picker').style.display = 'none';
  const dateFmt = new Date(dateISO+'T12:00:00').toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const lbl = document.getElementById('nota-date-label');
  if (lbl) lbl.textContent = dateFmt;
  debounceSave();
  renderNotasList();
  renderNotasBigCal();
}

function notaDateISO(n) {
  if (n.noteDate) return n.noteDate;
  const d = new Date(n.updated);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function notasSearch(q) { notasSearchQ = q; renderNotasList(); }

// Block type menu (shown on ⋮⋮ click or / key)
let blockMenuTarget = null;
// ── Block drag-and-drop reordering ────────────────────────
let _dragBid = null;

function blockDragStart(e, bid) {
  _dragBid = bid;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', bid);
  setTimeout(() => e.target.closest('[data-id]')?.classList.add('dragging'), 0);
}

function blockDragEnd(e) {
  _dragBid = null;
  document.querySelectorAll('.nota-block').forEach(el => {
    el.classList.remove('dragging','drag-over-top','drag-over-bottom');
  });
}

function blockDragOver(e, bid) {
  if (!_dragBid || _dragBid === bid) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  const mid  = rect.top + rect.height / 2;
  el.classList.toggle('drag-over-top',    e.clientY < mid);
  el.classList.toggle('drag-over-bottom', e.clientY >= mid);
}

function blockDragLeave(e) {
  e.currentTarget.classList.remove('drag-over-top','drag-over-bottom');
}

function blockDrop(e, targetBid) {
  e.preventDefault();
  const fromBid = _dragBid;
  if (!fromBid || fromBid === targetBid) return;
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  const insertBefore = e.clientY < rect.top + rect.height / 2;
  el.classList.remove('drag-over-top','drag-over-bottom');

  const nota = getNota(notaActiveId);
  if (!nota) return;
  const fromIdx = nota.blocks.findIndex(b => b.id === fromBid);
  const toIdx   = nota.blocks.findIndex(b => b.id === targetBid);
  if (fromIdx < 0 || toIdx < 0) return;

  const [moved] = nota.blocks.splice(fromIdx, 1);
  const newTo   = nota.blocks.findIndex(b => b.id === targetBid);
  nota.blocks.splice(insertBefore ? newTo : newTo + 1, 0, moved);
  nota.updated = Date.now();
  renderBlocks(nota);
  debounceSave();
}

function showBlockMenu(e, bid) {
  document.getElementById('nota-block-type-menu')?.remove();
  blockMenuTarget = bid;
  const types = [
    {type:'text',  icon:'¶', label:'Texto'},
    {type:'h1',    icon:'H1',label:'Título 1'},
    {type:'h2',    icon:'H2',label:'Título 2'},
    {type:'h3',    icon:'H3',label:'Título 3'},
    {type:'bullet',icon:'•', label:'Lista'},
    {type:'quote', icon:'"', label:'Cita'},
    {type:'code',  icon:'⌨', label:'Código'},
    {type:'divider',icon:'—',label:'Separador'},
  ];
  const menu = document.createElement('div');
  menu.id = 'nota-block-type-menu';
  menu.className = 'nota-block-type-menu';
  menu.innerHTML = types.map(t =>
    `<div class="nota-block-type-item" onclick="changeBlockType('${bid}','${t.type}')">
      <span class="nota-block-type-icon">${t.icon}</span>${t.label}
    </div>`
  ).join('');
  menu.style.left = (e.clientX||e.pageX) + 'px';
  menu.style.top  = (e.clientY||e.pageY) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closeBlockMenu, {once:true}), 10);
}
function closeBlockMenu() { document.getElementById('nota-block-type-menu')?.remove(); }
function changeBlockType(bid, type) {
  const nota = getNota(notaActiveId); if (!nota) return;
  const b = nota.blocks.find(b=>b.id===bid); if (!b) return;
  b.type = type;
  if (type === 'divider') b.content = '';
  nota.updated = Date.now();
  renderBlocks(nota);
  debounceSave();
  closeBlockMenu();
}

// ── Trade Mention Picker ──
let _mentionTargetBid = null;
let _mentionSelectedIdx = 0;

function notaInsertTradeMention() {
  // Insert from toolbar button — add after last block
  const nota = getNota(notaActiveId); if (!nota) return;
  const lastBid = nota.blocks[nota.blocks.length - 1]?.id;
  showTradeMentionMenu({ clientX: 240, clientY: 200 }, lastBid);
}

function showTradeMentionMenu(e, bid) {
  closeTradeMentionMenu();
  _mentionTargetBid = bid;
  _mentionSelectedIdx = 0;

  const menu = document.createElement('div');
  menu.id = 'trade-mention-menu';
  menu.className = 'trade-mention-menu';
  menu.innerHTML = `
    <div class="trade-mention-search">
      <input id="trade-mention-input" type="text" placeholder="Buscar por ticker, fecha…" autocomplete="off"
        oninput="tradeMentionFilter(this.value)"
        onkeydown="tradeMentionKeydown(event)">
    </div>
    <div id="trade-mention-results"></div>`;

  menu.style.left = Math.min(e.clientX, window.innerWidth - 300) + 'px';
  menu.style.top  = Math.min(e.clientY + 10, window.innerHeight - 280) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => {
    document.getElementById('trade-mention-input')?.focus();
    tradeMentionFilter('');
    document.addEventListener('click', closeTradeMentionOnOutside);
  }, 20);
}

function closeTradeMentionOnOutside(e) {
  if (!document.getElementById('trade-mention-menu')?.contains(e.target)) {
    closeTradeMentionMenu();
  }
}
function closeTradeMentionMenu() {
  document.getElementById('trade-mention-menu')?.remove();
  document.removeEventListener('click', closeTradeMentionOnOutside);
}

function buildTradeGroups() {
  // Group trades by symbol + dateISO + type → one group per stock per day per side
  const map = {};
  trades.forEach(t => {
    const key = `${t.symbol}|${t.dateISO}|${(t.type||'').toLowerCase()}`;
    if (!map[key]) map[key] = { symbol:t.symbol, dateISO:t.dateISO, type:t.type, trades:[], totalNet:0, totalQty:0 };
    map[key].trades.push(t);
    map[key].totalNet += (t.net || 0);
    map[key].totalQty += (t.qty || 0);
  });
  return Object.values(map);
}

function tradeMentionFilter(q) {
  const lq = q.toLowerCase().trim();
  let groups = buildTradeGroups();
  if (lq) {
    groups = groups.filter(g =>
      g.symbol?.toLowerCase().includes(lq) ||
      g.dateISO?.includes(lq)
    );
  }
  // Sort by date desc
  groups = groups.sort((a,b) => b.dateISO.localeCompare(a.dateISO)).slice(0, 40);
  _mentionSelectedIdx = 0;

  const el = document.getElementById('trade-mention-results');
  if (!el) return;
  if (!groups.length) { el.innerHTML = `<div class="trade-mention-empty">Sin resultados</div>`; return; }

  el.innerHTML = groups.map((g, i) => {
    const isShort   = g.type?.toLowerCase() === 'short';
    const typeColor = isShort ? '#e05252' : '#2dba6f';
    const pnlColor  = g.totalNet >= 0 ? '#2dba6f' : '#e05252';
    const pnlStr    = (g.totalNet>=0?'+$':'-$') + Math.abs(g.totalNet).toFixed(2);
    const execLabel = g.trades.length > 1 ? `${g.trades.length} exec` : `1 exec`;
    return `<div class="trade-mention-item ${i===0?'selected':''}" data-idx="${i}"
        onclick="insertTradeMention(${i})"
        onmouseover="tradeMentionHover(${i})">
      <span style="font-weight:700;color:var(--amber)">${g.symbol}</span>
      <span style="color:var(--dim);font-size:10px">${g.dateISO}</span>
      <span style="background:${typeColor}22;color:${typeColor};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700">${isShort?'SHORT':'LONG'} <span style="opacity:.7">${execLabel}</span></span>
      <span style="color:${pnlColor};font-weight:700">${pnlStr}</span>
    </div>`;
  }).join('');
  el._results = groups;
}

function tradeMentionHover(idx) {
  _mentionSelectedIdx = idx;
  document.querySelectorAll('.trade-mention-item').forEach((el, i) => {
    el.classList.toggle('selected', i === idx);
  });
}

function tradeMentionKeydown(e) {
  const items = document.querySelectorAll('.trade-mention-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _mentionSelectedIdx = Math.min(_mentionSelectedIdx+1, items.length-1);
    items.forEach((el,i)=>el.classList.toggle('selected',i===_mentionSelectedIdx));
    items[_mentionSelectedIdx]?.scrollIntoView({block:'nearest'});
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _mentionSelectedIdx = Math.max(_mentionSelectedIdx-1, 0);
    items.forEach((el,i)=>el.classList.toggle('selected',i===_mentionSelectedIdx));
    items[_mentionSelectedIdx]?.scrollIntoView({block:'nearest'});
  } else if (e.key === 'Enter') {
    e.preventDefault();
    insertTradeMention(_mentionSelectedIdx);
  } else if (e.key === 'Escape') {
    closeTradeMentionMenu();
  }
}

function insertTradeMention(idx) {
  // Allow reflexiones to override insertion
  if (window._mentionInsertFn) { window._mentionInsertFn(idx); return; }

  const el = document.getElementById('trade-mention-results');
  const g = el?._results?.[idx]; if (!g) return;
  const nota = getNota(notaActiveId); if (!nota) return;

  const targetIdx = nota.blocks.findIndex(b=>b.id===_mentionTargetBid);
  const targetBlock = nota.blocks[targetIdx];
  const newBlock = { id: blkId(), type: 'trade-ref', content: '', tradeGroup: g };

  if (targetBlock && targetBlock.type === 'text' && !targetBlock.content.trim()) {
    nota.blocks.splice(targetIdx, 1, newBlock);
  } else {
    const insertAt = targetIdx >= 0 ? targetIdx + 1 : nota.blocks.length;
    nota.blocks.splice(insertAt, 0, newBlock);
  }
  if (!nota.linkedTrades) nota.linkedTrades = [];
  const key = `${g.symbol}|${g.dateISO}`;
  if (!nota.linkedTrades.includes(key)) nota.linkedTrades.push(key);

  nota.updated = Date.now();
  renderBlocks(nota);
  renderNotasList();
  debounceSave();
  closeTradeMentionMenu();
  // Auto-expand chart
  setTimeout(() => nicToggle(newBlock.id, g.symbol, g.dateISO), 80);
}
function blkId() { return 'b' + Math.random().toString(36).slice(2,8); }
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function autoResize(el) {
  if (!el || el.tagName!=='TEXTAREA') return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
let _saveTimer = null;
function debounceSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => saveNotas(), 800);
}

// ═══════════════════════════════
// DAILY JOURNAL
// ═══════════════════════════════
let dayNotes = {}; // { 'YYYY-MM-DD': { mood, notes, lessons } }
let journalDateOpen = null;

async function loadDayNotes() {
  try { const _r = await fetch('/api/store/day_notes'); dayNotes = (_r.ok ? await _r.json() : null) ?? {}; } catch(e) { dayNotes = {}; }
}
async function saveDayNotes() {
  try { await fetch('/api/store/day_notes', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(dayNotes) }); } catch(e) {}
}


const JNL_QUESTIONS_WEEKDAY = [
  { key: 'q_mejor',    label: '🏆 Mejor play y por qué' },
  { key: 'q_peor',     label: '💀 Peor play y por qué' },
  { key: 'q_mejorar',  label: '🔧 ¿Qué mejorar?' },
  { key: 'q_bien',     label: '✅ ¿Qué he hecho bien?' },
  { key: 'q_mañana',   label: '📌 ¿Qué recordar mañana?' },
];

const JNL_QUESTIONS_WEEKEND = [
  { key: 'q_entorno',  label: '🌍 Entorno de mercado esta semana' },
  { key: 'q_plays',    label: '🎯 Plays que mejor han funcionado' },
  { key: 'q_cuidado',  label: '⚠️ Con qué tener cuidado la semana que viene' },
  { key: 'q_aprendido',label: '📚 ¿Qué he aprendido esta semana?' },
  { key: 'q_objetivo', label: '🚀 Objetivo / foco para la próxima semana' },
];

function renderJournalTemplate(iso, entry) {
  const d = new Date(iso + 'T12:00:00');
  const dow = d.getDay(); // 0=Sun, 6=Sat
  const isWeekend = dow === 0 || dow === 6;
  const questions = isWeekend ? JNL_QUESTIONS_WEEKEND : JNL_QUESTIONS_WEEKDAY;
  const title = isWeekend ? 'Reflexión semanal' : 'Reflexión del día';
  document.getElementById('jnl-template-title').textContent = title;
  document.getElementById('jnl-template-fields').innerHTML = questions.map(q =>
    `<div class="jnl-q">
      <label class="jnl-q-label">${q.label}</label>
      <textarea id="jnl-tpl-${q.key}" placeholder="Escribe aquí...">${entry[q.key] || ''}</textarea>
    </div>`
  ).join('');
}

function getTemplateValues(iso) {
  const d = new Date(iso + 'T12:00:00');
  const dow = d.getDay();
  const isWeekend = dow === 0 || dow === 6;
  const questions = isWeekend ? JNL_QUESTIONS_WEEKEND : JNL_QUESTIONS_WEEKDAY;
  const out = {};
  questions.forEach(q => {
    const el = document.getElementById('jnl-tpl-' + q.key);
    if (el) out[q.key] = el.value.trim();
  });
  return out;
}

function openJournal(iso) {
  journalDateOpen = iso;
  const entry = dayNotes[iso] || {};

  // Header
  const d = new Date(iso + 'T12:00:00');
  const days = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  document.getElementById('jnl-date').textContent = days[d.getDay()] + ' ' + d.getDate() + '/' + (d.getMonth()+1) + '/' + d.getFullYear();

  // Summary
  const dayTrades = trades.filter(t => t.dateISO === iso);
  const net = dayTrades.reduce((s,t)=>s+t.net,0);
  const wins = dayTrades.filter(t=>t.resultado==='P').length;
  document.getElementById('jnl-summary').textContent =
    `${dayTrades.length} trades · ${wins}W/${dayTrades.length-wins}L · ${net>=0?'+$':'-$'}${Math.abs(net).toFixed(2)}`;

  // Trade list
  document.getElementById('jnl-trades').innerHTML = dayTrades
    .sort((a,b)=>a.openedHour?.localeCompare(b.openedHour))
    .map(t => {
      const col = t.net>=0?'var(--green)':'var(--red)';
      const typeCol = t.type?.toLowerCase()==='short'?'var(--red)':'var(--green)';
      return `<div class="journal-trade-row">
        <span style="color:var(--dim)">${t.openedHour?.slice(0,5)||'—'}</span>
        <span style="color:var(--amber);font-weight:700">${t.symbol}</span>
        <span style="color:${typeCol}">${t.type?.toUpperCase()||'LONG'}</span>
        <span>$${t.entry?.toFixed(2)} → $${t.exit?.toFixed(2)}</span>
        <span style="color:${col};font-weight:700">${t.net>=0?'+':''}$${t.net?.toFixed(2)}</span>
        <span style="color:var(--dim);font-size:10px">${t.patron||''}</span>
      </div>`;
    }).join('');

  // Mood
  document.querySelectorAll('.journal-mood-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mood === entry.mood);
  });

  // Text fields
  document.getElementById('jnl-notes').value    = entry.notes    || '';
  document.getElementById('jnl-lessons').value  = entry.lessons  || '';

  renderJournalTemplate(iso, entry);
  document.getElementById('journal-overlay').classList.add('open');
}

function selectMood(mood) {
  document.querySelectorAll('.journal-mood-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mood === mood);
  });
}

async function saveJournalEntry() {
  if (!journalDateOpen) return;
  const activeMood = document.querySelector('.journal-mood-btn.active');
  dayNotes[journalDateOpen] = {
    mood:    activeMood ? activeMood.dataset.mood : '',
    notes:   document.getElementById('jnl-notes').value.trim(),
    lessons: document.getElementById('jnl-lessons').value.trim(),
    saved:   new Date().toISOString(),
    ...getTemplateValues(journalDateOpen),
  };
  await saveDayNotes();
  renderCalendario(); // refresh note indicator
  toast('Notas guardadas ✓', 'ok');
}

function closeJournal() {
  document.getElementById('journal-overlay').classList.remove('open');
  journalDateOpen = null;
}

// ═══════════════════════════════
// BOOT
// ═══════════════════════════════
(async () => {
  await load();
  await loadDayNotes();
  await loadNotas();
  await loadDASPreview();
  loadMassiveKey();
  if (trades.length) renderAll();
})();
