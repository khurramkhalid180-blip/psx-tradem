// PSX TradeMind — Vercel Serverless Proxy v6.4
// Node 20 / CommonJS

const PSX = 'https://dps.psx.com.pk';

const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://dps.psx.com.pk/',
  'Origin':          'https://dps.psx.com.pk',
  'Cache-Control':   'no-cache',
};

function sendJSON(res, status, payload) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');
  res.status(status).end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  // Set headers immediately — even before any await — so Vercel never falls through to its 404 page
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') {
    return res.status(200).end('{}');
  }

  // Health check — useful to confirm the function is reachable
  if (req.query.ep === 'health') {
    return sendJSON(res, 200, { ok: true, msg: 'PSX TradeMind API alive', ts: Date.now() });
  }

  const ep  = String(req.query.ep  || 'market-watch').toLowerCase().trim();
  const sym = String(req.query.sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const URL_MAP = {
    'market-watch':  `${PSX}/market-watch`,
    'announcements': `${PSX}/announcements/companies`,
    'payouts':       `${PSX}/payouts`,
    'eod':           sym ? `${PSX}/timeseries/eod/${sym}` : null,
    'intraday':      sym ? `${PSX}/timeseries/int/${sym}` : null,
  };

  const url = URL_MAP[ep];
  if (!url) {
    return sendJSON(res, 400, { ok: false, error: `Unknown endpoint: ${ep}` });
  }

  try {
    const timeoutMs = 18000;
    const fetchPromise = fetch(url, { headers: BROWSER_HEADERS });
    const timer = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`PSX timed out after ${timeoutMs}ms`)), timeoutMs)
    );

    const r = await Promise.race([fetchPromise, timer]);

    if (!r.ok) {
      return sendJSON(res, 200, {
        ok: false,
        error: `PSX HTTP ${r.status}: ${r.statusText}`,
        endpoint: ep,
        ts: Date.now(),
      });
    }

    const ct = r.headers.get('content-type') || '';
    const text = await r.text();

    // JSON timeseries endpoints
    if (ct.includes('json') || ep === 'eod' || ep === 'intraday') {
      let data;
      try { data = JSON.parse(text); }
      catch { return sendJSON(res, 200, { ok: false, error: 'PSX returned non-JSON for ' + ep, snippet: text.slice(0, 200), ts: Date.now() }); }
      return sendJSON(res, 200, { ok: true, data, ts: Date.now() });
    }

    // market-watch HTML
    if (ep === 'market-watch') {
      const prices = parseMarketWatch(text);
      const cnt = Object.keys(prices).length;
      if (cnt < 5) {
        return sendJSON(res, 200, {
          ok: false,
          error: `HTML parser found only ${cnt} symbols`,
          html_length: text.length,
          snippet: text.slice(0, 400),
          ts: Date.now(),
        });
      }
      return sendJSON(res, 200, { ok: true, prices, count: cnt, ts: Date.now() });
    }

    return sendJSON(res, 200, { ok: true, html: text.slice(0, 60000), ts: Date.now() });

  } catch (err) {
    return sendJSON(res, 200, {
      ok: false,
      error: err.message || 'Unknown error',
      endpoint: ep,
      ts: Date.now(),
    });
  }
};

function parseMarketWatch(html) {
  const prices = {};
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const rowRe = /<tr[\s\S]*?>([\s\S]*?)<\/tr>/gi;
  let rowM;
  while ((rowM = rowRe.exec(clean)) !== null) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellM;
    while ((cellM = cellRe.exec(rowM[1])) !== null) {
      cells.push(
        cellM[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim()
      );
    }
    if (cells.length < 9) continue;
    const sym = cells[0].replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (!sym || sym.length < 2 || sym.length > 12) continue;
    const ldcp = pf(cells[3]);
    let curr = pf(cells[7]);
    // Some symbols (suspended, no recent trade, pre-open auction) report a
    // blank/zero "Current" price while still showing a valid LDCP. Previously
    // these rows were dropped entirely, leaving the symbol's price stuck at
    // whatever was last fetched — silently stale with no indication to the
    // user. Fall back to LDCP so the symbol still gets an update each cycle.
    let stale = false;
    if (curr <= 0.01) {
      if (ldcp > 0.01) { curr = ldcp; stale = true; }
      else continue; // genuinely no usable price data for this row
    }
    {
      prices[sym] = {
        price: curr,
        ldcp,
        open:      pf(cells[4]),
        high:      pf(cells[5]),
        low:       pf(cells[6]),
        change:    stale ? 0 : pf(cells[8]),
        changePct: stale ? 0 : pf(String(cells[9] || '').replace('%', '')),
        volume:    pf(String(cells[10] || '').replace(/,/g, '')),
        stale,
      };
    }
  }
  return prices;
}

function pf(v) {
  const n = parseFloat(String(v || '').replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}
