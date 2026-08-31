import { useCallback, useState } from 'react';
import type { Opportunity } from '@/types/forecast';
import { Upload, FileSpreadsheet, AlertCircle } from 'lucide-react';
import * as XLSX from '@e965/xlsx';
import { getImportedClassification } from '@/lib/forecastClassification';
import { parseStage } from '@/lib/transformSalesforce';
import { normalizeProbability } from '@/lib/probability';
import { resolveReseller } from '@/lib/resellerUtils';
import { originFromUrls, resolveOpportunityUrl } from '@/lib/opportunityUrl';
import ImportReview from './ImportReview';
import { notifyImportComplete } from './WeeklyBriefing';

interface ColumnMapping {
  id: string;
  name: string;
  repName: string;
  amount: string;
  amountMonthly?: string;
  closeDate: string;
  stage: string;
  probability: string;
  forecast?: string;
  forecastCategory?: string;
  upsideFlag?: string;
  accountName?: string;
  productName?: string;
  channelAccountManager?: string;
  resellerName?: string;
  distributorReseller?: string;
  opportunitySource?: string;
  nextStep?: string;
  description?: string;
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// Manager inspection-note column candidates, matched case-insensitively.
const MANAGER_NOTE_HEADERS = [
  'Manager Note', 'Manager Notes', 'Manager Review Note', 'Manager Review Notes',
  'Inspection Note', 'Inspection Notes', 'Management Notes',
];
function detectManagerNoteHeader(headers: string[]): string | undefined {
  const wanted = new Set(MANAGER_NOTE_HEADERS.map(normalizeHeader));
  return headers.find(h => wanted.has(normalizeHeader(h)));
}

const DEFAULT_MAPPINGS: Record<string, keyof ColumnMapping> = {
  'opportunity id': 'id',
  'opportunity name': 'name',
  'opportunity owner': 'repName',
  'owner': 'repName',
  'rep': 'repName',
  'rep name': 'repName',
  'amount': 'amount',
  // Salesforce "Amount (Monthly) (converted)" — sits between Amount and Close Date in the
  // export. Matched on the normalized (lowercased, punctuation-stripped) header, so the
  // exact casing and parenthesisation in the file do not matter.
  'amount monthly converted': 'amountMonthly',
  'amount monthly': 'amountMonthly',
  'close date': 'closeDate',
  'expected close date': 'closeDate',
  'stage': 'stage',
  'stage name': 'stage',
  'probability': 'probability',
  'probability (%)': 'probability',
  'forecast': 'forecast',
  'forecasted deal': 'forecast',
  'forecast category': 'forecastCategory',
  'upside': 'upsideFlag',
  'upside deal': 'upsideFlag',
  'account': 'accountName',
  'account name': 'accountName',
  'account id': 'accountName',
  'billing account': 'accountName',
  'company': 'accountName',
  'company name': 'accountName',
  'organization': 'accountName',
  'org': 'accountName',
  'product': 'productName',
  'product name': 'productName',
  'product family': 'productName',
  'primary product': 'productName',
  'products': 'productName',
  'product product name': 'productName',
  'product product family': 'productName',
  'opportunity product product name': 'productName',
  'opportunity product product family': 'productName',
  'product 2 product name': 'productName',
  'product2 product name': 'productName',
  'channel account manager': 'channelAccountManager',
  'cam': 'channelAccountManager',
  'channel manager': 'channelAccountManager',
  'reseller name': 'resellerName',
  'reseller': 'resellerName',
  'distributor reseller': 'distributorReseller',
  'distributor - reseller': 'distributorReseller',
  'opportunity source': 'opportunitySource',
  'next step': 'nextStep',
  'next steps': 'nextStep',
  'description': 'description',
  'opportunity description': 'description',
};

/** Currency-ish cell → number, or null when the cell is absent/blank/unparseable. */
function parseOptionalAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/USD\s*/i, '').replace(/[$,\s]/g, '').trim();
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

