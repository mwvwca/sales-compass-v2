import type { Opportunity } from '@/types/forecast';
import { normalizeRepName } from '@/lib/repUtils';

export interface ParsedCommissionLine {
  rawText: string;
  opportunityName?: string;
  amount?: number;
  commissionAmount?: number;
  lineType: 'deal' | 'total' | 'header' | 'unknown';
}

export interface ParsedStatement {
  lines: ParsedCommissionLine[];
  totalPaid?: number;
  statementMonth?: string;
  repName?: string;
  rawText: string;
}

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const MONTH_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function parseMoney(token: string): number | undefined {
  const cleaned = token.replace(/[$,\s]/g, '').replace(/[()]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const v = parseFloat(cleaned);
  if (isNaN(v)) return undefined;
  return token.includes('(') ? -v : v;
}

/** Extract all dollar amounts from a line as numbers (largest order preserved). */
function extractMoney(line: string): number[] {
  const re = /\$?\(?-?\$?[\d]{1,3}(?:,\d{3})+(?:\.\d{1,2})?\)?|\$?\(?-?\d+\.\d{2}\)?/g;
  const matches = line.match(re) || [];
  return matches
    .map(m => parseMoney(m))
    .filter((n): n is number => n !== undefined);
}

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 2);
}

/** Word-overlap score 0..1 between candidate text and opportunity name. */
function wordOverlap(line: string, name: string): number {
  const a = new Set(tokenize(line));
  const b = tokenize(name);
  if (b.length === 0 || a.size === 0) return 0;
  let hits = 0;
  for (const t of b) if (a.has(t)) hits++;
  return hits / b.length;
}

function detectMonth(text: string): string | undefined {
  // Look for "May 2026" or "5/2026" or "05/2026" or "2026-05"
  const lower = text.toLowerCase();
  for (let i = 0; i < MONTHS.length; i++) {
    const re = new RegExp(`\\b(${MONTHS[i]}|${MONTH_ABBR[i]})[\\s,.-]+(20\\d{2})\\b`, 'i');
    const m = lower.match(re);
    if (m) return `${m[2]}-${String(i + 1).padStart(2, '0')}`;
  }
  const num = text.match(/\b(0?[1-9]|1[0-2])[\/\-](20\d{2})\b/);
  if (num) return `${num[2]}-${String(parseInt(num[1], 10)).padStart(2, '0')}`;
  const iso = text.match(/\b(20\d{2})[\/\-](0?[1-9]|1[0-2])\b/);
  if (iso) return `${iso[1]}-${String(parseInt(iso[2], 10)).padStart(2, '0')}`;
  return undefined;
}

function detectRep(firstLines: string[], opportunities: Opportunity[]): string | undefined {
  const reps = Array.from(new Set(opportunities.map(o => o.repName).filter(Boolean)));
  const blob = firstLines.join(' \n ').toLowerCase();
  for (const r of reps) {
    if (!r) continue;
    if (blob.includes(r.toLowerCase())) return r;
  }
  // try last-name only
  for (const r of reps) {
    const parts = r.toLowerCase().split(/\s+/);
    for (const p of parts) {
      if (p.length > 3 && blob.includes(p)) return r;
    }
  }
  return undefined;
}

export function parseCommissionStatement(text: string, opportunities: Opportunity[]): ParsedStatement {
  const cleaned = text.replace(/\r/g, '').replace(/\t/g, ' ');
  const rawLines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);

  const oppNames = Array.from(new Set(opportunities.map(o => o.name).filter(Boolean)));

  const lines: ParsedCommissionLine[] = [];
  let totalPaid: number | undefined;

  for (const raw of rawLines) {
    const moneyVals = extractMoney(raw);
    const lower = raw.toLowerCase();
    const isTotal = /\b(grand\s+total|sub\s*total|total\s+commission|total\s+paid|total)\b/.test(lower);

    if (isTotal && moneyVals.length > 0) {
      const v = moneyVals[moneyVals.length - 1];
      lines.push({ rawText: raw, lineType: 'total', commissionAmount: v });
      if (/grand\s+total|total\s+commission|total\s+paid/.test(lower) || totalPaid === undefined) {
        totalPaid = v;
      }
      continue;
    }

    // Try to match an opportunity name
    let bestName: string | undefined;
    let bestScore = 0;
    for (const name of oppNames) {
      const score = wordOverlap(raw, name);
      if (score > bestScore) {
        bestScore = score;
        bestName = name;
      }
    }
    if (bestName && bestScore >= 0.6 && moneyVals.length > 0) {
      // Heuristic: if two money values, first = deal amount, last = commission $
      // If one value, treat as commission $
      const commissionAmount = moneyVals[moneyVals.length - 1];
      const amount = moneyVals.length >= 2 ? moneyVals[0] : undefined;
      lines.push({
        rawText: raw,
        opportunityName: bestName,
        amount,
        commissionAmount,
        lineType: 'deal',
      });
      continue;
    }

    // Header heuristic
    if (moneyVals.length === 0 && /\b(opportunity|deal|account|customer|commission|payout|rep|amount)\b/.test(lower)) {
      lines.push({ rawText: raw, lineType: 'header' });
      continue;
    }

    lines.push({ rawText: raw, lineType: 'unknown' });
  }

  const statementMonth = detectMonth(cleaned);
  const repName = detectRep(rawLines.slice(0, 30), opportunities);

  return { lines, totalPaid, statementMonth, repName, rawText: cleaned };
}

/** Helper used by reconciliation: find best matching parsed deal line for an opportunity. */
export function findMatchingLine(
  oppName: string,
  parsedLines: ParsedCommissionLine[],
  usedIdx: Set<number>,
): { idx: number; line: ParsedCommissionLine } | null {
  let best: { idx: number; line: ParsedCommissionLine; score: number } | null = null;
  parsedLines.forEach((line, idx) => {
    if (usedIdx.has(idx)) return;
    if (line.lineType !== 'deal') return;
    const score = line.opportunityName === oppName ? 1 : wordOverlap(line.rawText, oppName);
    if (score >= 0.6 && (!best || score > best.score)) {
      best = { idx, line, score };
    }
  });
  return best ? { idx: best.idx, line: best.line } : null;
}

export { normalizeRepName };
