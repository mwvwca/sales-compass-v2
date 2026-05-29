import type { RawDrRecord } from '@/types/forecast';

type RawDr = RawDrRecord;


const FIELD_MAP: Record<string, keyof RawDr> = {
  'opportunity id': 'opportunityId',
  'opportunity name': 'opportunityName',
  'opportunity owner': 'repName',
  '2nd owner': 'secondOwner',
  'channel account manager': 'channelAccountManager',
  'reseller name': 'resellerName',
  'distributor - reseller': 'distributorReseller',
  'account name': 'accountName',
  'product': 'product',
  'stage': 'stage',
  'probability (%)': 'probability',
  'probability': 'probability',
  'amount': 'amount',
  'expected revenue': 'expectedRevenue',
  'close date': 'closeDate',
  'created date': 'createdDate',
  'last activity': 'lastActivity',
  'age': 'ageDays',
  'billing state/province': 'billingState',
  'billing state': 'billingState',
  'lead source': 'leadSource',
  'type': 'type',
  'registered deal': 'registeredDeal',
};

function normHeader(h: string): string {
  return String(h ?? '').trim().toLowerCase();
}

function parseDate(raw: unknown): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (typeof raw === 'number' && isFinite(raw)) {
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return undefined;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return undefined;
    return `${raw.getUTCFullYear()}-${String(raw.getUTCMonth() + 1).padStart(2, '0')}-${String(raw.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(raw).trim();
  if (!s) return undefined;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(+iso[2]).padStart(2, '0')}-${String(+iso[3]).padStart(2, '0')}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const m = +us[1], d = +us[2];
    let y = +us[3];
    if (y < 100) y += 2000;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  return undefined;
}

function parseNumber(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (typeof raw === 'number') return isFinite(raw) ? raw : undefined;
  const s = String(raw).replace(/[$,%\s]/g, '');
  if (!s) return undefined;
  const n = parseFloat(s);
  return isFinite(n) ? n : undefined;
}

function parseBool(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

export function parseDrExport(rawRows: any[][]): {
  records: RawDr[];
  asOfDate: string;
  errors: string[];
} {
  const errors: string[] = [];
  let asOfDate = '';

  // Extract "As of [date]"
  for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
    const row = rawRows[i] || [];
    for (const cell of row) {
      const s = String(cell ?? '');
      const m = s.match(/as of\s+(.+?)(?:\s*$|,)/i);
      if (m) {
        const parsed = parseDate(m[1]);
        asOfDate = parsed || m[1].trim();
        break;
      }
    }
    if (asOfDate) break;
  }

  // Find header row
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
    const row = (rawRows[i] || []).map((c: any) => normHeader(c));
    if (row.includes('opportunity owner') && row.includes('stage')) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    errors.push('Could not find header row (looking for "Opportunity Owner" and "Stage" columns).');
    return { records: [], asOfDate, errors };
  }

  const rawHeaders = rawRows[headerRowIdx] || [];
  const headerCols = rawHeaders
    .map((name: any, idx: number) => ({ idx, name: normHeader(name) }))
    .filter(({ name }: any) => name !== '' && name !== 'undefined' && name !== 'null');

  // Build column -> field
  const colMap: Array<{ idx: number; field: keyof RawDr }> = [];
  for (const { idx, name } of headerCols) {
    const field = FIELD_MAP[name];
    if (field) colMap.push({ idx, field });
  }

  if (!colMap.find(c => c.field === 'opportunityId') || !colMap.find(c => c.field === 'stage')) {
    errors.push('Required columns missing (Opportunity ID, Stage).');
    return { records: [], asOfDate, errors };
  }

  const records: RawDr[] = [];
  for (let r = headerRowIdx + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || row.every((c: any) => c === null || c === undefined || c === '')) continue;

    const raw: Record<string, any> = {};
    for (const { idx, field } of colMap) {
      raw[field] = row[idx];
    }

    const opportunityId = String(raw.opportunityId ?? '').trim();
    const opportunityName = String(raw.opportunityName ?? '').trim();
    if (!opportunityId && !opportunityName) continue;

    try {
      let prob = parseNumber(raw.probability) ?? 0;
      if (prob > 1) prob = prob / 100;

      const ageDays = Math.round(parseNumber(raw.ageDays) ?? 0);
      const createdDate = parseDate(raw.createdDate) || '';

      const rec: RawDr = {
        opportunityId,
        opportunityName,
        accountName: String(raw.accountName ?? '').trim(),
        repName: String(raw.repName ?? '').trim(),
        secondOwner: raw.secondOwner ? String(raw.secondOwner).trim() || undefined : undefined,
        channelAccountManager: raw.channelAccountManager ? String(raw.channelAccountManager).trim() || undefined : undefined,
        resellerName: raw.resellerName ? String(raw.resellerName).trim() || undefined : undefined,
        distributorReseller: raw.distributorReseller ? String(raw.distributorReseller).trim() || undefined : undefined,
        product: raw.product ? String(raw.product).trim() || undefined : undefined,
        stage: String(raw.stage ?? '').trim(),
        probability: prob,
        amount: parseNumber(raw.amount),
        expectedRevenue: parseNumber(raw.expectedRevenue),
        closeDate: parseDate(raw.closeDate),
        createdDate,
        lastActivity: parseDate(raw.lastActivity),
        ageDays,
        billingState: raw.billingState ? String(raw.billingState).trim() || undefined : undefined,
        leadSource: raw.leadSource ? String(raw.leadSource).trim() || undefined : undefined,
        type: raw.type ? String(raw.type).trim() || undefined : undefined,
        registeredDeal: parseBool(raw.registeredDeal),
        isSql: prob >= 0.25,
      };
      records.push(rec);
    } catch (err: any) {
      errors.push(`Row ${r + 1}: ${err?.message || 'parse error'}`);
    }
  }

  if (!asOfDate) {
    asOfDate = new Date().toISOString().slice(0, 10);
  }

  return { records, asOfDate, errors };
}
