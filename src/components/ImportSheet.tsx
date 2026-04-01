import { useCallback, useState } from 'react';
import type { Opportunity } from '@/types/forecast';
import { Upload, FileSpreadsheet, AlertCircle } from 'lucide-react';
import * as XLSX from '@e965/xlsx';
import ImportReview from './ImportReview';

interface ColumnMapping {
  id: string;
  name: string;
  repName: string;
  amount: string;
  closeDate: string;
  stage: string;
  probability: string;
}

const DEFAULT_MAPPINGS: Record<string, string> = {
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
  'upside': 'upsideFlag',
};

function autoMap(headers: string[]): Partial<ColumnMapping> {
  const mapping: Partial<ColumnMapping> = {};
  for (const h of headers) {
    const key = h.toLowerCase().trim();
    const field = DEFAULT_MAPPINGS[key];
    if (field) (mapping as any)[field] = h;
  }
  return mapping;
}

export default function ImportSheet() {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<{ name: string; count: number } | null>(null);
  const [review, setReview] = useState<{ opps: Opportunity[]; fileName: string } | null>(null);

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

        const headers = rawRows[headerRowIdx].map((c: any) => String(c).trim());
        const mapping = autoMap(headers);

        // Build rows as objects from headerRowIdx + 1 onward
        const rows: Record<string, any>[] = [];
        for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
          const obj: Record<string, any> = {};
          let hasValue = false;
          for (let j = 0; j < headers.length; j++) {
            if (headers[j]) {
              obj[headers[j]] = rawRows[i]?.[j] ?? '';
              if (String(rawRows[i]?.[j] ?? '').trim()) hasValue = true;
            }
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

        const importDate = new Date().toISOString();
        const opps: Opportunity[] = rows.map((row, i) => {
          const rawDate = row[mapping.closeDate || ''] || '';
          let closeDate = '';
          if (rawDate) {
            const parsed = new Date(rawDate);
            closeDate = isNaN(parsed.getTime()) ? '' : parsed.toISOString().split('T')[0];
          }

          return {
            id: String(row[mapping.id || ''] || `import-${Date.now()}-${i}`).trim(),
            name: String(row[mapping.name || ''] || 'Unknown'),
            repId: '',
            repName: String(row[mapping.repName || ''] || 'Unassigned'),
            amount: parseFloat(row[mapping.amount || ''] || '0') || 0,
            closeDate,
            stage: String(row[mapping.stage || ''] || '').trim(),
            classification: (() => {
              const stageNorm = String(row[mapping.stage || ''] || '').toLowerCase().trim().replace(/[-_/]/g, ' ').replace(/\s+/g, ' ');
              if (stageNorm === 'closed won') return 'closed_won' as const;
              if (stageNorm === 'closed lost') return 'lost' as const;
              return 'unclassified' as const;
            })(),
            lostDate: String(row[mapping.stage || ''] || '').toLowerCase().trim() === 'closed lost' ? importDate : undefined,
            lostReason: String(row[mapping.stage || ''] || '').toLowerCase().trim() === 'closed lost' ? 'Closed Lost in Salesforce' : undefined,
            probability: parseFloat(row[mapping.probability || ''] || '0') || 0,
            importDate,
          };
        });

        setReview({ opps, fileName: file.name });
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
        onDone={() => {
          setLastImport({ name: review.fileName, count: review.opps.length });
          setReview(null);
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
      </div>
    </div>
  );
}
