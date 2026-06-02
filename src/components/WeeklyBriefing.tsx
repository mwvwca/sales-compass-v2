import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Copy, RotateCcw, X, Loader2, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useForecast } from '@/context/ForecastContext';
import { buildBriefingPayload } from '@/lib/briefingDataBuilder';
import { generateBriefing } from '@/lib/briefingApi';
import {
  type BriefingMode,
  getBriefingMode,
  MODE_LABELS,
  MODE_DESCRIPTIONS,
} from '@/lib/briefingPrompts';

interface BriefingRecord {
  id: string;
  mode: BriefingMode;
  generatedAt: string;
  text: string;
}

const BRIEFING_OPEN_EVENT = 'briefing:open';
const IMPORT_COMPLETE_EVENT = 'briefing:import-complete';

export function openBriefingPanel() {
  window.dispatchEvent(new CustomEvent(BRIEFING_OPEN_EVENT));
}

export function notifyImportComplete() {
  window.dispatchEvent(new CustomEvent(IMPORT_COMPLETE_EVENT));
}

const MODE_OPTIONS: { value: BriefingMode; label: string }[] = [
  { value: 'oneOnOne', label: '1:1 Prep (Monday)' },
  { value: 'standup', label: 'Standup (Wednesday)' },
  { value: 'forecast', label: 'Forecast Call (Friday)' },
  { value: 'general', label: 'Import Summary' },
];

