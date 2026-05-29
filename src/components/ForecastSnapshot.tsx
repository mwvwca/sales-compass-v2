import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { X, Copy, Download, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import type { ForecastSnapshot } from '@/types/forecast';
import { getWeeksInMonth } from '@/types/forecast';

interface Props {
  snapshot: ForecastSnapshot;
  onClose: () => void;
}

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const fmtDay = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

function abbreviateRep(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

async function ensureHtml2Canvas(): Promise<any> {
  const w = window as any;
  if (w.html2canvas) return w.html2canvas;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load screenshot library'));
    document.head.appendChild(s);
  });
  return w.html2canvas;
}

export default function ForecastSnapshotView({ snapshot, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const [busy, setBusy] = useState<'copy' | 'download' | null>(null);

  const weeks = useMemo(() => getWeeksInMonth(snapshot.monthKey), [snapshot.monthKey]);

  const dealsByWeek = useMemo(() => {
    const map = new Map<string, typeof snapshot.deals>();
    for (const w of weeks) map.set(w.label, []);
    for (const d of snapshot.deals) {
      const arr = map.get(d.weekLabel) ?? [];
      arr.push(d);
      map.set(d.weekLabel, arr);
    }
    return map;
  }, [snapshot.deals, weeks]);

  const outcomeByOpp = useMemo(() => {
    const m = new Map<string, NonNullable<ForecastSnapshot['outcomes']>[number]>();
    for (const o of snapshot.outcomes ?? []) m.set(o.opportunityId, o);
    return m;
  }, [snapshot.outcomes]);

  const monthLabel = useMemo(() => {
    const d = new Date(`${snapshot.monthKey}-01T00:00:00Z`);
    return d.toLocaleString('default', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }, [snapshot.monthKey]);

  const createdLabel = useMemo(() => {
    const d = new Date(snapshot.createdAt);
    return `${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }, [snapshot.createdAt]);

  const weekRangeLabel = (w: typeof weeks[number]) =>
    `${w.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}–${w.end.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'UTC' })}`;

  const handleDownload = async () => {
    if (!cardRef.current) return;
    setBusy('download');
    try {
      const h2c = await ensureHtml2Canvas();
      const canvas = await h2c(cardRef.current, { backgroundColor: '#ffffff', scale: 2 });
      const link = document.createElement('a');
      link.download = `forecast-${snapshot.monthKey}-${snapshot.id.slice(0, 8)}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      toast({ title: 'PNG downloaded' });
    } catch (err) {
      toast({ title: 'Could not download', description: String(err), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const handleCopy = async () => {
    if (!cardRef.current) return;
    setBusy('copy');
    try {
      const h2c = await ensureHtml2Canvas();
      const canvas = await h2c(cardRef.current, { backgroundColor: '#ffffff', scale: 2 });
      const blob: Blob = await new Promise(resolve => canvas.toBlob((b: Blob | null) => resolve(b as Blob), 'image/png'));
      // @ts-ignore
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast({ title: 'Copied to clipboard' });
    } catch (err) {
      try {
        const text = buildPlainText(snapshot, monthLabel, createdLabel);
        await navigator.clipboard.writeText(text);
        toast({ title: 'Copied as plain text', description: 'Image copy not supported in this browser.' });
      } catch {
        toast({ title: 'Could not copy', variant: 'destructive' });
      }
    } finally {
      setBusy(null);
    }
  };

  // Inline styles — explicit light-mode colors so screenshot renders consistently regardless of app theme.
  const headerBg = '#1C2B4A';
  const headerText = '#FFFFFF';
  const cardBg = '#FFFFFF';
  const subtleText = '#5B6478';
  const ruleColor = '#E6E8EE';
  const labelText = '#7A8497';
  const valueText = '#0F172A';
  const commitGreen = '#16A34A';
  const upsideGold = '#D4A017';

  return (
    <div className="fixed inset-0 z-50 bg-black/60 overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex flex-col items-center py-8 px-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <Button size="sm" variant="secondary" onClick={handleCopy} disabled={busy !== null} className="gap-1.5">
            {busy === 'copy' ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />} Copy to clipboard
          </Button>
          <Button size="sm" variant="secondary" onClick={handleDownload} disabled={busy !== null} className="gap-1.5">
            {busy === 'download' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Download PNG
          </Button>
          <Button size="sm" variant="secondary" onClick={onClose} className="gap-1.5">
            <X size={14} /> Close
          </Button>
        </div>

        <div
          ref={cardRef}
          style={{
            width: '680px',
            background: cardBg,
            color: valueText,
            fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            borderRadius: '8px',
            overflow: 'hidden',
            boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
          }}
        >
          {/* Header */}
          <div style={{ background: headerBg, color: headerText, padding: '20px 24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '16px', fontWeight: 700, letterSpacing: '0.05em' }}>🧭 SALES COMPASS</div>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>{monthLabel} Forecast</div>
            </div>
            <div style={{ fontSize: '12px', marginTop: '4px', opacity: 0.8 }}>Forecasted {createdLabel}</div>
          </div>

          {/* KPI row */}
          <div style={{ background: headerBg, color: headerText, padding: '0 24px 20px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
            {[
              { label: 'MY COMMIT', value: snapshot.managerCommit },
              { label: 'COMMIT DEALS', value: snapshot.commitTotal },
              { label: 'PROMOTED UPSIDE', value: snapshot.promotedUpsideTotal },
              { label: 'TOTAL CALL', value: snapshot.totalCall },
            ].map(k => (
              <div key={k.label}>
                <div style={{ fontSize: '10px', opacity: 0.7, letterSpacing: '0.08em' }}>{k.label}</div>
                <div style={{ fontSize: '18px', fontWeight: 700, marginTop: '2px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                  {fmtMoney(k.value)}
                </div>
              </div>
            ))}
          </div>

          {/* Deal list */}
          <div style={{ padding: '20px 24px' }}>
            {weeks.map(w => {
              const list = dealsByWeek.get(w.label) ?? [];
              const subtotal = list.reduce((s, d) => s + d.amount, 0);
              return (
                <div key={w.label} style={{ marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: `1px solid ${ruleColor}`, paddingBottom: '4px', marginBottom: '6px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 700, color: labelText, letterSpacing: '0.08em' }}>
                      {w.label.toUpperCase()} · {weekRangeLabel(w)}
                    </div>
                    <div style={{ fontSize: '12px', fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>{fmtMoney(subtotal)}</div>
                  </div>
                  {list.length === 0 ? (
                    <div style={{ fontSize: '11px', color: subtleText, fontStyle: 'italic' }}>—</div>
                  ) : (
                    list.map(d => (
                      <div key={d.opportunityId} style={{ display: 'grid', gridTemplateColumns: '16px 1fr 110px 90px 70px', alignItems: 'center', fontSize: '12px', padding: '3px 0' }}>
                        <span style={{ color: d.classification === 'commit' ? commitGreen : upsideGold, fontSize: '14px' }}>
                          {d.classification === 'commit' ? '●' : '★'}
                        </span>
                        <span style={{ color: valueText }}>{d.opportunityName}{d.classification === 'promoted_upside' ? ' (upside)' : ''}</span>
                        <span style={{ color: subtleText }}>{abbreviateRep(d.repName)}</span>
                        <span style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>{fmtMoney(d.amount)}</span>
                        <span style={{ textAlign: 'right', color: subtleText }}>{fmtDay(d.closeDate)}</span>
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div style={{ borderTop: `1px solid ${ruleColor}`, padding: '10px 24px', fontSize: '11px', color: subtleText, display: 'flex', gap: '16px' }}>
            <span><span style={{ color: commitGreen }}>●</span> Commit</span>
            <span><span style={{ color: upsideGold }}>★</span> Promoted Upside</span>
          </div>

          {/* Outcome */}
          {snapshot.reconciledAt && snapshot.outcomes && (
            <div style={{ borderTop: `2px solid ${ruleColor}`, padding: '16px 24px', background: '#FAFBFC' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: labelText, letterSpacing: '0.08em', marginBottom: '8px' }}>
                OUTCOME (reconciled {fmtDay(snapshot.reconciledAt)})
              </div>
              <div style={{ fontSize: '12px', marginBottom: '10px' }}>
                Called: <strong>{fmtMoney(snapshot.totalCall)}</strong> &nbsp;·&nbsp;
                Closed Won: <strong style={{ color: commitGreen }}>{fmtMoney(snapshot.closedWonTotal ?? 0)}</strong> &nbsp;·&nbsp;
                Variance: <strong>{fmtMoney((snapshot.closedWonTotal ?? 0) - snapshot.totalCall)}</strong> &nbsp;·&nbsp;
                Accuracy: <strong>{snapshot.totalCall > 0 ? Math.round(((snapshot.closedWonTotal ?? 0) / snapshot.totalCall) * 100) : 0}%</strong>
              </div>
              {snapshot.deals.map(d => {
                const o = outcomeByOpp.get(d.opportunityId);
                if (!o) return null;
                const icon = o.status === 'won' ? '✓' : o.status === 'lost' ? '✗' : o.status === 'pushed' ? '→' : o.status === 'pending' ? '○' : '–';
                const color = o.status === 'won' ? commitGreen : o.status === 'lost' ? '#DC2626' : o.status === 'pushed' ? '#D97706' : subtleText;
                const note = o.status === 'won' ? `Closed Won ${fmtDay(o.closedDate ?? '')}`
                  : o.status === 'lost' ? `Closed Lost ${fmtDay(o.closedDate ?? '')}`
                  : o.status === 'pushed' ? 'Pushed'
                  : o.status === 'pending' ? 'Pending'
                  : 'Removed from pipeline';
                return (
                  <div key={d.opportunityId} style={{
                    display: 'grid', gridTemplateColumns: '16px 1fr 90px 1fr', fontSize: '11px', padding: '2px 0',
                    textDecoration: o.status === 'removed' ? 'line-through' : 'none',
                    color: o.status === 'removed' ? subtleText : valueText,
                  }}>
                    <span style={{ color }}>{icon}</span>
                    <span>{d.opportunityName}</span>
                    <span style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>{fmtMoney(o.amount)}</span>
                    <span style={{ paddingLeft: '12px', color: subtleText }}>{note}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function buildPlainText(snap: ForecastSnapshot, monthLabel: string, createdLabel: string): string {
  const lines: string[] = [];
  lines.push(`SALES COMPASS — ${monthLabel} Forecast`);
  lines.push(`Forecasted ${createdLabel}`);
  lines.push('');
  lines.push(`My Commit: ${fmtMoney(snap.managerCommit)}  |  Commit Deals: ${fmtMoney(snap.commitTotal)}  |  Promoted Upside: ${fmtMoney(snap.promotedUpsideTotal)}  |  Total Call: ${fmtMoney(snap.totalCall)}`);
  lines.push('');
  const byWeek = new Map<string, typeof snap.deals>();
  for (const d of snap.deals) {
    const arr = byWeek.get(d.weekLabel) ?? [];
    arr.push(d);
    byWeek.set(d.weekLabel, arr);
  }
  for (const [wk, list] of byWeek) {
    const subtotal = list.reduce((s, d) => s + d.amount, 0);
    lines.push(`${wk}  ${fmtMoney(subtotal)}`);
    for (const d of list) {
      const marker = d.classification === 'commit' ? '●' : '★';
      lines.push(`  ${marker} ${d.opportunityName} — ${abbreviateRep(d.repName)} — ${fmtMoney(d.amount)} — ${fmtDay(d.closeDate)}`);
    }
  }
  return lines.join('\n');
}
