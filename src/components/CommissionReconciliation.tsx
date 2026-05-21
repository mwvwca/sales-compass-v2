import { useMemo, useRef, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, ChevronRight, Upload, FileText, Download, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { parseCommissionStatement, type ParsedStatement } from '@/lib/commissionPdfParser';
import { reconcileCommission, type ReconciliationResult, type ReconciliationStatus } from '@/lib/commissionReconciliation';
import { getMonthLabel } from '@/types/forecast';
import * as XLSX from '@e965/xlsx';

const PDFJS_VERSION = '3.11.174';
const PDFJS_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;

declare global {
  interface Window {
    pdfjsLib?: any;
  }
}

let pdfLoadPromise: Promise<any> | null = null;

function loadPdfJs(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfLoadPromise) return pdfLoadPromise;
  pdfLoadPromise = new Promise<any>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PDFJS_SRC;
    script.async = true;
    script.onload = () => {
      const lib = window.pdfjsLib;
      if (!lib) {
        reject(new Error('PDF.js failed to load'));
        return;
      }
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      resolve(lib);
    };
    script.onerror = () => reject(new Error('Failed to load PDF.js from CDN'));
    document.head.appendChild(script);
  });
  return pdfLoadPromise;
}

async function extractPdfText(file: File): Promise<string> {
  const pdfjsLib = await loadPdfJs();
  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  let full = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = content.items as { str: string; transform?: number[] }[];
    // Group by y-coordinate (transform[5]) to reconstruct lines
    const byY = new Map<number, { x: number; str: string }[]>();
    for (const it of items) {
      if (typeof it.str !== 'string') continue;
      const y = Math.round((it.transform?.[5] ?? 0) * 10) / 10;
      const x = it.transform?.[4] ?? 0;
      const arr = byY.get(y) || [];
      arr.push({ x, str: it.str });
      byY.set(y, arr);
    }
    const ys = Array.from(byY.keys()).sort((a, b) => b - a);
    for (const y of ys) {
      const row = byY.get(y)!.sort((a, b) => a.x - b.x).map(r => r.str).join(' ').trim();
      if (row) full += row + '\n';
    }
    full += '\n';
  }
  return full;
}

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function previousMonthKey(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtSigned = (n: number) => (n >= 0 ? '+' : '') + fmt(n);

const STATUS_ORDER: Record<ReconciliationStatus, number> = {
  overpaid: 0,
  underpaid: 0,
  missing_from_statement: 1,
  missing_from_app: 2,
  match: 3,
};

function StatusBadge({ status, delta }: { status: ReconciliationStatus; delta: number }) {
  const base = 'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider';
  if (status === 'match') return <span className={`${base} bg-positive/15 text-positive`}>Match</span>;
  if (status === 'overpaid') return <span className={`${base} bg-commit/15 text-commit`}>Overpaid {fmtSigned(delta)}</span>;
  if (status === 'underpaid') return <span className={`${base} bg-negative/15 text-negative`}>Underpaid {fmtSigned(delta)}</span>;
  if (status === 'missing_from_statement') return <span className={`${base} bg-commit/15 text-commit`}>Not on Statement</span>;
  return <span className={`${base} bg-primary/15 text-primary`}>Unmatched PDF Line</span>;
}

export default function CommissionReconciliation() {
  const { reps, opportunities, commissionSettings, commissionReviews } = useForecast();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [selectedRep, setSelectedRep] = useState<string>(reps[0]?.name || '');
  const [selectedMonth, setSelectedMonth] = useState<string>(previousMonthKey());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedStatement | null>(null);
  const [rawTextOpen, setRawTextOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const monthOptions = useMemo(() => {
    const arr: string[] = [];
    const now = new Date();
    for (let i = -1; i < 12; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      arr.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return arr;
  }, []);

  const reconciliation: ReconciliationResult | null = useMemo(() => {
    if (!parsed || !selectedRep || !selectedMonth) return null;
    return reconcileCommission(parsed, opportunities, commissionSettings, commissionReviews, selectedRep, selectedMonth);
  }, [parsed, selectedRep, selectedMonth, opportunities, commissionSettings, commissionReviews]);

  const sortedLines = useMemo(() => {
    if (!reconciliation) return [];
    return [...reconciliation.lines].sort((a, b) => {
      const oa = STATUS_ORDER[a.status];
      const ob = STATUS_ORDER[b.status];
      if (oa !== ob) return oa - ob;
      return Math.abs(b.delta) - Math.abs(a.delta);
    });
  }, [reconciliation]);

  const parserFailed = parsed && parsed.lines.every(l => l.lineType !== 'deal');

  const handleFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      toast({ title: 'Invalid file', description: 'Please upload a PDF.', variant: 'destructive' });
      return;
    }
    if (!selectedRep) {
      toast({ title: 'Select a rep', description: 'Choose a rep before uploading.', variant: 'destructive' });
      return;
    }
    setLoading(true);
    setError(null);
    setParsed(null);
    try {
      const text = await extractPdfText(file);
      const result = parseCommissionStatement(text, opportunities);
      setParsed(result);
      toast({ title: 'Statement parsed', description: `${result.lines.filter(l => l.lineType === 'deal').length} deal lines detected.` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast({ title: 'PDF parse failed', description: msg, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = '';
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const exportXlsx = () => {
    if (!reconciliation) return;
    const wb = XLSX.utils.book_new();
    const summary = [
      ['Commission Reconciliation'],
      ['Rep', reconciliation.repName],
      ['Month', getMonthLabel(reconciliation.monthKey)],
      [],
      ['App Total', reconciliation.appTotal],
      ['Statement Total', reconciliation.statementTotal],
      ['Delta', reconciliation.totalDelta],
      [],
      ['Matched', reconciliation.matchedCount],
      ['Discrepancies', reconciliation.discrepancyCount],
      ['Missing from Statement', reconciliation.missingFromStatement],
      ['Unmatched PDF Lines', reconciliation.missingFromApp],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(summary);
    ws1['!cols'] = [{ wch: 28 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

    const detail = [
      ['Opportunity Name', 'Rep', 'App Commission', 'Statement Commission', 'Delta', 'Status', 'Raw PDF Line'],
      ...sortedLines.map(l => [
        l.opportunityName, l.repName, l.appCommissionDollars,
        l.statementCommission ?? '', l.delta, l.status, l.statementRawLine || '',
      ]),
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(detail);
    ws2['!cols'] = [{ wch: 42 }, { wch: 20 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 22 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Deal Detail');

    XLSX.writeFile(wb, `Commission_Reconciliation_${reconciliation.repName.replace(/\s+/g, '_')}_${reconciliation.monthKey}.xlsx`);
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-4 border-t border-border pt-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Commission statement reconciliation</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Upload your company's PDF statement to validate deal-by-deal payouts.</p>
        </div>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="gap-1.5">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            {open ? 'Hide' : 'Show'}
          </Button>
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent className="space-y-4">
        {/* Rep + Month selectors */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Rep</label>
            <select
              value={selectedRep}
              onChange={e => setSelectedRep(e.target.value)}
              className="bg-secondary border border-border rounded-md px-3 py-1.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">Select rep…</option>
              {reps.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Statement month</label>
            <select
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
              className="bg-secondary border border-border rounded-md px-3 py-1.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {monthOptions.map(m => <option key={m} value={m}>{getMonthLabel(m)}</option>)}
            </select>
          </div>
          {reconciliation && (
            <Button type="button" variant="outline" size="sm" onClick={exportXlsx} className="gap-1.5 ml-auto">
              <Download className="h-3.5 w-3.5" />
              Export Reconciliation
            </Button>
          )}
        </div>

        {/* Upload zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-secondary/30'}`}
        >
          <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" onChange={onPick} className="hidden" />
          {loading ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-xs">Extracting statement data…</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Upload className="h-6 w-6" />
              <p className="text-xs">Drag &amp; drop a PDF here, or click to browse</p>
              <p className="text-[10px]">PDF only · processed locally in your browser</p>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-md border border-negative/40 bg-negative/10 p-3 text-xs text-negative">
            {error}
          </div>
        )}

        {parsed && parserFailed && (
          <div className="rounded-md border border-commit/40 bg-commit/10 p-3 text-xs text-commit">
            Could not automatically parse this statement format — use the raw text below to review manually.
          </div>
        )}

        {/* Summary bar */}
        {reconciliation && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-card border border-border rounded-lg p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">App vs Statement</p>
              <p className="text-sm font-mono">{fmt(reconciliation.appTotal)} → {fmt(reconciliation.statementTotal)}</p>
              <p className={`text-xs font-mono mt-0.5 ${reconciliation.totalDelta === 0 ? 'text-muted-foreground' : reconciliation.totalDelta > 0 ? 'text-commit' : 'text-negative'}`}>
                Δ {fmtSigned(reconciliation.totalDelta)}
              </p>
            </div>
            <div className="bg-card border border-border rounded-lg p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Matched</p>
              <p className="text-lg font-mono font-semibold text-positive">{reconciliation.matchedCount}</p>
            </div>
            <div className="bg-card border border-border rounded-lg p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Discrepancies</p>
              <p className={`text-lg font-mono font-semibold ${reconciliation.discrepancyCount > 0 ? 'text-negative' : 'text-foreground'}`}>{reconciliation.discrepancyCount}</p>
            </div>
            <div className="bg-card border border-border rounded-lg p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Missing from Statement</p>
              <p className={`text-lg font-mono font-semibold ${reconciliation.missingFromStatement > 0 ? 'text-commit' : 'text-foreground'}`}>{reconciliation.missingFromStatement}</p>
            </div>
          </div>
        )}

        {/* Reconciliation table */}
        {reconciliation && sortedLines.length > 0 && (
          <div className="border border-border rounded-lg overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-secondary/50">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground uppercase tracking-wider">Opportunity</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground uppercase tracking-wider">Rep</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground uppercase tracking-wider">App $</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground uppercase tracking-wider">Statement $</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground uppercase tracking-wider">Delta</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody>
                {sortedLines.map((l, i) => (
                  <tr key={i} className="border-b border-border last:border-0 hover:bg-secondary/30">
                    <td className="px-3 py-2 truncate max-w-[280px]" title={l.statementRawLine || l.opportunityName}>{l.opportunityName}</td>
                    <td className="px-3 py-2 text-muted-foreground">{l.repName}</td>
                    <td className="px-3 py-2 text-right font-mono">{l.appCommissionDollars ? fmt(l.appCommissionDollars) : '—'}</td>
                    <td className="px-3 py-2 text-right font-mono">{l.statementCommission !== undefined ? fmt(l.statementCommission) : '—'}</td>
                    <td className={`px-3 py-2 text-right font-mono ${l.delta > 0 ? 'text-commit' : l.delta < 0 ? 'text-negative' : 'text-muted-foreground'}`}>{l.delta ? fmtSigned(l.delta) : '—'}</td>
                    <td className="px-3 py-2"><StatusBadge status={l.status} delta={l.delta} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Raw text panel */}
        {parsed && (
          <Collapsible open={rawTextOpen} onOpenChange={setRawTextOpen}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="gap-1.5">
                <FileText className="h-3.5 w-3.5" />
                {rawTextOpen ? 'Hide raw statement text' : 'Show raw statement text — for manual review'}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <pre className="bg-secondary border border-border rounded-md p-3 text-[10px] font-mono whitespace-pre-wrap max-h-96 overflow-auto">
                {parsed.rawText}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