function parseImportDate(raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return '';

  // Excel serial number → date
  if (typeof raw === 'number' && isFinite(raw)) {
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return '';
    return `${raw.getUTCFullYear()}-${String(raw.getUTCMonth() + 1).padStart(2, '0')}-${String(raw.getUTCDate()).padStart(2, '0')}`;
  }

  const s = String(raw).trim();
  if (!s) return '';

  // ISO YYYY-MM-DD
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const y = +iso[1], m = +iso[2], d = +iso[3];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // M/D/YYYY (Salesforce US default)
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    let y = +us[3]; const m = +us[1]; const d = +us[2];
    if (y < 100) y += 2000;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // Fallback: best-effort, but use UTC parts
  const fallback = new Date(s);
  if (!isNaN(fallback.getTime())) {
    return `${fallback.getUTCFullYear()}-${String(fallback.getUTCMonth() + 1).padStart(2, '0')}-${String(fallback.getUTCDate()).padStart(2, '0')}`;
  }
  return '';
}

function autoMap(headers: string[]): Partial<ColumnMapping> {
  const mapping: Partial<ColumnMapping> = {};
  for (const h of headers) {
    const key = normalizeHeader(h);
    const field = DEFAULT_MAPPINGS[key];
    if (field) (mapping as any)[field] = h;
  }
  if (!mapping.productName) {
    const productHeader = headers.find(h => {
      const key = normalizeHeader(h);
      return key.includes('product name') || key.includes('product family') || key === 'product' || key === 'products';
    });
    if (productHeader) mapping.productName = productHeader;
  }
  if (!mapping.accountName) {
    const acctHeader = headers.find(h => normalizeHeader(h).includes('account'));
    if (acctHeader) mapping.accountName = acctHeader;
  }
  if (!mapping.channelAccountManager) {
    const camHeader = headers.find(h => {
      const n = normalizeHeader(h);
      return n.includes('channel') || n === 'cam';
    });
    if (camHeader) mapping.channelAccountManager = camHeader;
  }
  return mapping;
}

