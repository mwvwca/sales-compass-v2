import { useForecast } from '@/context/ForecastContext';
import { AlertTriangle, CheckCircle2, Filter } from 'lucide-react';

/**
 * Recent import attempts, successes and failures alike.
 *
 * A failed import used to leave no trace at all — the 20MB attempt on 2026-08-31 was
 * invisible after the fact. Every attempt now appears here with its gate outcome or
 * its error.
 */
export default function ImportLog() {
  const { imports } = useForecast();
  if (imports.length === 0) return null;

  const recent = [...imports].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
  const fmtTs = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  };

  return (
    <div className="mt-6">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
        Import log
      </h3>
      <div className="space-y-1.5">
        {recent.map(r => {
          const failed = r.status === 'failed';
          return (
            <div
              key={r.id}
              className={`text-xs px-3 py-2 rounded border ${
                failed
                  ? 'border-negative/30 bg-negative/10 text-negative'
                  : 'border-border bg-secondary/30'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 min-w-0">
                  {failed
                    ? <AlertTriangle size={12} className="shrink-0" />
                    : <CheckCircle2 size={12} className="shrink-0 text-positive" />}
                  <span className="font-medium truncate">{r.fileName}</span>
                </span>
                <span className="font-mono text-[11px] text-muted-foreground shrink-0">{fmtTs(r.date)}</span>
              </div>

              {failed ? (
                <div className="text-[11px] mt-1 opacity-90">Failed — {r.error || 'unknown error'}</div>
              ) : (
                <div className="text-[11px] mt-1 text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
                  <span>{r.opportunityCount.toLocaleString()} merged</span>
                  {r.gate && (
                    <>
                      <span className="flex items-center gap-1">
                        <Filter size={10} /> {r.gate.keptTeam.toLocaleString()} team
                      </span>
                      <span>{r.gate.keptKnownId.toLocaleString()} known ID</span>
                      <span className={r.gate.discarded > 0 ? 'text-upside' : ''}>
                        {r.gate.discarded.toLocaleString()} discarded
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-muted-foreground mt-2">
        Discarded rows are owned by someone not on the team roster and have an Opportunity ID
        the app has never stored. Their owners are still added to the roster for review — classify
        someone onto the team and their deals arrive on the next import.
      </p>
    </div>
  );
}
