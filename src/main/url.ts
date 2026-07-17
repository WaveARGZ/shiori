/**
 * URL bar input -> a real URL. Anything that doesn't look like a host or an
 * explicit scheme becomes a web search.
 */
export function toNavigableUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^about:/i.test(raw)) return raw;

  const looksLikeHost =
    /^localhost(:\d+)?(\/|$)/i.test(raw) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(raw) ||
    (/^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(raw) && !raw.includes(' '));

  if (looksLikeHost) return `https://${raw}`;
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
}

/**
 * The key a bookmark is stored under. The fragment is dropped so that
 * "same article, jumped to a heading" keeps one shared reading position.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/** Only real web pages earn a bookmark — not about:blank or devtools. */
export function isBookmarkable(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Short host label for list rows. */
export function hostLabel(raw: string): string {
  try {
    return new URL(raw).host.replace(/^www\./, '');
  } catch {
    return raw;
  }
}
