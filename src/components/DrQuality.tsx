import { useMemo, useState } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { computeDrQuality, computeDrScores, type DrScoreResult, type DrTier } from '@/lib/drQuality';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, TrendingDown, TrendingUp, Layers, Filter, Download, ChevronDown, ChevronRight } from 'lucide-react';
import { normalizeRepName } from '@/lib/repUtils';
import type { Opportunity } from '@/types/forecast';
import * as XLSX from '@e965/xlsx';

const fmt$ = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtPct = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—');
const fmtPctInt = (n: number) => (Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—');

const tierColor = (t: DrTier): string =>
  t === 'Strong' ? 'text-positive' : t === 'Marginal' ? 'text-upside' : t === 'Weak' ? 'text-negative' : 'text-muted-foreground';

const tierBg = (t: DrTier): string =>
  t === 'Strong' ? 'bg-positive/10 text-positive border-positive/30'
  : t === 'Marginal' ? 'bg-upside/10 text-upside border-upside/30'
  : t === 'Weak' ? 'bg-negative/10 text-negative border-negative/30'
  : 'bg-muted text-muted-foreground border-border';

// Excel hex per tier (background tints)
const tierHex: Record<DrTier, string> = {
  Strong: 'FFD9EFE3',
  Marginal: 'FFF6E7C1',
  Weak: 'FFF2C9C4',
  Disqualified: 'FFE5E5E5',
};
const tierTextHex: Record<DrTier, string> = {
  Strong: 'FF1A7A4A',
  Marginal: 'FFB8860B',
  Weak: 'FFC0392B',
  Disqualified: 'FF555555',
};

export default function DrQuality() {
  const { opportunities } = useForecast();
  const [stripThreshold, setStripThreshold] = useState(3);
  const [repFilter, setRepFilter] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const allReps = useMemo(() => {
    const set = new Set<string>();
    for (const o of opportunities) if (o.repName?.trim()) set.add(o.repName.trim());
    return Array.from(set).sort();
  }, [opportunities]);

  const filteredOpps = useMemo(() => {
    if (repFilter.length === 0) return opportunities;
    const set = new Set(repFilter.map(normalizeRepName));
    return opportunities.filter(o => set.has(normalizeRepName(o.repName)));
  }, [opportunities, repFilter]);

  const scoreMap = useMemo(() => computeDrScores(filteredOpps), [filteredOpps]);

  const result = useMemo(
    () => computeDrQuality(opportunities, { stripThreshold, repFilter }),
    [opportunities, stripThreshold, repFilter],
  );

  // Portfolio scorecard
  const scored = useMemo(() => {
    return filteredOpps
      .map(o => ({ opp: o, score: scoreMap.get(o.id)! }))
      .filter(x => x.score);
  }, [filteredOpps, scoreMap]);

  const scoredOpen = scored.filter(s => !s.score.disqualified);
  const disqualified = scored.filter(s => s.score.disqualified);
  const strongList = scoredOpen.filter(s => s.score.tier === 'Strong');
  const marginalList = scoredOpen.filter(s => s.score.tier === 'Marginal');
  const weakList = scoredOpen.filter(s => s.score.tier === 'Weak');

  const dqReasons = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of disqualified) m.set(d.score.disqualifyReason, (m.get(d.score.disqualifyReason) || 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [disqualified]);

  // Systemic issues
  const issues = useMemo(() => {
    const arr: { severity: 'warn' | 'crit'; title: string; desc: string }[] = [];
    const n = scoredOpen.length || 1;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const pastDue = scoredOpen.filter(s => {
      if (!s.opp.closeDate) return false;
      const d = new Date(s.opp.closeDate); return d < today;
    });
    if (pastDue.length / n > 0.1) {
      arr.push({ severity: 'crit', title: 'Past-due close dates', desc: `${pastDue.length} of ${n} scored deals (${Math.round(100 * pastDue.length / n)}%) have a close date in the past.` });
    }
    const stacked = scoredOpen.filter(s => s.score.subscores.accountStacking <= 40);
    if (stacked.length / n > 0.2) {
      arr.push({ severity: 'warn', title: 'Account stacking', desc: `${stacked.length} of ${n} scored deals (${Math.round(100 * stacked.length / n)}%) sit on accounts carrying 3+ open opps.` });
    }
    const placeholder = scoredOpen.filter(s => s.score.subscores.amountCredibility <= 40);
    if (placeholder.length / n > 0.15) {
      arr.push({ severity: 'warn', title: 'Placeholder amounts', desc: `${placeholder.length} of ${n} scored deals (${Math.round(100 * placeholder.length / n)}%) have suspiciously round or trivial amounts.` });
    }
    const zeroAmt = disqualified.filter(d => d.score.disqualifyReason.includes('amount'));
    if (zeroAmt.length > 0) {
      arr.push({ severity: 'crit', title: 'Zero-amount deal regs', desc: `${zeroAmt.length} deals were disqualified for having zero or missing amount.` });
    }
    return arr;
  }, [scoredOpen, disqualified]);

  // By CAM
  const hasCam = useMemo(() => filteredOpps.some(o => o.channelAccountManager?.trim()), [filteredOpps]);
  const byCam = useMemo(() => {
    const m = new Map<string, { name: string; opps: typeof scored }>();
    for (const s of scored) {
      const cam = (s.opp.channelAccountManager || '').trim();
      if (!cam) continue;
      const key = cam.toLowerCase();
      const entry = m.get(key) || { name: cam, opps: [] };
      entry.opps.push(s);
      m.set(key, entry);
    }
    return Array.from(m.values()).map(({ name, opps }) => {
      const open = opps.filter(o => !o.score.disqualified);
      const strong = open.filter(o => o.score.tier === 'Strong');
      const marginal = open.filter(o => o.score.tier === 'Marginal');
      const weak = open.filter(o => o.score.tier === 'Weak');
      const avg = open.length > 0 ? open.reduce((s, o) => s + o.score.score, 0) / open.length : 0;
      const totalPipe = opps.reduce((s, o) => s + (o.opp.amount || 0), 0);
      const strongPipe = strong.reduce((s, o) => s + (o.opp.amount || 0), 0);
      return {
        name,
        count: opps.length,
        avgScore: avg,
        strong: strong.length,
        marginal: marginal.length,
        weak: weak.length,
        pctStrong: open.length > 0 ? strong.length / open.length : 0,
        totalPipe,
        strongPipe,
      };
    }).sort((a, b) => a.avgScore - b.avgScore);
  }, [scored]);

  // Detail table (apply strip threshold)
  const detailRows = useMemo(() => {
    const accountOpenCounts = new Map<string, number>();
    for (const o of filteredOpps) {
      const k = (o.accountName || '').trim().toLowerCase();
      if (!k) continue;
      const isOpen = o.classification !== 'closed_won' && o.classification !== 'lost' && o.classification !== 'omitted';
      if (!isOpen) continue;
      accountOpenCounts.set(k, (accountOpenCounts.get(k) || 0) + 1);
    }
    return scored.filter(s => {
      const k = (s.opp.accountName || '').trim().toLowerCase();
      if (!k) return true;
      return (accountOpenCounts.get(k) || 0) < stripThreshold;
    });
  }, [scored, filteredOpps, stripThreshold]);

  const noAccountData = result.accountCoverage < 0.05;
  const winRateDelta = result.singleProductCohort.winRate - result.multiProductCohort.winRate;
  const reportedWin = result.reportedPipeline.winRate;
  const strippedWin = result.strippedPipeline.winRate;
  const winRateLift = (Number.isFinite(strippedWin) ? strippedWin : 0) - (Number.isFinite(reportedWin) ? reportedWin : 0);

  const avgScore = scoredOpen.length > 0 ? scoredOpen.reduce((s, o) => s + o.score.score, 0) / scoredOpen.length : 0;
  const totalOpenPipe = scoredOpen.reduce((s, o) => s + (o.opp.amount || 0), 0);
  const strongPipe = strongList.reduce((s, o) => s + (o.opp.amount || 0), 0);

  const handleExport = () => {
    exportDrReport({
      scored, scoredOpen, disqualified, strongList, marginalList, weakList,
      avgScore, totalOpenPipe, strongPipe, byCam, hasCam, issues,
    });
  };

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {/* Header with export */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">DR Quality</h2>
          <p className="text-xs text-muted-foreground">Six-dimension deal-reg scoring across the channel pipeline.</p>
        </div>
        <Button size="sm" variant="outline" onClick={handleExport}>
          <Download size={14} /> Export Report
        </Button>
      </div>

      {noAccountData && (
        <div className="flex items-start gap-2 rounded-md border border-upside/30 bg-upside/10 px-3 py-2 text-xs">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-upside" />
          <div>
            <p className="font-medium">Account data missing.</p>
            <p className="text-muted-foreground">
              Only {fmtPctInt(result.accountCoverage)} of opportunities have an Account Name. Re-import a
              Salesforce export including <span className="font-mono">Account Name</span> to unlock full DR analysis.
            </p>
          </div>
        </div>
      )}

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
              >All reps</button>
              {allReps.map(name => {
                const active = repFilter.includes(name);
                return (
                  <button key={name}
                    onClick={() => setRepFilter(active ? repFilter.filter(r => r !== name) : [...repFilter, name])}
                    className={`text-xs rounded px-2 py-1 border transition-colors ${
                      active ? 'bg-foreground text-background border-foreground' : 'border-border hover:bg-secondary'
                    }`}>{name}</button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Section A — Portfolio scorecard */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <ScoreCard label="Total Deal Regs" value={scored.length.toLocaleString()} />
        <ScoreCard label="Scored (open)" value={scoredOpen.length.toLocaleString()} />
        <ScoreCard label="Strong" value={strongList.length.toLocaleString()}
          sub={scoredOpen.length > 0 ? fmtPctInt(strongList.length / scoredOpen.length) : '—'}
          className="text-positive" />
        <ScoreCard label="Marginal" value={marginalList.length.toLocaleString()}
          sub={scoredOpen.length > 0 ? fmtPctInt(marginalList.length / scoredOpen.length) : '—'}
          className="text-upside" />
        <ScoreCard label="Weak" value={weakList.length.toLocaleString()}
          sub={scoredOpen.length > 0 ? fmtPctInt(weakList.length / scoredOpen.length) : '—'}
          className="text-negative" />
        <ScoreCard label="Disqualified" value={disqualified.length.toLocaleString()}
          sub={dqReasons.length > 0 ? dqReasons[0][0].slice(0, 28) : undefined}
          className="text-muted-foreground" />
      </div>

      {/* Section B — Systemic issues */}
      {issues.length > 0 && (
        <div className="space-y-2">
          {issues.map((i, idx) => (
            <div key={idx}
              className={`flex items-start gap-2 rounded-md border-l-4 px-3 py-2 text-xs ${
                i.severity === 'crit'
                  ? 'border-l-negative bg-negative/10'
                  : 'border-l-upside bg-upside/10'
              }`}>
              <AlertTriangle size={14} className={`mt-0.5 shrink-0 ${i.severity === 'crit' ? 'text-negative' : 'text-upside'}`} />
              <div>
                <p className="font-medium">{i.title}</p>
                <p className="text-muted-foreground">{i.desc}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Section C — By CAM */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">By Channel Account Manager</CardTitle>
          <CardDescription className="text-xs">Ranked by average quality score (worst first).</CardDescription>
        </CardHeader>
        <CardContent>
          {!hasCam ? (
            <p className="text-xs text-muted-foreground">
              Add "Channel Account Manager" to your Salesforce export to enable CAM-level analysis.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">CAM</TableHead>
                    <TableHead className="text-xs text-right">Deals</TableHead>
                    <TableHead className="text-xs text-right">Avg Score</TableHead>
                    <TableHead className="text-xs text-right">Strong</TableHead>
                    <TableHead className="text-xs text-right">Marginal</TableHead>
                    <TableHead className="text-xs text-right">Weak</TableHead>
                    <TableHead className="text-xs text-right">% Strong</TableHead>
                    <TableHead className="text-xs text-right">Pipeline $</TableHead>
                    <TableHead className="text-xs text-right">Strong $</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byCam.map(c => {
                    const t = tierFor(c.avgScore);
                    return (
                      <TableRow key={c.name}>
                        <TableCell className="text-xs font-medium">{c.name}</TableCell>
                        <TableCell className="text-xs text-right">{c.count}</TableCell>
                        <TableCell className={`text-xs text-right font-semibold ${tierColor(t)}`}>{Math.round(c.avgScore)}</TableCell>
                        <TableCell className="text-xs text-right text-positive">{c.strong}</TableCell>
                        <TableCell className="text-xs text-right text-upside">{c.marginal}</TableCell>
                        <TableCell className="text-xs text-right text-negative">{c.weak}</TableCell>
                        <TableCell className="text-xs text-right">{fmtPctInt(c.pctStrong)}</TableCell>
                        <TableCell className="text-xs text-right">{fmt$(c.totalPipe)}</TableCell>
                        <TableCell className="text-xs text-right">{fmt$(c.strongPipe)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section D — Deal detail table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Deal detail</CardTitle>
          <CardDescription className="text-xs">
            Strip threshold filters out deals on accounts with this many or more open opps.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="text-muted-foreground">Strip threshold</span>
              <span className="font-mono font-semibold">{stripThreshold}+</span>
            </div>
            <Slider value={[stripThreshold]} onValueChange={v => setStripThreshold(v[0])} min={2} max={10} step={1} />
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs w-6" />
                  <TableHead className="text-xs">Opportunity</TableHead>
                  <TableHead className="text-xs">Owner</TableHead>
                  <TableHead className="text-xs">CAM</TableHead>
                  <TableHead className="text-xs text-right">Amount</TableHead>
                  <TableHead className="text-xs">Close Date</TableHead>
                  <TableHead className="text-xs">Stage</TableHead>
                  <TableHead className="text-xs text-right">Score</TableHead>
                  <TableHead className="text-xs">Tier</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detailRows.slice(0, 500).map(({ opp, score }) => {
                  const isExp = expanded.has(opp.id);
                  return (
                    <>
                      <TableRow key={opp.id} className="cursor-pointer" onClick={() => toggle(opp.id)}>
                        <TableCell className="p-2">
                          {isExp ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </TableCell>
                        <TableCell className="text-xs font-medium">{opp.name}</TableCell>
                        <TableCell className="text-xs">{opp.repName}</TableCell>
                        <TableCell className="text-xs">{opp.channelAccountManager || '—'}</TableCell>
                        <TableCell className="text-xs text-right">{fmt$(opp.amount)}</TableCell>
                        <TableCell className="text-xs">{opp.closeDate || '—'}</TableCell>
                        <TableCell className="text-xs">{opp.stage || '—'}</TableCell>
                        <TableCell className={`text-xs text-right font-semibold ${tierColor(score.tier)}`}>{score.score}</TableCell>
                        <TableCell className="text-xs">
                          <Badge variant="outline" className={`text-[10px] ${tierBg(score.tier)}`}>{score.tier}</Badge>
                        </TableCell>
                      </TableRow>
                      {isExp && (
                        <TableRow key={opp.id + '-exp'} className="bg-muted/30">
                          <TableCell />
                          <TableCell colSpan={8} className="text-xs">
                            {score.disqualified ? (
                              <span className="text-muted-foreground">Disqualified: {score.disqualifyReason}</span>
                            ) : (
                              <div className="flex flex-wrap gap-x-4 gap-y-1">
                                <SubScore label="Stage velocity" v={score.subscores.stageVelocity} />
                                <SubScore label="Close date integrity" v={score.subscores.closeDateIntegrity} />
                                <SubScore label="Amount credibility" v={score.subscores.amountCredibility} />
                                <SubScore label="Forecast credibility" v={score.subscores.forecastCredibility} />
                                <SubScore label="Account stacking" v={score.subscores.accountStacking} />
                                <SubScore label="Close date realism" v={score.subscores.closeDateRealism} />
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
              </TableBody>
            </Table>
            {detailRows.length > 500 && (
              <p className="mt-2 text-xs text-muted-foreground">Showing first 500 of {detailRows.length}. Export for the full list.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Section E — existing legacy analysis */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">Data coverage</CardTitle>
              <CardDescription className="text-xs">Share of opportunities carrying needed fields.</CardDescription>
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

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Layers size={14} className="text-muted-foreground" />
            <CardTitle className="text-sm">Multi-product concentration</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 md:grid-cols-4 text-xs">
          <Stat label="Multi-product accounts" value={result.multiProductAccounts.toLocaleString()} sub={`${fmtPctInt(result.multiProductAccountPct)} of ${result.totalAccounts}`} />
          <Stat label="Opps on multi-product accounts" value={result.multiProductOpps.toLocaleString()} sub={`${fmtPctInt(result.multiProductOppPct)} of ${result.totalOpps}`} />
          <Stat label="$ on multi-product accounts" value={fmt$(result.multiProductCohort.amount)} />
          <Stat label="$ on single-product accounts" value={fmt$(result.singleProductCohort.amount)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Stripped pipeline view</CardTitle>
          <CardDescription className="text-xs">
            Removes opps on accounts with {stripThreshold}+ open opps.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
              <div className="font-semibold">{result.strippedRemovedCount.toLocaleString()} opps · {fmt$(result.strippedRemovedAmount)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Win-rate lift after strip</div>
              <div className={`font-semibold ${winRateLift >= 0 ? 'text-positive' : 'text-negative'}`}>
                {Number.isFinite(winRateLift) ? `${winRateLift >= 0 ? '+' : ''}${fmtPct(winRateLift)}` : '—'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {Number.isFinite(winRateDelta) ? (
              winRateDelta > 0 ? (
                <><TrendingDown size={14} className="text-negative" />
                  <span>Multi-product accounts convert <span className="font-semibold text-negative">{fmtPct(Math.abs(winRateDelta))} lower</span>.</span></>
              ) : (
                <><TrendingUp size={14} className="text-positive" />
                  <span>Multi-product accounts convert <span className="font-semibold text-positive">{fmtPct(Math.abs(winRateDelta))} higher</span>.</span></>
              )
            ) : <span className="text-muted-foreground">Not enough decided deals to compare.</span>}
          </div>
        </CardContent>
      </Card>

      {result.topStackedAccounts.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Most stacked accounts</CardTitle>
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

function tierFor(score: number): DrTier {
  if (score >= 75) return 'Strong';
  if (score >= 50) return 'Marginal';
  if (score > 0) return 'Weak';
  return 'Disqualified';
}

function ScoreCard({ label, value, sub, className }: { label: string; value: string; sub?: string; className?: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
        <div className={`text-xl font-bold mt-1 ${className || ''}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function SubScore({ label, v }: { label: string; v: number }) {
  const color = v >= 75 ? 'text-positive' : v >= 50 ? 'text-upside' : 'text-negative';
  return (
    <span>
      <span className="text-muted-foreground">{label}:</span>{' '}
      <span className={`font-semibold ${color}`}>{v}</span>
    </span>
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

function CohortRow({ label, c, highlight }: { label: string; c: { count: number; won: number; lost: number; open: number; winRate: number; amount: number }; highlight?: boolean }) {
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

// ============================================================================
// Excel export
// ============================================================================

interface ExportArgs {
  scored: { opp: Opportunity; score: DrScoreResult }[];
  scoredOpen: { opp: Opportunity; score: DrScoreResult }[];
  disqualified: { opp: Opportunity; score: DrScoreResult }[];
  strongList: { opp: Opportunity; score: DrScoreResult }[];
  marginalList: { opp: Opportunity; score: DrScoreResult }[];
  weakList: { opp: Opportunity; score: DrScoreResult }[];
  avgScore: number;
  totalOpenPipe: number;
  strongPipe: number;
  byCam: any[];
  hasCam: boolean;
  issues: { severity: string; title: string; desc: string }[];
}

function setCell(ws: XLSX.WorkSheet, addr: string, value: any, style?: any) {
  const cell: any = { v: value, t: typeof value === 'number' ? 'n' : 's' };
  if (style) cell.s = style;
  ws[addr] = cell;
}

function exportDrReport(a: ExportArgs) {
  const wb = XLSX.utils.book_new();
  const today = new Date().toISOString().slice(0, 10);

  // --- Sheet 1: Executive Summary ---
  const headerStyle = { fill: { fgColor: { rgb: 'FF1C2B4A' } }, font: { color: { rgb: 'FFFFFFFF' }, bold: true, sz: 14 } };
  const labelStyle = { font: { bold: true } };
  const sum: any[][] = [];
  sum.push([`DR Quality Report — Channel Pipeline Analysis`]);
  sum.push([`Generated: ${today}`]);
  sum.push([]);
  sum.push(['KPI', 'Value']);
  sum.push(['Total Deal Regs', a.scored.length]);
  sum.push(['Scored (Open)', a.scoredOpen.length]);
  sum.push(['Strong', `${a.strongList.length} (${a.scoredOpen.length ? Math.round(100 * a.strongList.length / a.scoredOpen.length) : 0}%)`]);
  sum.push(['Marginal', `${a.marginalList.length} (${a.scoredOpen.length ? Math.round(100 * a.marginalList.length / a.scoredOpen.length) : 0}%)`]);
  sum.push(['Weak + Disqualified', `${a.weakList.length + a.disqualified.length}`]);
  sum.push(['Strong Pipeline $', a.strongPipe]);
  sum.push(['Total Open Pipeline $', a.totalOpenPipe]);
  sum.push(['Avg Quality Score', Math.round(a.avgScore)]);
  sum.push([]);
  sum.push(['Systemic Issues']);
  if (a.issues.length === 0) sum.push(['None detected']);
  for (const i of a.issues) sum.push([i.title, i.desc]);

  const ws1 = XLSX.utils.aoa_to_sheet(sum);
  ws1['A1'].s = headerStyle;
  ws1['A4'].s = labelStyle; ws1['B4'].s = labelStyle;
  if (ws1['A14']) ws1['A14'].s = labelStyle;
  ws1['!cols'] = [{ wch: 32 }, { wch: 80 }];
  ws1['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Executive Summary');

  // --- Sheet 2: By CAM ---
  const camHeader = ['Name', 'Deal Regs', 'Avg Score', 'Strong', 'Marginal', 'Weak', '% Strong', 'Pipeline $', 'Strong Pipeline $', 'Win Rate'];
  const camRows: any[][] = [camHeader];
  const sourceCam = a.hasCam ? a.byCam : [];
  for (const c of sourceCam) {
    const oppsForCam = a.scored.filter(s => (s.opp.channelAccountManager || '').toLowerCase() === c.name.toLowerCase());
    const won = oppsForCam.filter(s => s.opp.classification === 'closed_won').length;
    const lost = oppsForCam.filter(s => s.opp.classification === 'lost').length;
    const winRate = won + lost > 0 ? won / (won + lost) : 0;
    camRows.push([c.name, c.count, Math.round(c.avgScore), c.strong, c.marginal, c.weak, c.pctStrong, c.totalPipe, c.strongPipe, winRate]);
  }
  const ws2 = XLSX.utils.aoa_to_sheet(camRows);
  for (let i = 0; i < camHeader.length; i++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c: i });
    if (ws2[addr]) ws2[addr].s = headerStyle;
  }
  // tint rows by tier
  for (let r = 1; r < camRows.length; r++) {
    const score = camRows[r][2] as number;
    const t = tierFor(score);
    const fill = { fill: { fgColor: { rgb: tierHex[t] } }, font: { color: { rgb: tierTextHex[t] } } };
    for (let c = 0; c < camHeader.length; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws2[addr]) ws2[addr].s = fill;
    }
  }
  ws2['!cols'] = [{ wch: 28 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 16 }, { wch: 18 }, { wch: 10 }];
  ws2['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(camRows.length - 1, 0), c: camHeader.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws2, 'By CAM');

  // --- Sheet 3: Deal Detail ---
  const detailHeader = ['Opportunity Name', 'Owner', 'CAM', 'Amount', 'Close Date', 'Stage', 'Forecast Category', 'Product', 'Account Name', 'Score', 'Tier', 'Stage Velocity', 'Close Date Integrity', 'Amount Credibility', 'Forecast Credibility', 'Acct Stacking', 'Close Date Realism', 'Disqualified', 'Reason'];
  const detailRows: any[][] = [detailHeader];
  for (const { opp, score } of a.scored) {
    detailRows.push([
      opp.name, opp.repName, opp.channelAccountManager || '', opp.amount || 0, opp.closeDate || '',
      opp.stage || '', opp.classification, opp.productName || '', opp.accountName || '',
      score.score, score.tier,
      score.subscores.stageVelocity, score.subscores.closeDateIntegrity, score.subscores.amountCredibility,
      score.subscores.forecastCredibility, score.subscores.accountStacking, score.subscores.closeDateRealism,
      score.disqualified ? 'Y' : 'N', score.disqualifyReason,
    ]);
  }
  const ws3 = XLSX.utils.aoa_to_sheet(detailRows);
  for (let i = 0; i < detailHeader.length; i++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c: i });
    if (ws3[addr]) ws3[addr].s = headerStyle;
  }
  for (let r = 1; r < detailRows.length; r++) {
    const tier = detailRows[r][10] as DrTier;
    const fill = { fill: { fgColor: { rgb: tierHex[tier] } } };
    for (let c = 0; c < detailHeader.length; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws3[addr]) ws3[addr].s = fill;
    }
  }
  ws3['!cols'] = detailHeader.map((h, i) => ({ wch: i === 0 ? 40 : i === 8 ? 28 : 14 }));
  ws3['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(detailRows.length - 1, 0), c: detailHeader.length - 1 } }) };
  ws3['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws3, 'Deal Detail');

  XLSX.writeFile(wb, `DR_Quality_Report_${today}.xlsx`);
}
