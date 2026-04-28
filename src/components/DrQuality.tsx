import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { computeDrQuality } from '@/lib/drQuality';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertTriangle, TrendingDown, TrendingUp, Layers, Filter } from 'lucide-react';

const fmt$ = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtPct = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—');
const fmtPctInt = (n: number) => (Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—');

export default function DrQuality() {
  const { opportunities } = useForecast();
  const [stripThreshold, setStripThreshold] = useState(3);
  const [repFilter, setRepFilter] = useState<string[]>([]);

  const allReps = useMemo(() => {
    const set = new Set<string>();
    for (const o of opportunities) if (o.repName?.trim()) set.add(o.repName.trim());
    return Array.from(set).sort();
  }, [opportunities]);

  const result = useMemo(
    () => computeDrQuality(opportunities, { stripThreshold, repFilter }),
    [opportunities, stripThreshold, repFilter],
  );

  const noAccountData = result.accountCoverage < 0.05;
  const winRateDelta = result.singleProductCohort.winRate - result.multiProductCohort.winRate;
  const reportedWin = result.reportedPipeline.winRate;
  const strippedWin = result.strippedPipeline.winRate;
  const winRateLift = (Number.isFinite(strippedWin) ? strippedWin : 0) - (Number.isFinite(reportedWin) ? reportedWin : 0);

  return (
    <div className="space-y-4">
      {noAccountData && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <div>
            <p className="font-medium">Account data missing.</p>
            <p className="text-muted-foreground">
              Only {fmtPctInt(result.accountCoverage)} of opportunities have an Account Name. Re-import a
              Salesforce export that includes an <span className="font-mono">Account Name</span> column to
              unlock multi-product DR analysis.
            </p>
          </div>
        </div>
      )}

      {/* Coverage */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">Data coverage</CardTitle>
              <CardDescription className="text-xs">
                What share of opportunities carry the fields we need.
              </CardDescription>
            </div>
            <div className="text-xs text-muted-foreground">{result.totalOpps.toLocaleString()} opps total</div>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-4 text-xs">
          <div>
            <div className="text-muted-foreground">Account name</div>
            <div className="text-lg font-semibold">{fmtPctInt(result.accountCoverage)}</div>
            <div className="text-muted-foreground">{result.oppsWithAccount} / {result.totalOpps}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Product</div>
            <div className="text-lg font-semibold">{fmtPctInt(result.productCoverage)}</div>
            <div className="text-muted-foreground">{result.oppsWithProduct} / {result.totalOpps}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Distinct accounts</div>
            <div className="text-lg font-semibold">{result.totalAccounts.toLocaleString()}</div>
          </div>
        </CardContent>
      </Card>

      {/* Rep filter */}
      {allReps.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Filter size={14} className="text-muted-foreground" />
              <CardTitle className="text-sm">Rep filter</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setRepFilter([])}
                className={`text-xs rounded px-2 py-1 border transition-colors ${
                  repFilter.length === 0 ? 'bg-foreground text-background border-foreground' : 'border-border hover:bg-secondary'
                }`}
              >
                All reps
              </button>
              {allReps.map(name => {
                const active = repFilter.includes(name);
                return (
                  <button
                    key={name}
                    onClick={() => setRepFilter(active ? repFilter.filter(r => r !== name) : [...repFilter, name])}
                    className={`text-xs rounded px-2 py-1 border transition-colors ${
                      active ? 'bg-foreground text-background border-foreground' : 'border-border hover:bg-secondary'
                    }`}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Multi-product concentration */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Layers size={14} className="text-muted-foreground" />
            <CardTitle className="text-sm">Multi-product concentration</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Accounts carrying 2+ opps (and/or 2+ distinct products) inflate DR counts without
            necessarily creating new revenue. This is your "tag-along" proxy.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 md:grid-cols-4 text-xs">
          <Stat label="Multi-product accounts" value={result.multiProductAccounts.toLocaleString()} sub={`${fmtPctInt(result.multiProductAccountPct)} of ${result.totalAccounts}`} />
          <Stat label="Opps on multi-product accounts" value={result.multiProductOpps.toLocaleString()} sub={`${fmtPctInt(result.multiProductOppPct)} of ${result.totalOpps}`} />
          <Stat label="$ on multi-product accounts" value={fmt$(result.multiProductCohort.amount)} sub={`avg ${fmt$(result.multiProductCohort.avgAmount)}`} />
          <Stat label="$ on single-product accounts" value={fmt$(result.singleProductCohort.amount)} sub={`avg ${fmt$(result.singleProductCohort.avgAmount)}`} />
        </CardContent>
      </Card>

      {/* Conversion delta */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Conversion delta — single-product vs multi-product accounts</CardTitle>
          <CardDescription className="text-xs">
            Win rate = won / (won + lost). If multi-product accounts convert dramatically worse, those extra
            DRs are likely fictional load — they pad pipeline without producing revenue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Cohort</TableHead>
                <TableHead className="text-xs text-right">Opps</TableHead>
                <TableHead className="text-xs text-right">Won</TableHead>
                <TableHead className="text-xs text-right">Lost</TableHead>
                <TableHead className="text-xs text-right">Open</TableHead>
                <TableHead className="text-xs text-right">Win rate</TableHead>
                <TableHead className="text-xs text-right">Avg $</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <CohortRow label="Single-product account" c={result.singleProductCohort} />
              <CohortRow label="Multi-product account" c={result.multiProductCohort} />
            </TableBody>
          </Table>
          <div className="mt-3 flex items-center gap-2 text-xs">
            {Number.isFinite(winRateDelta) ? (
              winRateDelta > 0 ? (
                <>
                  <TrendingDown size={14} className="text-negative" />
                  <span>
                    Multi-product accounts convert{' '}
                    <span className="font-semibold text-negative">
                      {fmtPct(Math.abs(winRateDelta))} lower
                    </span>{' '}
                    than single-product accounts.
                  </span>
                </>
              ) : (
                <>
                  <TrendingUp size={14} className="text-positive" />
                  <span>
                    Multi-product accounts convert{' '}
                    <span className="font-semibold text-positive">{fmtPct(Math.abs(winRateDelta))} higher</span>{' '}
                    than single-product accounts.
                  </span>
                </>
              )
            ) : (
              <span className="text-muted-foreground">Not enough decided deals in both cohorts to compare.</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Stripped pipeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Stripped pipeline view</CardTitle>
          <CardDescription className="text-xs">
            Remove every opp on accounts that currently carry {stripThreshold}+ open opps. Compare what's
            reported vs what's defensible.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="text-muted-foreground">Strip accounts with this many open opps or more</span>
              <span className="font-mono font-semibold">{stripThreshold}+</span>
            </div>
            <Slider
              value={[stripThreshold]}
              onValueChange={v => setStripThreshold(v[0])}
              min={2}
              max={10}
              step={1}
            />
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">View</TableHead>
                <TableHead className="text-xs text-right">Opps</TableHead>
                <TableHead className="text-xs text-right">Won</TableHead>
                <TableHead className="text-xs text-right">Lost</TableHead>
                <TableHead className="text-xs text-right">Open</TableHead>
                <TableHead className="text-xs text-right">Win rate</TableHead>
                <TableHead className="text-xs text-right">$ pipeline</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <CohortRow label="Reported (all)" c={result.reportedPipeline} />
              <CohortRow label="Defensible (stripped)" c={result.strippedPipeline} highlight />
            </TableBody>
          </Table>

          <div className="flex flex-wrap gap-4 text-xs">
            <div>
              <div className="text-muted-foreground">Removed by strip</div>
              <div className="font-semibold">
                {result.strippedRemovedCount.toLocaleString()} opps · {fmt$(result.strippedRemovedAmount)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Win-rate lift after strip</div>
              <div className={`font-semibold ${winRateLift >= 0 ? 'text-positive' : 'text-negative'}`}>
                {Number.isFinite(winRateLift) ? `${winRateLift >= 0 ? '+' : ''}${fmtPct(winRateLift)}` : '—'}
              </div>
            </div>
            {result.perRep.length > 0 && (
              <div>
                <div className="text-muted-foreground">Avg open opps per AE (reported → stripped)</div>
                <div className="font-semibold">
                  {(result.reportedPipeline.open / result.perRep.length).toFixed(1)} →{' '}
                  {(result.strippedPipeline.open / result.perRep.length).toFixed(1)}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Per-AE scorecard */}
      {result.perRep.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Per-AE DR hygiene</CardTitle>
            <CardDescription className="text-xs">
              Sorted by % of opps sitting on multi-product accounts. High % + low multi-product win rate = the
              fictional-DR pattern.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Rep</TableHead>
                  <TableHead className="text-xs text-right">Opps</TableHead>
                  <TableHead className="text-xs text-right">Opps / acct</TableHead>
                  <TableHead className="text-xs text-right">% multi-product</TableHead>
                  <TableHead className="text-xs text-right">Single-product win</TableHead>
                  <TableHead className="text-xs text-right">Multi-product win</TableHead>
                  <TableHead className="text-xs text-right">Delta</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.perRep.map(r => {
                  const delta = r.singleProduct.winRate - r.multiProduct.winRate;
                  return (
                    <TableRow key={r.repKey}>
                      <TableCell className="text-xs font-medium">{r.repName}</TableCell>
                      <TableCell className="text-xs text-right">{r.totalOpps}</TableCell>
                      <TableCell className="text-xs text-right">{r.oppsPerAccount.toFixed(1)}</TableCell>
                      <TableCell className="text-xs text-right">{fmtPctInt(r.multiProductPct)}</TableCell>
                      <TableCell className="text-xs text-right">{fmtPct(r.singleProduct.winRate)}</TableCell>
                      <TableCell className="text-xs text-right">{fmtPct(r.multiProduct.winRate)}</TableCell>
                      <TableCell className={`text-xs text-right font-medium ${
                        Number.isFinite(delta) ? (delta > 0 ? 'text-negative' : 'text-positive') : 'text-muted-foreground'
                      }`}>
                        {Number.isFinite(delta) ? `${delta > 0 ? '−' : '+'}${fmtPct(Math.abs(delta))}` : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Top stacked accounts */}
      {result.topStackedAccounts.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Most stacked accounts</CardTitle>
            <CardDescription className="text-xs">
              Top accounts by open opportunity count — the usual suspects for inflated DR load.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Account</TableHead>
                  <TableHead className="text-xs text-right">Opps</TableHead>
                  <TableHead className="text-xs text-right">Distinct products</TableHead>
                  <TableHead className="text-xs text-right">Total $</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.topStackedAccounts.map(a => (
                  <TableRow key={a.accountKey}>
                    <TableCell className="text-xs font-medium">{a.accountLabel}</TableCell>
                    <TableCell className="text-xs text-right">{a.oppCount}</TableCell>
                    <TableCell className="text-xs text-right">{a.productCount || '—'}</TableCell>
                    <TableCell className="text-xs text-right">{fmt$(a.totalAmount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {sub && <div className="text-muted-foreground">{sub}</div>}
    </div>
  );
}

function CohortRow({
  label,
  c,
  highlight,
}: {
  label: string;
  c: { count: number; won: number; lost: number; open: number; winRate: number; amount: number };
  highlight?: boolean;
}) {
  return (
    <TableRow className={highlight ? 'bg-secondary/40' : ''}>
      <TableCell className="text-xs font-medium">{label}</TableCell>
      <TableCell className="text-xs text-right">{c.count.toLocaleString()}</TableCell>
      <TableCell className="text-xs text-right">{c.won.toLocaleString()}</TableCell>
      <TableCell className="text-xs text-right">{c.lost.toLocaleString()}</TableCell>
      <TableCell className="text-xs text-right">{c.open.toLocaleString()}</TableCell>
      <TableCell className="text-xs text-right font-semibold">{fmtPct(c.winRate)}</TableCell>
      <TableCell className="text-xs text-right">{fmt$(c.amount)}</TableCell>
    </TableRow>
  );
}
