const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Escape text for safe insertion into HTML. */
export const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, c => ESCAPES[c]);

/**
 * Write both text/plain and text/html to the clipboard so a paste into a rich
 * editor (e.g. a mail compose window) keeps formatting and clickable links.
 * Falls back to a plain-text write where ClipboardItem (or the rich write API)
 * is unavailable. Returns whether the write succeeded.
 */
export async function copyRich(plain: string, html: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(plain);
    }
    return true;
  } catch {
    return false;
  }
}
