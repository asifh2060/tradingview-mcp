import { evaluate } from '../src/connection.js';
import { setSymbol, setTimeframe } from '../src/core/chart.js';
import { getQuote, getOhlcv } from '../src/core/data.js';

const SYMBOLS = [
  { ticker: 'PARKIN',      sym: 'DFM:PARKIN'      },
  { ticker: 'SALIK',      sym: 'DFM:SALIK'        },
  { ticker: 'AIRARABIA',  sym: 'DFM:AIRARABIA'    },
  { ticker: 'ADNOCDRILL', sym: 'ADX:ADNOCDRILL'   },
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForChart(maxMs = 7000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(700);
    try {
      const ok = await evaluate(`(function(){ return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().length > 0; })()`);
      if (ok) break;
    } catch(e) {}
  }
  await sleep(1000);
}

// Read all data sources in order — no crosshair needed; values are available at last bar
async function readAllSources() {
  return await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      var out = [];
      for(var si=0;si<sources.length;si++){
        var s=sources[si];
        if(!s.metaInfo||!s.dataWindowView) continue;
        try{
          var name=s.metaInfo().description||'';
          var items=s.dataWindowView().items()||[];
          var vals={};
          for(var i=0;i<items.length;i++){
            if(items[i]._title&&items[i]._value&&items[i]._value!=='∅')
              vals[items[i]._title]=items[i]._value;
          }
          out.push({idx:si,name:name,vals:vals});
        }catch(e){}
      }
      return out;
    })()
  `) || [];
}

function n(str) { return str ? (parseFloat(String(str).replace(/[^\d.\-]/g,'')) || null) : null; }
function volNum(str) {
  if (!str) return null;
  const s = String(str).replace(/\s/g,'');
  return /K/i.test(s) ? parseFloat(s)*1e3 : /M/i.test(s) ? parseFloat(s)*1e6 : parseFloat(s)||null;
}

// RSI-14 from close price array
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  if (avgG === 0) return 0;
  return 100 - 100 / (1 + avgG / avgL);
}

// ─── Scan ─────────────────────────────────────────────────────────────────────
const rows = [];

for (const { ticker, sym } of SYMBOLS) {
  process.stderr.write(`[${ticker}] `);
  await setSymbol({ symbol: sym, _deps: { evaluate } });
  await setTimeframe({ timeframe: '5', _deps: { evaluate } });
  await waitForChart();

  // Quote
  let price = null;
  try { const q = await getQuote({ _deps: { evaluate } }); price = q.last || q.close || q.price; } catch(e) {}

  // OHLCV for RSI + Vol MA (30 bars = enough for RSI-14 + 20-bar vol MA)
  let closes = [], volBars = [];
  try {
    const ohlcv = await getOhlcv({ count: 30 });
    if (ohlcv && ohlcv.bars) {
      closes = ohlcv.bars.map(b => b.close);
      volBars = ohlcv.bars.map(b => b.volume);
      if (!price && closes.length) price = closes[closes.length - 1];
    }
  } catch(e) { process.stderr.write(`ohlcv_err:${e.message} `); }

  // Read all data sources (no crosshair needed — last-bar values available directly)
  const entries = await readAllSources();
  const names = entries.map(e => e.name.replace('Moving Average Exponential','EMA').replace('Moving Average Convergence Divergence','MACD').replace('Volume Weighted Average Price','VWAP').replace('Relative Strength Index','RSI'));
  process.stderr.write(`entries=[${names.join(',')}]\n`);

  const byName = (name) => entries.find(e => e.name === name);
  const emaEntries = entries.filter(e => e.name === 'Moving Average Exponential');

  const vwapV  = n((byName('Volume Weighted Average Price')?.vals || {})['VWAP']);
  const ema9V  = n((emaEntries[0]?.vals || {})['MA']);
  const ema21V = n((emaEntries[1]?.vals || {})['MA']);

  const macdVals = byName('Moving Average Convergence Divergence')?.vals || {};
  const macdH = n(macdVals['Histogram'] || macdVals['Hist']);

  const volVals = byName('Volume')?.vals || {};
  const volV    = volNum(volVals['Volume'] || volVals['Vol'] || Object.values(volVals)[0]);
  const volMADW = volNum(volVals['MA'] || volVals['Vol MA'] || null);

  const rsiVals = byName('Relative Strength Index')?.vals || {};
  const rsiDW   = n(rsiVals['RSI'] || rsiVals['Value'] || Object.values(rsiVals)[0]);
  const rsiV    = rsiDW ?? (closes.length > 14 ? calcRSI(closes) : null);

  // Vol spike multiplier
  const volMA20 = volMADW ?? (volBars.length >= 20
    ? volBars.slice(-20).reduce((a,b)=>a+b,0) / 20
    : null);
  const volSpikeMult = (volV && volMA20 && volMA20 > 0) ? volV / volMA20 : null;

  // ── Format ────────────────────────────────────────────────────────────────
  const vsVwap = (price && vwapV)
    ? ((price - vwapV) / vwapV * 100 >= 0 ? '▲ +' : '▼ ')
      + Math.abs((price - vwapV) / vwapV * 100).toFixed(2) + '%'
    : 'N/A';

  let cross = 'N/A';
  if (ema9V !== null && ema21V !== null) {
    const diff = ema9V - ema21V;
    cross = Math.abs(diff) < 0.001 ? '═ Flat' : diff > 0 ? '▲ 9>21 BULL' : '▼ 9<21 BEAR';
  } else if (ema9V !== null) {
    cross = `9>21? (EMA9=${ema9V.toFixed(3)})`;
  }

  const rsiLabel = rsiV !== null
    ? `${rsiV.toFixed(1)}${rsiV >= 70 ? ' OB' : rsiV <= 30 ? ' OS' : ''}`
    : 'N/A';

  const macdLabel = macdH !== null
    ? (macdH > 0 ? `▲ +${macdH.toFixed(4)}` : `▼ ${macdH.toFixed(4)}`)
    : 'N/A';

  let volLabel = 'N/A';
  if (volSpikeMult !== null) {
    const tag = volSpikeMult > 2 ? ' SPIKE' : volSpikeMult > 1.5 ? ' HIGH' : ' avg';
    volLabel = `${volSpikeMult.toFixed(1)}x${tag}`;
  } else if (volV) {
    volLabel = volV >= 1e6 ? `${(volV/1e6).toFixed(2)}M` : `${Math.round(volV/1e3)}K`;
  }

  rows.push({
    ticker, price, vsVwap, cross, rsiLabel, macdLabel, volLabel,
    _d: { vwapV, ema9V, ema21V, rsiV, macdH, volV, volMA20, volSpikeMult },
  });
}

console.log(JSON.stringify(rows, null, 2));
