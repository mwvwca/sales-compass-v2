const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, c => ESCAPES[c]);

const URL_RE = /(https?:\/\/[^\s<]+)/g;
const BARE_URL_RE = /^\s*https?:\/\/\S+\s*$/;

const anchor = (href: string, label: string): string =>
  `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;

/** Escape a line, then turn any http(s) URLs within it into anchors. */
function linkifyLine(line: string): string {
  return escapeHtml(line).replace(URL_RE, url => anchor(url, url));
}

/**
 * Convert briefing plain text to clipboard HTML so pasted emails have clickable
 * links: every http(s) URL becomes an anchor and newlines become <br>.
 *
 * Cleaner-email touch: when a bare-URL line immediately follows a name/text
 * line, the text is rendered as the link and the bare-URL line is dropped.
 */
export function briefingToHtml(plain: string): string {
  const lines = plain.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const nextIsBareUrl = next !== undefined && BARE_URL_RE.test(next);
    if (nextIsBareUrl && line.trim() && !BARE_URL_RE.test(line)) {
      out.push(anchor(escapeHtml(next.trim()), escapeHtml(line)));
      i++; // drop the now-redundant bare-URL line
      continue;
    }
    out.push(linkifyLine(line));
  }
  return out.join('<br>');
}
