import { app, net } from 'electron';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  host: string;
}

/** One image-search hit: a thumbnail to show and the page it came from. */
export interface ImageResult {
  thumbnail: string;
  title: string;
  url: string;
  source: string;
}

/**
 * Shiori's search backend. It fetches ordinary web results and hands the raw
 * HTML to the renderer, which parses it into Shiori's own result cards — so no
 * outside search engine's branding is ever shown. The source is free and needs
 * no API key. Kept deliberately swappable behind one endpoint constant.
 *
 * We use Chromium's network stack (net.fetch), not Node's, so the request rides
 * the same TLS/proxy/UA the browser uses and reads as a normal browser visit.
 */
const ENDPOINT = 'https://html.duckduckgo.com/html/';
const TIMEOUT_MS = 9000;

export interface SearchFetchResult {
  ok: boolean;
  html?: string;
  error?: string;
}

export async function fetchSearchHtml(query: string, offset = 0): Promise<SearchFetchResult> {
  const q = query.trim();
  if (!q) return { ok: false, error: 'empty query' };

  // Tests point this at a loopback fixture; honored only in development so a
  // packaged build can never be redirected to a spoofed results page.
  const override = process.env.SHIORI_SEARCH_URL;
  const base = override && !app.isPackaged ? override : ENDPOINT;
  const off = offset > 0 ? `&s=${offset}` : '';
  const url = `${base}${base.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}${off}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await net.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.8',
      },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const html = await res.text();
    return { ok: true, html };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Parsing (main process, no DOM — a small regex extractor over the source's
// stable result markup: a.result__a / .result__snippet / .result__url).
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
}

/** Strip tags, decode entities, collapse whitespace. */
function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Unwrap the source's redirect links (…/l/?uddg=<encoded real url>). */
function unwrapUrl(href: string): string {
  const raw = decodeEntities(href);
  const m = raw.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return '';
    }
  }
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function parseSearchResults(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  // One block per organic result; ads carry result--ad and are skipped below.
  const blocks = html.split(/class="result\s+results_links/).slice(1);
  for (const block of blocks) {
    if (/result--ad/.test(block)) continue;
    const link = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = unwrapUrl(link[1]!);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const title = textOf(link[2]!);
    if (!title) continue;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const hostText = block.match(/class="result__url"[^>]*>([\s\S]*?)<\/span>/);
    out.push({
      title,
      url,
      snippet: snippet ? textOf(snippet[1]!) : '',
      host: hostText ? textOf(hostText[1]!) : hostOf(url),
    });
    seen.add(url);
    if (out.length >= 30) break;
  }
  return out;
}

/** Merge several offset batches into one list, dropping duplicate URLs. */
export function dedupeResults(lists: SearchResult[][]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const list of lists) {
    for (const r of list) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      out.push(r);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The results page itself, served on shiori://search?q=… so it lives in the
// page view's REAL navigation history — that is what makes ‹ / › work between
// the results and an opened result. Script-free by CSP; everything untrusted
// is HTML-escaped.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Stable, pleasant hue for a host (same formula as the chrome sidebar). */
function hueForHost(host: string): number {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) % 360;
  return h;
}

/** "example.com › apps › shiori" from a URL, like the mockup's breadcrumb. */
function breadcrumb(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean).slice(0, 3);
    return [host, ...parts]
      .map((p) => `<span class="crumb">${escapeHtml(decodeURIComponent(p))}</span>`)
      .join('<span class="crumb-sep">›</span>');
  } catch {
    return `<span class="crumb">${escapeHtml(url)}</span>`;
  }
}

function resultCard(r: SearchResult, index: number): string {
  const host = hostOf(r.url);
  const hue = hueForHost(host);
  const chip = `<span class="chip" style="background:linear-gradient(140deg,hsl(${hue} 62% 62%),hsl(${(hue + 34) % 360} 60% 52%))">${escapeHtml((host[0] ?? '•').toUpperCase())}</span>`;
  // <object> falls back to its children on load failure without any JS.
  const fav = /^[a-z0-9.-]+$/i.test(host)
    ? `<object class="fav" data="https://${escapeHtml(host)}/favicon.ico" type="image/x-icon">${chip}</object>`
    : chip;
  return `<a class="result" href="${escapeHtml(r.url)}" style="animation-delay:${Math.min(index * 45, 450)}ms">
    <span class="crumbs">${fav}${breadcrumb(r.url)}</span>
    <span class="result-title">${escapeHtml(r.title)}</span>
    ${r.snippet ? `<span class="snippet">${escapeHtml(r.snippet)}</span>` : ''}
  </a>`;
}

/** The brand mark: a solid bookmark, same path as the app icon and #i-logo. */
const LOGO_SVG = `<svg viewBox="0 0 120 150" xmlns="http://www.w3.org/2000/svg"><path d="M22 24 Q22 12 34 12 L86 12 Q98 12 98 24 L98 134 L60 102 L22 134 Z" fill="#45372a"/></svg>`;

export type SearchTab = 'all' | 'images' | 'videos' | 'news';
const TABS: { id: SearchTab; label: string }[] = [
  { id: 'all', label: 'すべて' },
  { id: 'images', label: '画像' },
  { id: 'videos', label: '動画' },
  { id: 'news', label: 'ニュース' },
];

/**
 * Best-effort zero-click abstract for the "AI OVERVIEW" card. This is NOT an
 * LLM call — it reads DuckDuckGo's free Instant Answer summary (no key, no
 * agent). Empty for most queries; when empty the card is simply omitted.
 * A dev override (SHIORI_ABSTRACT) lets tests/screenshots exercise the card.
 */
export async function fetchAbstract(query: string): Promise<string | null> {
  const override = process.env.SHIORI_ABSTRACT;
  if (override && !app.isPackaged) return override;
  const q = query.trim();
  if (!q) return null;
  const controller = new AbortController();
  // Short: the results page is server-rendered, so the abstract must never
  // hold up the results for long. Missed abstract just omits the card.
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await net.fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&t=shiori`,
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { AbstractText?: string };
    const text = (data.AbstractText ?? '').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Actual image results (thumbnails), for the 画像 tab — not "sites that have
 * images". Uses DuckDuckGo's image endpoint (i.js), which needs a one-time vqd
 * token scraped from the search page. Free, no key. Best-effort: returns [] if
 * blocked, so the tab degrades to a friendly message.
 */
export async function fetchImages(query: string): Promise<ImageResult[]> {
  const override = process.env.SHIORI_IMAGES;
  if (override && !app.isPackaged) {
    try {
      return JSON.parse(override) as ImageResult[];
    } catch {
      return [];
    }
  }
  const q = query.trim();
  if (!q) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const tokenRes = await net.fetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`,
      { headers: { 'Accept-Language': 'ja,en;q=0.8' }, signal: controller.signal },
    );
    const html = await tokenRes.text();
    const m = html.match(/vqd=["']([^"'&]+)["']/) ?? html.match(/vqd=([0-9-]{8,})/);
    if (!m) return [];
    const url = `https://duckduckgo.com/i.js?l=jp-jp&o=json&q=${encodeURIComponent(q)}&vqd=${encodeURIComponent(m[1]!)}&f=,,,&p=1`;
    const res = await net.fetch(url, {
      headers: { Referer: 'https://duckduckgo.com/', 'Accept-Language': 'ja,en;q=0.8' },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: { thumbnail?: string; title?: string; url?: string; source?: string }[];
    };
    return (data.results ?? [])
      .filter((r) => typeof r.thumbnail === 'string' && /^https?:\/\//.test(r.thumbnail))
      .slice(0, 60)
      .map((r) => ({
        thumbnail: r.thumbnail!,
        title: r.title ?? '',
        url: typeof r.url === 'string' ? r.url : '',
        source: r.source ?? '',
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function imageCell(im: ImageResult): string {
  const href = /^https?:\/\//.test(im.url) ? im.url : im.thumbnail;
  const label = im.source || hostOf(im.url) || '';
  return `<a class="img-cell" href="${escapeHtml(href)}" title="${escapeHtml(im.title)}">
    <img src="${escapeHtml(im.thumbnail)}" alt="" loading="lazy">
    ${label ? `<span class="img-src">${escapeHtml(label)}</span>` : ''}
  </a>`;
}

export function buildSearchPage(
  query: string,
  results: SearchResult[] | null,
  abstract: string | null = null,
  tab: SearchTab = 'all',
  images: ImageResult[] = [],
  page = 1,
): string {
  const enc = encodeURIComponent(query);
  // Web tabs get prev/next paging; each page fetches a fresh batch of results.
  const pager =
    tab !== 'images' && results && results.length > 0
      ? `<nav class="pager">
      ${page > 1 ? `<a class="pg" href="shiori://search?q=${enc}&t=${tab}&p=${page - 1}">← 前のページ</a>` : '<span class="pg-sp"></span>'}
      <span class="pg-num">ページ ${page}</span>
      <a class="pg" href="shiori://search?q=${enc}&t=${tab}&p=${page + 1}">次のページ →</a>
    </nav>`
      : '';
  const tabsHtml = TABS.map(
    (t) =>
      `<a class="tab${t.id === tab ? ' active' : ''}" href="shiori://search?q=${encodeURIComponent(query)}&t=${t.id}">${t.label}</a>`,
  ).join('');

  const overview =
    abstract && results !== null && results.length > 0
      ? `<section class="ai-card">
      <div class="ai-head"><span class="ai-spark">✦</span> AI OVERVIEW</div>
      <p class="ai-body">${escapeHtml(abstract)}</p>
    </section>`
      : '';

  const body =
    tab === 'images'
      ? images.length === 0
        ? `<p class="status">画像を取得できませんでした。時間をおいて再度お試しください。</p>`
        : `<div class="img-grid">${images.map(imageCell).join('')}</div>`
      : results === null
        ? `<p class="status">いま検索できませんでした。時間をおいて再読み込み（${process.platform === 'darwin' ? '⌘R' : 'Ctrl+R'}）するか、URL を直接入力してください。</p>`
        : results.length === 0
          ? `<p class="status">結果が見つかりませんでした。別の言葉で試してください。</p>`
          : `${overview}<div class="list">${results.map(resultCard).join('')}</div>${pager}`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; object-src https: http:; form-action shiori:">
<title>${escapeHtml(query)} — 栞検索</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { height: 100%; }
  :root {
    --paper: #f6f0e4; --ink: #3a3123; --dim: #6b6151; --faint: #9a9184;
    --brown: #9a5f33; --line: rgba(74,54,30,.12); --surface: #fffdf9;
    --mono: ui-monospace, 'SF Mono', 'JetBrains Mono', 'Menlo', 'Cascadia Mono', 'Consolas', monospace;
  }
  body {
    min-height: 100%;
    background: #f5efe4;
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Segoe UI', 'Yu Gothic UI', 'Meiryo', 'Noto Sans JP', sans-serif;
    font-size: 13px; -webkit-font-smoothing: antialiased;
    padding: 34px 44px 60px;
  }
  .inner { max-width: 720px; margin: 0 auto; }
  .top { display: flex; align-items: center; gap: 20px; }
  .brand { display: flex; align-items: center; gap: 11px; flex: 0 0 auto; }
  .mark {
    width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
    background: #f2ece0; box-shadow: inset 0 0 0 2px #45372a;
  }
  .mark svg { width: 19px; height: 24px; display: block; }
  .brand-word { font-family: var(--mono); font-size: 19px; font-weight: 600; letter-spacing: -.01em; }
  form.hero {
    flex: 1 1 auto; display: flex; align-items: center; gap: 10px;
    height: 46px; padding: 0 16px; border-radius: 13px;
    background: var(--surface); border: 1px solid var(--line);
    box-shadow: 0 1px 2px rgba(60,44,24,.06);
  }
  form.hero:focus-within {
    border-color: color-mix(in srgb, var(--brown) 55%, transparent);
    box-shadow: 0 0 0 4px rgba(154,95,51,.12);
  }
  form.hero svg { width: 16px; height: 16px; color: var(--faint); flex: 0 0 auto; }
  input[name=q] {
    flex: 1 1 auto; min-width: 0; height: 100%; border: none; background: none; outline: none;
    color: var(--ink); font-size: 14px; font-family: var(--mono);
  }
  .tabs { display: flex; gap: 26px; margin-top: 22px; border-bottom: 1px solid var(--line); }
  .tab {
    padding: 0 2px 12px; color: var(--dim); text-decoration: none;
    font-size: 14px; font-weight: 600; position: relative; transition: color .12s ease;
  }
  .tab:hover { color: var(--ink); }
  .tab.active { color: var(--ink); }
  .tab.active::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
    border-radius: 2px; background: var(--brown);
  }
  @keyframes rise { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
  .ai-card {
    margin-top: 24px; padding: 20px 22px; border-radius: 16px;
    background: linear-gradient(180deg, rgba(154,95,51,.07), rgba(154,95,51,.03));
    border: 1px solid var(--line); animation: rise .3s ease both;
  }
  .ai-head {
    font-family: var(--mono); font-size: 11.5px; font-weight: 600; letter-spacing: .1em;
    color: var(--brown); display: flex; align-items: center; gap: 7px; margin-bottom: 12px;
  }
  .ai-spark { font-size: 13px; }
  .ai-body { color: var(--ink); font-size: 13.5px; line-height: 1.85; }
  .list { margin-top: 26px; }
  .result {
    display: block; padding: 4px 0 20px; margin-bottom: 18px;
    border-bottom: 1px solid var(--line); text-decoration: none; color: inherit;
    animation: rise .32s ease both;
  }
  .result:last-child { border-bottom: none; }
  .crumbs {
    display: flex; align-items: center; gap: 7px; margin-bottom: 7px;
    font-family: var(--mono); font-size: 11.5px; color: var(--faint);
  }
  .fav, .chip {
    flex: 0 0 auto; width: 17px; height: 17px; border-radius: 5px;
    display: inline-grid; place-items: center; overflow: hidden;
  }
  .chip { color: #fff; font-size: 9px; font-weight: 700; font-family: -apple-system, sans-serif; }
  .crumb { color: var(--dim); }
  .crumb-sep { color: var(--faint); opacity: .7; }
  .result-title {
    display: block; font-size: 17px; font-weight: 700; line-height: 1.4;
    color: var(--brown); transition: opacity .12s ease;
  }
  .result:hover .result-title { text-decoration: underline; }
  .snippet {
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    margin-top: 7px; color: var(--dim); font-size: 13px; line-height: 1.7;
  }
  .status { margin: 30px 2px 0; color: var(--faint); font-size: 12.5px; line-height: 1.7; }
  /* Image tab: an actual thumbnail grid (masonry via CSS columns). */
  .img-grid { columns: 200px 4; column-gap: 12px; margin-top: 26px; }
  .img-cell {
    position: relative; display: block; margin: 0 0 12px; break-inside: avoid;
    border-radius: 10px; overflow: hidden; background: #e7ded0;
    box-shadow: 0 1px 2px rgba(60,44,24,.12); text-decoration: none;
    animation: rise .3s ease both;
  }
  .img-cell img {
    width: 100%; display: block; transition: transform .2s ease;
  }
  .img-cell:hover img { transform: scale(1.04); }
  .img-src {
    position: absolute; left: 0; right: 0; bottom: 0; padding: 14px 8px 6px;
    font-family: var(--mono); font-size: 10px; color: #fff;
    background: linear-gradient(transparent, rgba(40,30,18,.72));
    opacity: 0; transition: opacity .12s ease;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .img-cell:hover .img-src { opacity: 1; }
  .pager {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin: 28px 2px 8px; padding-top: 22px; border-top: 1px solid var(--line);
  }
  .pg {
    color: var(--brown); text-decoration: none; font-weight: 600; font-size: 13px;
    padding: 9px 16px; border-radius: 11px; border: 1px solid var(--line);
    background: var(--surface); box-shadow: 0 1px 2px rgba(60,44,24,.06);
    transition: box-shadow .12s ease, transform .12s ease;
  }
  .pg:hover { box-shadow: 0 3px 10px rgba(60,44,24,.1); transform: translateY(-1px); }
  .pg-num { font-family: var(--mono); font-size: 12px; color: var(--faint); }
  .pg-sp { flex: 0 0 auto; }
</style>
</head>
<body>
  <div class="inner">
    <div class="top">
      <span class="brand"><span class="mark">${LOGO_SVG}</span><span class="brand-word">browser</span></span>
      <form class="hero" action="shiori://search" method="get">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M20 20l-4.2-4.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>
        <input name="q" value="${escapeHtml(query)}" spellcheck="false" autocomplete="off" placeholder="もう一度検索">
      </form>
    </div>
    <nav class="tabs">${tabsHtml}</nav>
    ${body}
  </div>
</body>
</html>`;
}
