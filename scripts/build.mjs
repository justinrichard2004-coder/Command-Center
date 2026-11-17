// Command Center Lite — data builder. Runs on GitHub Actions every 30 minutes, no dependencies (Node 20+).
// Writes docs/data.json, which the dashboard (docs/index.html) reads. If a source fails, the last good
// value is kept, so the dashboard never goes blank.
import { readFile, writeFile } from 'node:fs/promises';

const UA = 'CommandCenterLite/1.0 (personal research dashboard; github actions)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = new URL('../docs/data.json', import.meta.url);
const WATCH = JSON.parse(await readFile(new URL('../watchlist.json', import.meta.url), 'utf8'));
let prev = {}; try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}

async function get(url, { json = true, ms = 30000 } = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 80)}`);
  const t = await r.text();
  if (!json) return t;
  try { return JSON.parse(t); } catch { throw new Error(`not JSON: ${t.slice(0, 80)}`); }
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- RSS ----------
const dec = t => String(t || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
function parseRSS(x, fallbackSource) {
  return [...x.matchAll(/<item\b[\s\S]*?<\/item>/g)].map(m => {
    const g = t => dec((m[0].match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);
    const src = m[0].match(/<source[^>]*>([\s\S]*?)<\/source>/);
    const d = new Date(g('pubDate') || g('dc:date'));
    let title = g('title'); const source = src ? dec(src[1]) : fallbackSource;
    if (src) title = title.replace(new RegExp(` - ${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
    return { title, url: g('link'), source, date: isNaN(d) ? null : d.toISOString() };
  }).filter(i => i.title);
}
const googleNews = q => get(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:1d&hl=en-US&gl=US&ceid=US:en`, { json: false }).then(x => parseRSS(x, 'Google News'));

// ---------- Spike Radar: GDELT news share + Wikipedia attention ----------
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
let gdeltLast = 0;
async function gdelt(q) {
  const qq = /\s/.test(q) ? `"${q}"` : q;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(qq)}&mode=TimelineVolRaw&format=json&timespan=30d`;
  for (const wait of [0, 15000, 30000]) {
    await sleep(Math.max(0, gdeltLast + 7000 - Date.now(), wait)); gdeltLast = Date.now();
    try {
      const j = await get(url, { ms: 60000 });
      const d = (j.timeline?.[0]?.data || []).filter(x => x.norm > 0).map(x => ({ day: x.date.slice(0, 8), share: x.value / x.norm }));
      if (d.length < 4) return null;
      const now = (d.at(-1).share + d.at(-2).share) / 2, usual = median(d.slice(0, -2).map(x => x.share));
      return { newsNow: +(now * 100).toFixed(3), newsUsual: +(usual * 100).toFixed(3), newsRatio: usual ? now / usual : null, newsSpark: d.slice(-14).map(x => +(x.share * 100).toFixed(3)), newsAsOf: d.at(-1).day };
    } catch (e) { log('gdelt', q, e.message); }
  }
  throw new Error('gdelt unavailable');
}
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
async function wikiTitle(q) {
  const cap = q.trim().replace(/\s+/g, '_').replace(/^./, c => c.toUpperCase());
  for (const cand of [...new Set([cap, cap.replace(/s$/, '')])]) {
    try { const d = await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cand)}`); if (d.type === 'standard') return d.title; } catch {}
    await sleep(1500);
  }
  return null;
}
async function wiki(q) {
  const title = await wikiTitle(q); if (!title) return null;
  const slug = encodeURIComponent(title.replace(/ /g, '_'));
  const j = await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${slug}/daily/${ymd(new Date(Date.now() - 32 * 864e5))}/${ymd(new Date())}`);
  const v = (j.items || []).map(x => x.views); if (v.length < 5) return null;
  const now = (v.at(-1) + v.at(-2)) / 2, usual = median(v.slice(0, -2));
  return { article: title, articleUrl: `https://en.wikipedia.org/wiki/${slug}`, attNow: Math.round(now), attUsual: usual, attRatio: usual ? now / usual : null, attSpark: v.slice(-14) };
}

