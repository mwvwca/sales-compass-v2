import { useCallback, useState } from 'react';
import type { Opportunity } from '@/types/forecast';
import { Upload, FileSpreadsheet, AlertCircle } from 'lucide-react';
import * as XLSX from '@e965/xlsx';
import { getImportedClassification } from '@/lib/forecastClassification';
import { resolveReseller } from '@/lib/resellerUtils';
import ImportReview from './ImportReview';
import { notifyImportComplete } from './WeeklyBriefing';

interface ColumnMapping {
  id: string;
  name: string;
  repName: string;
  amount: string;
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
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

const DEFAULT_MAPPINGS: Record<string, keyof ColumnMapping> = {
  'opportunity id': 'id',
  'opportunity name': 'name',
  'opportunity owner': 'repName',
  'owner': 'repName',
  'rep': 'repName',
  'rep name': 'repName',
  'amount': 'amount',
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
};

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

          const resellerName = String(row[mapping.resellerName || ''] || '').trim() || undefined;
          const distributorReseller = String(row[mapping.distributorReseller || ''] || '').trim() || undefined;

          return {
            id: sfid || `import-${Date.now()}-${i}`,
            salesforceId: sfid,
            name: String(row[mapping.name || ''] || 'Unknown'),
            repId: '',
            repName: String(row[mapping.repName || ''] || 'Unassigned'),
            amount: parseFloat(row[mapping.amount || ''] || '0') || 0,
            closeDate,
            stage: String(row[mapping.stage || ''] || '').trim(),
            classification: getImportedClassification({
              stage: row[mapping.stage || ''],
              forecastCategory: row[mapping.forecastCategory || ''],
              forecastFlag: row[mapping.forecast || ''],
              upsideFlag: row[mapping.upsideFlag || ''],
            }),
            lostDate: (() => { const s = String(row[mapping.stage || ''] || '').toLowerCase().trim(); return s === 'closed lost' || s === 'rejected' ? importDate : undefined; })(),
            lostReason: (() => { const s = String(row[mapping.stage || ''] || '').toLowerCase().trim(); if (s === 'closed lost') return 'Closed Lost in Salesforce'; if (s === 'rejected') return 'Rejected in Salesforce'; return undefined; })(),
            probability: parseFloat(row[mapping.probability || ''] || '0') || 0,
            importDate,
            accountName: String(row[mapping.accountName || ''] || '').trim() || undefined,
            productName: String(row[mapping.productName || ''] || '').trim() || undefined,
            channelAccountManager: String(row[mapping.channelAccountManager || ''] || '').trim() || undefined,
          };
        });

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