function formatDate(d: Date) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export default function WeeklyBriefing() {
  const ctx = useForecast();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<BriefingMode>(() => getBriefingMode(new Date()));
  const [text, setText] = useState<string>('');
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<BriefingRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  const hasImports = ctx.imports.length > 0;
  const todayLabel = useMemo(() => formatDate(new Date()), []);

  // External open trigger
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(BRIEFING_OPEN_EVENT, handler);
    return () => window.removeEventListener(BRIEFING_OPEN_EVENT, handler);
  }, []);

  const runGenerate = useCallback(async () => {
    if (!hasImports) {
      setError('Import your Salesforce data first to generate a briefing.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload = buildBriefingPayload({
        mode,
        opportunities: ctx.opportunities,
        reps: ctx.reps,
        imports: ctx.imports,
        changelog: ctx.changelog,
        dealRegistrations: ctx.dealRegistrations,
        monthlyManagerCommits: ctx.monthlyManagerCommits,
        managerQuotas: ctx.managerQuotas,
      });
      const result = await generateBriefing(payload, mode);
      const now = new Date().toISOString();
      setText(result);
      setGeneratedAt(now);
      setHistory(prev => [
        { id: `${Date.now()}`, mode, generatedAt: now, text: result },
        ...prev,
      ].slice(0, 5));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate briefing');
    } finally {
      setLoading(false);
      setConfirmRegenerate(false);
    }
  }, [ctx, mode, hasImports]);

  const handleCopy = useCallback(async () => {
    if (!text) return;
    const header = `[Sales Compass — ${MODE_LABELS[mode]} — ${todayLabel}]\n\n`;
    try {
      await navigator.clipboard.writeText(header + text);
      toast({ title: 'Copied!', description: 'Briefing copied to clipboard.' });
    } catch {
      toast({ title: 'Copy failed', description: 'Clipboard access blocked.', variant: 'destructive' });
    }
  }, [text, mode, todayLabel, toast]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs gap-1.5"
          title="Generate AI briefing"
        >
          <Sparkles size={13} />
          Briefing
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[520px] flex flex-col p-0 gap-0"
      >
        <SheetHeader className="px-5 py-4 border-b border-border">
          <div className="flex items-start justify-between gap-3">
            <div>
              <SheetTitle className="text-sm font-semibold flex items-center gap-2">
                <Sparkles size={14} className="text-foreground" />
                {MODE_LABELS[mode].toUpperCase()}
              </SheetTitle>
              <p className="text-xs text-muted-foreground mt-0.5">{todayLabel}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-2">
            <span className="text-xs text-muted-foreground">Mode</span>
            <Select value={mode} onValueChange={v => setMode(v as BriefingMode)}>
              <SelectTrigger className="h-7 text-xs flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODE_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="h-7 text-xs px-3"
              onClick={runGenerate}
              disabled={loading || !hasImports}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : 'Generate'}
            </Button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-auto px-5 py-4 bg-secondary/30">
          {!hasImports && (
            <div className="text-xs text-muted-foreground flex items-start gap-2 p-3 rounded border border-border bg-background">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>Import your Salesforce data first to generate a briefing.</span>
            </div>
          )}

          {hasImports && !text && !loading && !error && (
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground leading-relaxed p-3 rounded border border-border bg-background">
                {MODE_DESCRIPTIONS[mode]}
              </div>
              <p className="text-xs text-muted-foreground">
                Click <span className="font-medium text-foreground">Generate</span> to produce your briefing.
              </p>
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-8 justify-center">
              <Loader2 size={14} className="animate-spin" />
              Generating your {MODE_LABELS[mode]} briefing…
            </div>
          )}

          {error && !loading && (
            <div className="space-y-3">
              <div className="text-xs text-destructive flex items-start gap-2 p-3 rounded border border-destructive/30 bg-destructive/10">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span className="break-words">{error}</span>
              </div>
              <Button size="sm" variant="outline" onClick={runGenerate} disabled={!hasImports}>
                Retry
              </Button>
            </div>
          )}

          {text && !loading && (
            <div className="space-y-3">
              <pre className="text-xs leading-[1.6] whitespace-pre-wrap font-sans text-foreground bg-background border border-border rounded p-4">
                {text}
              </pre>
              {generatedAt && (
                <p className="text-[11px] text-muted-foreground">
                  Last generated: today at {formatTime(generatedAt)}
                </p>
              )}
            </div>
          )}

          {history.length > 0 && (
            <div className="mt-4 pt-3 border-t border-border">
              <button
                onClick={() => setShowHistory(s => !s)}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                History ({history.length})
              </button>
              {showHistory && (
                <ul className="mt-2 space-y-1">
                  {history.map(h => (
                    <li key={h.id}>
                      <button
                        onClick={() => {
                          setText(h.text);
                          setGeneratedAt(h.generatedAt);
                          setMode(h.mode);
                          setError(null);
                        }}
                        className="w-full text-left text-xs text-muted-foreground hover:text-foreground hover:bg-secondary px-2 py-1 rounded"
                      >
                        {MODE_LABELS[h.mode]} — {formatTime(h.generatedAt)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border px-5 py-3 flex items-center gap-2">
          <Button
            size="sm"
            variant="default"
            className="h-8 text-xs gap-1.5"
            onClick={handleCopy}
            disabled={!text}
          >
            <Copy size={12} />
            Copy for Teams
          </Button>
          {confirmRegenerate ? (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Use API credits?</span>
              <Button size="sm" variant="outline" className="h-7 text-xs px-2" onClick={runGenerate}>Yes</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => setConfirmRegenerate(false)}>No</Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1.5"
              onClick={() => setConfirmRegenerate(true)}
              disabled={!text || loading}
            >
              <RotateCcw size={12} />
              Regenerate
            </Button>
          )}
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs gap-1.5"
            onClick={() => setOpen(false)}
          >
            <X size={12} />
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Banner shown after a successful import, prompting the user to generate a briefing. */
export function PostImportBriefingBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = () => setVisible(true);
    window.addEventListener(IMPORT_COMPLETE_EVENT, handler);
    return () => window.removeEventListener(IMPORT_COMPLETE_EVENT, handler);
  }, []);

  if (!visible) return null;

  return (
    <div className="bg-foreground/5 border-b border-border px-6 py-2 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-xs">
        <Sparkles size={13} />
        <span className="font-medium">New import complete</span>
        <span className="text-muted-foreground">— Generate your briefing?</span>
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="default"
          className="h-7 text-xs px-2"
          onClick={() => {
            openBriefingPanel();
            setVisible(false);
          }}
        >
          Generate Now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs px-2"
          onClick={() => setVisible(false)}
        >
          Later
          <X size={11} className="ml-0.5" />
        </Button>
      </div>
    </div>
  );
}