// ---------- Markets (Yahoo Finance chart API) ----------
const SYMBOLS = [['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq'], ['^DJI', 'Dow'], ['^RUT', 'Russell 2000'], ['^VIX', 'VIX'], ['^TNX', '10Y yield'],
  ['CL=F', 'WTI crude'], ['BZ=F', 'Brent'], ['GC=F', 'Gold'], ['SI=F', 'Silver'], ['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum']];
async function market([sym, name]) {
  const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`);
  const m = j.chart?.result?.[0]?.meta; if (!m) throw new Error('no meta');
  const price = m.regularMarketPrice, prevClose = m.chartPreviousClose ?? m.previousClose;
  const closes = (j.chart.result[0].indicators?.quote?.[0]?.close || []).filter(x => x != null);
  const base = closes.length >= 2 ? closes.at(-2) : prevClose;
  return { symbol: sym, name, price, changePct: base ? +((price / base - 1) * 100).toFixed(2) : null, time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null };
}

// ---------- World ----------
const FEEDS = [['https://feeds.bbci.co.uk/news/world/rss.xml', 'BBC'], ['https://www.aljazeera.com/xml/rss/all.xml', 'Al Jazeera'],
  ['https://www.france24.com/en/rss', 'France 24'], ['https://rss.dw.com/rdf/rss-en-world', 'DW'], ['https://feeds.npr.org/1004/rss.xml', 'NPR']];
async function worldNews() {
  const all = [];
  for (const [u, s] of FEEDS) { try { all.push(...parseRSS(await get(u, { json: false }), s).slice(0, 15)); } catch (e) { log('feed', s, e.message); } }
  const seen = new Set();
  return all.filter(i => i.date).sort((a, b) => b.date.localeCompare(a.date)).filter(i => { const k = i.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
}
async function quakes() {
  const j = await get('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson');
  return j.features.map(f => ({ mag: f.properties.mag, place: f.properties.place, time: new Date(f.properties.time).toISOString(), url: f.properties.url, tsunami: !!f.properties.tsunami }))
    .sort((a, b) => b.mag - a.mag).slice(0, 12);
}
async function hazards() {
  const j = await get('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=7&limit=40');
  return (j.events || []).map(e => ({ title: e.title, category: e.categories?.[0]?.title, date: e.geometry?.at(-1)?.date })).slice(0, 15);
}

// ---------- Build ----------
const out = { generatedAt: new Date().toISOString(), status: {}, debriefUrl: 'https://claude.ai/artifact/CNxbhP2Q5bnDzuFA5gUj6J' };
async function step(key, fn) {
  try { out[key] = await fn(); out.status[key] = 'ok'; log('ok', key); }
  catch (e) { out[key] = prev[key] ?? null; out.status[key] = `kept previous (${String(e.message).slice(0, 60)})`; log('FAIL', key, e.message); }
}

await step('markets', async () => { const r = []; for (const s of SYMBOLS) { try { r.push(await market(s)); } catch (e) { log('market', s[0], e.message); const old = prev.markets?.find(x => x.symbol === s[0]); if (old) r.push({ ...old, stale: true }); } await sleep(400); } if (!r.length) throw new Error('no quotes'); return r; });
await step('world', worldNews);
await step('quakes', quakes);
await step('hazards', hazards);
await step('topics', async () => {
  const res = [];
  for (const q of WATCH) {
    const old = prev.topics?.find(t => t.topic === q) || {};
    const row = { topic: q };
    try { Object.assign(row, await wiki(q) || {}); } catch (e) { log('wiki', q, e.message); for (const k of ['article', 'articleUrl', 'attNow', 'attUsual', 'attRatio', 'attSpark']) if (old[k] != null) row[k] = old[k]; }
    try { Object.assign(row, await gdelt(q) || {}); } catch (e) { for (const k of ['newsNow', 'newsUsual', 'newsRatio', 'newsSpark', 'newsAsOf']) if (old[k] != null) row[k] = old[k]; row.newsStale = true; }
    try { row.headlines = (await googleNews(q)).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 6); } catch (e) { row.headlines = old.headlines || []; }
    row.spike = Math.max(row.newsRatio || 0, row.attRatio || 0) >= 2;
    res.push(row); await sleep(1500);
  }
  return res;
});

await writeFile(OUT, JSON.stringify(out, null, 1));
log('wrote data.json', JSON.stringify(out.status));
