import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { rosterKey, isTeamStatus } from '@/lib/repUtils';
import { Users, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

/**
 * Owner roster management.
 *
 * Every owner name the app has ever seen, with its current deal count and a membership
 * toggle. Membership is what isTeamOwned() reads, evaluated at render time — toggling
 * takes effect on the next render with no reimport and nothing stamped on any record.
 *
 * The first-seen date is the name-drift tell: a familiar person showing a recent
 * first-seen date is almost certainly a Salesforce spelling variant of someone already
 * on the roster (the Richard/Rich Morris, Matt/Matthew Johnson pattern), not a new hire.
 */
export default function OwnerRoster() {
  const { reps, opportunities, dealRegistrations, setRepStatus } = useForecast();
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('');

  // Deal counts by exact trimmed owner name — the same key the roster matches on, so a
  // spelling variant shows its own separate count rather than being folded in.
  const counts = useMemo(() => {
    const opps = new Map<string, number>();
    const drs = new Map<string, number>();
    for (const o of opportunities) {
      const k = rosterKey(o.repName);
      if (k) opps.set(k, (opps.get(k) ?? 0) + 1);
    }
    for (const d of dealRegistrations) {
      const k = rosterKey(d.repName);
      if (k) drs.set(k, (drs.get(k) ?? 0) + 1);
    }
    return { opps, drs };
  }, [opportunities, dealRegistrations]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return reps
      .map(r => ({
        id: r.id,
        name: rosterKey(r.name),
        team: isTeamStatus(r),
        firstSeen: r.firstSeen || '',
        oppCount: counts.opps.get(rosterKey(r.name)) ?? 0,
        drCount: counts.drs.get(rosterKey(r.name)) ?? 0,
      }))
      .filter(r => !q || r.name.toLowerCase().includes(q))
      // Team first, then most deals, then name — the people you act on sit at the top.
      .sort((a, b) =>
        Number(b.team) - Number(a.team) ||
        (b.oppCount + b.drCount) - (a.oppCount + a.drCount) ||
        a.name.localeCompare(b.name),
      );
  }, [reps, counts, query]);

  const teamCount = rows.filter(r => r.team).length;

  const fmtDate = (iso: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      ...(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? { timeZone: 'UTC' as const } : {}),
    });
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full text-left py-2 px-1 hover:bg-secondary/30 rounded transition-colors">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Users size={12} className="text-muted-foreground" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Owner Roster
        </span>
        <span className="text-[10px] text-muted-foreground">
          {teamCount} on team · {reps.length - teamCount} not on team
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-2">
        <div className="border border-border rounded-lg p-4">
          <p className="text-[11px] text-muted-foreground mb-3">
            Team membership is decided here, keyed on the Salesforce <span className="font-mono">Opportunity Owner</span> name
            (exact match, case-sensitive). Off-team owners keep their deals visible but contribute nothing to
            funnel totals, forecast rollups, or DR cleanup emails. Toggling takes effect immediately — no reimport.
            A familiar name with a recent first-seen date is usually a Salesforce spelling variant, not a new person.
          </p>

          <div className="flex items-center gap-2 mb-3">
            <Search size={12} className="text-muted-foreground shrink-0" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Filter owners…"
              className="flex-1 bg-secondary/40 border border-border rounded px-2 py-1 text-xs outline-none focus:border-foreground/30"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-1.5 text-muted-foreground font-medium">Owner</th>
                  <th className="text-right py-1.5 text-muted-foreground font-medium">Deals</th>
                  <th className="text-right py-1.5 text-muted-foreground font-medium">DRs</th>
                  <th className="text-left py-1.5 pl-4 text-muted-foreground font-medium">First seen</th>
                  <th className="text-right py-1.5 text-muted-foreground font-medium">Membership</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className={`py-1.5 font-medium ${r.team ? '' : 'text-muted-foreground'}`}>{r.name}</td>
                    <td className="text-right py-1.5 font-mono">{r.oppCount || '—'}</td>
                    <td className="text-right py-1.5 font-mono">{r.drCount || '—'}</td>
                    <td className="py-1.5 pl-4 font-mono text-muted-foreground">{fmtDate(r.firstSeen)}</td>
                    <td className="text-right py-1.5">
                      <button
                        onClick={() => setRepStatus(r.id, r.team ? 'not_team' : 'team')}
                        className={`text-[10px] uppercase font-semibold px-2 py-0.5 rounded transition-colors ${
                          r.team
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/25'
                            : 'bg-secondary/40 text-muted-foreground hover:bg-secondary'
                        }`}
                        title={r.team ? 'Click to move off team' : 'Click to add to team'}
                      >
                        {r.team ? 'On team' : 'Not on team'}
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-3 text-center text-muted-foreground">
                      {reps.length === 0 ? 'No owners seen yet — import a Salesforce export.' : 'No owners match that filter.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