export default function ImportSheet() {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<{ name: string; count: number } | null>(null);
  const [review, setReview] = useState<{ opps: Opportunity[]; fileName: string; headers: string[]; mapping: Record<string, string> } | null>(null);

  const processFile = useCallback((file: File) => {
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        // Read as array-of-arrays to find the header row (Salesforce exports may have metadata rows above)
        const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

        if (rawRows.length === 0) {
          setError('No data found in the file.');
          return;
        }

        // Search for a header row containing known column names
        let headerRowIdx = -1;
        for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
          const cells = rawRows[i].map((c: any) => String(c).toLowerCase().trim());
          if (cells.some(c => c === 'opportunity id' || c === 'opportunity name')) {
            headerRowIdx = i;
            break;
          }
        }

        // Fallback: use first row as header
        if (headerRowIdx < 0) headerRowIdx = 0;

        const rawHeaders = rawRows[headerRowIdx].map((c: any) => String(c ?? '').trim());
        // Preserve original column index — skip blank/null/undefined headers so they don't shift downstream columns
        const headerCols = rawHeaders
          .map((name, idx) => ({ idx, name }))
          .filter(({ name }) => name !== '' && name.toLowerCase() !== 'undefined' && name.toLowerCase() !== 'null');
        const headers = headerCols.map(h => h.name);
        const mapping = autoMap(headers);

        const managerNoteHeader = detectManagerNoteHeader(headers);
        console.log(managerNoteHeader
          ? `[parser] manager note column: ${managerNoteHeader}`
          : '[parser] manager note column not found');
        // Original column index of the Opportunity Name cell, for reading its hyperlink target.
        const nameColIdx = headerCols.find(c => c.name === mapping.name)?.idx;

        // Build rows as objects using original column indices
        const rows: Record<string, any>[] = [];
        for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
          const obj: Record<string, any> = {};
          let hasValue = false;
          for (const { idx, name } of headerCols) {
            const val = rawRows[i]?.[idx] ?? '';
            obj[name] = val;
            if (String(val).trim()) hasValue = true;
          }
          obj.__rowIdx = i; // sheet row index, for hyperlink cell lookup
          if (hasValue) rows.push(obj);
        }

        if (rows.length === 0) {
          setError('No data rows found after header.');
          return;
        }

        if (!mapping.id && !mapping.name) {
          setError('Could not find Opportunity ID or Name column. Ensure your export has standard Salesforce column names.');
          return;
        }

        // Filter out Salesforce footer/summary rows (Total, Confidential, copyright, etc.)
        const sfIdPattern = /^006[A-Za-z0-9]{12,15}$/;
        const validRows = rows.filter(row => {
          const sfId = String(row[mapping.id || ''] || '').trim();
          return sfIdPattern.test(sfId);
        });

        if (validRows.length === 0) {
          setError('No valid opportunity rows found after header.');
          return;
        }

        const importDate = new Date().toISOString();
        const opps: Opportunity[] = validRows.map((row, i) => {
          const closeDate = parseImportDate(row[mapping.closeDate || '']);
          const sfid = String(row[mapping.id || ''] || '').trim() || undefined;

          const managerNote = managerNoteHeader
            ? (String(row[managerNoteHeader] ?? '').trim() || undefined)
            : undefined;
          // Prefer the hyperlink target on the Opportunity Name cell (same technique as the DR parser's accountUrl).
          let opportunityUrl: string | undefined;
          if (nameColIdx !== undefined && typeof row.__rowIdx === 'number') {
            const addr = XLSX.utils.encode_cell({ r: row.__rowIdx, c: nameColIdx });
            const target = sheet[addr]?.l?.Target;
            if (target) opportunityUrl = String(target);
          }

          const resellerName = String(row[mapping.resellerName || ''] || '').trim() || undefined;
          const distributorReseller = String(row[mapping.distributorReseller || ''] || '').trim() || undefined;

          const forecastCategoryRaw = String(row[mapping.forecastCategory || ''] || '').trim();
          const forecastCategoryNorm = forecastCategoryRaw.toLowerCase();
          let classification = getImportedClassification({
            stage: row[mapping.stage || ''],
            forecastCategory: row[mapping.forecastCategory || ''],
            forecastFlag: row[mapping.forecast || ''],
            upsideFlag: row[mapping.upsideFlag || ''],
          });
          // Salesforce Forecast Category is authoritative: if SF explicitly says
          // Commit, the internal classification must be 'commit' regardless of
          // any prior/stale classification value.
          if (forecastCategoryNorm === 'commit' &&
              classification !== 'closed_won' &&
              classification !== 'lost' &&
              classification !== 'rejected' &&
              classification !== 'omitted') {
            classification = 'commit';
          }

          // Salesforce exports the stage verbatim ("Discovery 25%") and rarely a separate
          // probability column — so derive probability (0–1) from the stage, falling back
          // to the probability column when present.
          const rawStage = String(row[mapping.stage || ''] || '').trim();
          const parsed = parseStage(rawStage);
          const stageName = parsed.stage || rawStage;
          const stageProb = parsed.probability ? parseFloat(parsed.probability) / 100 : 0;
          // Salesforce exports the Probability column as 0-100; normalize to 0-1
          // so it matches the stage-derived scale (fixes the mixed-scale bug that
          // let 5%-probability deals pass the 25% SQL gate).
          const colProb = normalizeProbability(row[mapping.probability || '']);

          return {
            id: sfid || `import-${Date.now()}-${i}`,
            salesforceId: sfid,
            name: String(row[mapping.name || ''] || 'Unknown'),
            repId: '',
            repName: String(row[mapping.repName || ''] || 'Unassigned'),
            amount: parseFloat(row[mapping.amount || ''] || '0') || 0,
            // null (not 0) when the column is absent or blank: "no quote has run" is a
            // distinct state from "quoted at zero", and only null renders the neutral
            // Unquoted badge instead of a mismatch flag.
            amountMonthly: parseOptionalAmount(row[mapping.amountMonthly || '']),
            closeDate,
            stage: stageName,
            classification,
            lostDate: (() => { const s = stageName.toLowerCase(); return s === 'closed lost' || s === 'rejected' ? importDate : undefined; })(),
            lostReason: (() => { const s = stageName.toLowerCase(); if (s === 'closed lost') return 'Closed Lost in Salesforce'; if (s === 'rejected') return 'Rejected in Salesforce'; return undefined; })(),
            probability: stageProb || colProb,
            importDate,
            accountName: String(row[mapping.accountName || ''] || '').trim() || undefined,
            productName: String(row[mapping.productName || ''] || '').trim() || undefined,
            channelAccountManager: String(row[mapping.channelAccountManager || ''] || '').trim() || undefined,
            resellerName,
            distributorReseller,
            resolvedReseller: resolveReseller(resellerName, distributorReseller),
            opportunitySource: String(row[mapping.opportunitySource || ''] || '').trim() || undefined,
            nextStep: String(row[mapping.nextStep || ''] || '').trim() || undefined,
            description: String(row[mapping.description || ''] || '').trim() || undefined,
            forecastCategory: forecastCategoryRaw || undefined,
            managerNote,
            opportunityUrl,
          };
        });

        // Backfill opportunityUrl for rows without a hyperlink, using a URL origin
        // derived from any hyperlink present in this import + each row's salesforceId.
        const origin = originFromUrls(opps.map(o => o.opportunityUrl));
        for (const o of opps) {
          o.opportunityUrl = resolveOpportunityUrl(o.opportunityUrl, o.salesforceId, origin);
        }
        console.log(`[parser] opportunityUrl populated for ${opps.filter(o => o.opportunityUrl).length} of ${opps.length} opportunities`);

        setReview({ opps, fileName: file.name, headers, mapping: mapping as Record<string, string> });
      } catch (err) {
        setError('Failed to parse file. Ensure it is a valid Excel or CSV file.');
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = '';
  }, [processFile]);

  if (review) {
    return (
      <ImportReview
        incoming={review.opps}
        fileName={review.fileName}
        detectedHeaders={review.headers}
        columnMapping={review.mapping}
        onDone={() => {
          setLastImport({ name: review.fileName, count: review.opps.length });
          setReview(null);
          notifyImportComplete();
        }}
        onCancel={() => setReview(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
          dragOver ? 'border-foreground bg-secondary/50' : 'border-border hover:border-muted-foreground'
        }`}
        onClick={() => document.getElementById('file-input')?.click()}
      >
        <input id="file-input" type="file" accept=".xlsx,.xls,.csv" onChange={handleFileSelect} className="hidden" />
        <Upload className="mx-auto mb-3 text-muted-foreground" size={24} />
        <p className="text-sm text-muted-foreground">
          Drop your Salesforce export here or <span className="text-foreground underline">browse</span>
        </p>
        <p className="text-xs text-muted-foreground mt-1">.xlsx, .xls, or .csv</p>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-sm text-negative bg-negative/10 rounded-md px-3 py-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {lastImport && !error && (
        <div className="flex items-center gap-2 text-sm text-positive bg-positive/10 rounded-md px-3 py-2">
          <FileSpreadsheet size={16} />
          Imported {lastImport.count} opportunities from {lastImport.name}
        </div>
      )}

      <div className="text-xs text-muted-foreground space-y-1">
        <p className="font-medium">Expected columns (auto-mapped):</p>
        <p>Opportunity ID, Opportunity Name, Opportunity Owner, Amount, Close Date, Stage, Probability (%)</p>
        <p className="text-muted-foreground/80">Optional for DR Quality: Account Name, Product (or Product Family)</p>
      </div>
    </div>
  );
}
