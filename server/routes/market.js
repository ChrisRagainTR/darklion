"use strict";
const { Router } = require("express");
const router = Router();

// In-memory cache: { data, fetchedAt }
let _tickerCache = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const SYMBOLS = [
  { key: "sp500",   symbol: "SPY",              label: "S&P 500",  type: "etf" },
  { key: "dow",     symbol: "DIA",              label: "Dow",      type: "etf" },
  { key: "nasdaq",  symbol: "QQQ",              label: "Nasdaq",   type: "etf" },
  { key: "btc",     symbol: "BINANCE:BTCUSDT",  label: "Bitcoin",  type: "crypto" },
  { key: "gold",    symbol: "GLD",              label: "Gold",     type: "etf" },
  { key: "oil",     symbol: "USO",              label: "Oil",      type: "etf" },
  { key: "vix",     symbol: "UVXY",             label: "VIX",      type: "etf" },
];

async function fetchQuote(apiKey, symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub error: ${res.status}`);
  return res.json(); // { c: current, d: change, dp: changePct, h: high, l: low, o: open, pc: prevClose }
}

// GET /api/market/ticker — returns cached market data
router.get("/ticker", async (req, res) => {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return res.json({ available: false });

  // Return cache if fresh
  if (_tickerCache && (Date.now() - _tickerCache.fetchedAt) < CACHE_TTL_MS) {
    return res.json({ available: true, items: _tickerCache.data, cachedAt: _tickerCache.fetchedAt });
  }

  try {
    const results = await Promise.allSettled(
      SYMBOLS.map(async s => {
        const q = await fetchQuote(apiKey, s.symbol);
        return {
          key: s.key,
          label: s.label,
          type: s.type,
          price: q.c,
          change: q.d,
          changePct: q.dp,
          prevClose: q.pc,
        };
      })
    );

    const items = results
      .map((r, i) => r.status === "fulfilled" ? r.value : { ...SYMBOLS[i], price: null, change: null, changePct: null })
      .filter(item => item.price !== null && item.price !== 0);

    _tickerCache = { data: items, fetchedAt: Date.now() };
    res.json({ available: true, items, cachedAt: _tickerCache.fetchedAt });
  } catch (err) {
    console.error("[market] ticker fetch error:", err.message);
    res.json({ available: false });
  }
});

module.exports = router;
