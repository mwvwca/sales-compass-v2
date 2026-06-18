import { describe, it, expect } from 'vitest';
import { briefingToHtml } from '@/lib/briefingClipboard';

const URL = 'https://logicnow.lightning.force.com/lightning/r/Opportunity/006Vy00001cDDU6/view';

describe('briefingToHtml', () => {
  it('wraps inline http(s) URLs in anchors', () => {
    const html = briefingToHtml(`Open it here: ${URL}`);
    expect(html).toBe(`Open it here: <a href="${URL}" target="_blank" rel="noopener">${URL}</a>`);
  });

  it('converts newlines to <br>', () => {
    expect(briefingToHtml('line one\nline two')).toBe('line one<br>line two');
  });

  it('HTML-escapes text content', () => {
    expect(briefingToHtml('A & B <commit> "x"')).toBe('A &amp; B &lt;commit&gt; &quot;x&quot;');
  });

  it('renders the name as the link when a bare-URL line follows it, dropping the URL line', () => {
    const html = briefingToHtml(`Acme Corp\n${URL}`);
    expect(html).toBe(`<a href="${URL}" target="_blank" rel="noopener">Acme Corp</a>`);
    expect(html).not.toContain('<br>'); // the bare-URL line was dropped, not kept
  });

  it('keeps a bare-URL line as a link when no name precedes it', () => {
    expect(briefingToHtml(URL)).toBe(`<a href="${URL}" target="_blank" rel="noopener">${URL}</a>`);
  });

  it('handles a name + URL embedded in a larger briefing block', () => {
    const html = briefingToHtml(`Closing this week:\nAcme Corp\n${URL}\nNext deal`);
    expect(html).toBe(
      `Closing this week:<br><a href="${URL}" target="_blank" rel="noopener">Acme Corp</a><br>Next deal`,
    );
  });
});
