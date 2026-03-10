import { useMemo, useRef } from 'react';
import { useForecast } from '@/context/ForecastContext';
import { getQuarter, getMonthKey, getMonthLabel, getQuarterMonths, getCurrentQuarter } from '@/types/forecast';
import { Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const COLORS = {
  closedWon: '#22c55e',
  commit: '#3b82f6',
  upside: '#f59e0b',
  unclassified: '#6b7280',
};

interface Props {
  quarter?: Quarter;
  selectedRep?: string | 'all';
}

export default function ExecutiveReportVisual({ quarter: quarterProp, selectedRep = 'all' }: Props = {}) {
  const { reps, opportunities } = useForecast();
  const printRef = useRef<HTMLDivElement>(null);

  const quarter = quarterProp || getCurrentQuarter();
  const months = getQuarterMonths(quarter);

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const pct = (n: number, d: number) => d === 0 ? '—' : `${Math.round((n / d) * 100)}%`;

  const data = useMemo(() => {
    let qOpps = opportunities.filter(o => o.closeDate && getQuarter(o.closeDate) === quarter);
    if (selectedRep !== 'all') qOpps = qOpps.filter(o => o.repName === selectedRep);

    const totalGoal = reps.reduce((s, r) => s + (r.quarterlyGoals[quarter] || 0), 0);
    const closedWon = qOpps.filter(o => o.classification === 'closed_won').reduce((s, o) => s + o.amount, 0);
    const closedWonCount = qOpps.filter(o => o.classification === 'closed_won').length;
    const commit = qOpps.filter(o => o.classification === 'commit').reduce((s, o) => s + o.amount, 0);
    const upside = qOpps.filter(o => o.classification === 'upside').reduce((s, o) => s + o.amount, 0);
    const unclassified = qOpps.filter(o => o.classification === 'unclassified').reduce((s, o) => s + o.amount, 0);
    const totalPipe = qOpps.reduce((s, o) => s + o.amount, 0);

    const pieData = [
      { name: 'Closed Won', value: closedWon, color: COLORS.closedWon },
      { name: 'Commit', value: commit, color: COLORS.commit },
      { name: 'Upside', value: upside, color: COLORS.upside },
      { name: 'Unclassified', value: unclassified, color: COLORS.unclassified },
    ].filter(d => d.value > 0);

    const monthlyData = months.map(m => {
      const mOpps = qOpps.filter(o => getMonthKey(o.closeDate) === m);
      return {
        month: getMonthLabel(m),
        'Closed Won': mOpps.filter(o => o.classification === 'closed_won').reduce((s, o) => s + o.amount, 0),
        Commit: mOpps.filter(o => o.classification === 'commit').reduce((s, o) => s + o.amount, 0),
        Upside: mOpps.filter(o => o.classification === 'upside').reduce((s, o) => s + o.amount, 0),
      };
    });

    const repNames = Array.from(new Set(qOpps.map(o => o.repName))).sort();
    const repData = repNames.map(name => {
      const rOpps = qOpps.filter(o => o.repName === name);
      const rWon = rOpps.filter(o => o.classification === 'closed_won').reduce((s, o) => s + o.amount, 0);
      const rWonCount = rOpps.filter(o => o.classification === 'closed_won').length;
      const rCommit = rOpps.filter(o => o.classification === 'commit').reduce((s, o) => s + o.amount, 0);
      const rUpside = rOpps.filter(o => o.classification === 'upside').reduce((s, o) => s + o.amount, 0);
      const rTotal = rOpps.reduce((s, o) => s + o.amount, 0);
      return {
        name,
        won: rWon,
        wonCount: rWonCount,
        commit: rCommit,
        upside: rUpside,
        total: rTotal,
        convRate: rTotal > 0 ? Math.round((rWon / rTotal) * 100) : 0,
        asp: rWonCount > 0 ? rWon / rWonCount : 0,
      };
    });

    const topDeals = qOpps
      .filter(o => o.classification === 'closed_won')
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    const commitDeals = qOpps
      .filter(o => o.classification === 'commit')
      .sort((a, b) => b.amount - a.amount);

    return {
      totalGoal, closedWon, closedWonCount, commit, upside, totalPipe, unclassified,
      pieData, monthlyData, repData, topDeals, commitDeals,
      convRate: totalPipe > 0 ? Math.round((closedWon / totalPipe) * 100) : 0,
      asp: closedWonCount > 0 ? closedWon / closedWonCount : 0,
    };
  }, [opportunities, reps, quarter, months]);

  const handlePrint = () => {
    const content = printRef.current;
    if (!content) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${quarter} Executive Forecast Report</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Inter', sans-serif; background: #fff; color: #1a1a2e; padding: 40px; }
          @media print {
            body { padding: 20px; }
            .no-print { display: none !important; }
            @page { margin: 0.5in; size: letter landscape; }
          }
        </style>
      </head>
      <body>${content.innerHTML}</body>
      </html>
    `);
    printWindow.document.close();
    setTimeout(() => printWindow.print(), 500);
  };

  const KpiCard = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <div style={{
      background: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)',
      borderRadius: 12, padding: '20px 24px', flex: 1, minWidth: 160,
      border: '1px solid #e2e8f0',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: '#64748b', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{sub}</div>}
    </div>
  );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 text-xs">
          <FileText size={14} />
          Visual Report
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Visual Executive Report</span>
            <Button variant="outline" size="sm" onClick={handlePrint} className="gap-1.5 text-xs">
              <Download size={14} />
              Download / Print PDF
            </Button>
          </DialogTitle>
        </DialogHeader>

        {/* Printable content */}
        <div ref={printRef}>
          <div style={{ fontFamily: "'Inter', sans-serif", color: '#0f172a', background: '#fff', padding: 32, borderRadius: 12 }}>
            {/* Header */}
            <div style={{ borderBottom: '3px solid #3b82f6', paddingBottom: 16, marginBottom: 28 }}>
              <h1 style={{ fontSize: 28, fontWeight: 700, color: '#0f172a', margin: 0 }}>{quarter} Forecast Summary</h1>
              <p style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>Generated {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
            </div>

            {/* KPI Row */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 32, flexWrap: 'wrap' }}>
              <KpiCard label="Quarterly Goal" value={fmt(data.totalGoal)} />
              <KpiCard label="Closed Won" value={fmt(data.closedWon)} sub={pct(data.closedWon, data.totalGoal) + ' of goal'} />
              <KpiCard label="Commit" value={fmt(data.commit)} sub={pct(data.commit, data.totalGoal) + ' of goal'} />
              <KpiCard label="Upside" value={fmt(data.upside)} />
              <KpiCard label="Conversion Rate" value={`${data.convRate}%`} sub={`ASP: ${fmt(data.asp)}`} />
            </div>

            {/* Charts Row */}
            <div style={{ display: 'flex', gap: 24, marginBottom: 32, flexWrap: 'wrap' }}>
              {/* Pie Chart */}
              <div style={{ flex: '1 1 320px', background: '#f8fafc', borderRadius: 12, padding: 20, border: '1px solid #e2e8f0' }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#334155' }}>Pipeline Breakdown</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={data.pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={85} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false} style={{ fontSize: 11 }}>
                      {data.pieData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(val: number) => fmt(val)} />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              {/* Monthly Bar Chart */}
              <div style={{ flex: '2 1 400px', background: '#f8fafc', borderRadius: 12, padding: 20, border: '1px solid #e2e8f0' }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#334155' }}>Monthly Breakdown</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={data.monthlyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(val: number) => fmt(val)} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Closed Won" fill={COLORS.closedWon} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Commit" fill={COLORS.commit} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Upside" fill={COLORS.upside} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Rep Performance Table */}
            {data.repData.length > 0 && (
              <div style={{ marginBottom: 32 }}>
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: '#0f172a' }}>Rep Performance</h3>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                      <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>Rep</th>
                      <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>Won</th>
                      <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>Commit</th>
                      <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>Upside</th>
                      <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>Total Pipeline</th>
                      <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>Conv Rate</th>
                      <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, color: '#475569' }}>ASP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.repData.map((r, i) => (
                      <tr key={r.name} style={{ borderBottom: '1px solid #f1f5f9', background: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                        <td style={{ padding: '10px 12px', fontWeight: 500 }}>{r.name}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#16a34a', fontWeight: 600 }}>{fmt(r.won)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#2563eb' }}>{fmt(r.commit)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#d97706' }}>{fmt(r.upside)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 500 }}>{fmt(r.total)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                          <span style={{
                            background: r.convRate >= 50 ? '#dcfce7' : r.convRate >= 25 ? '#fef9c3' : '#fee2e2',
                            color: r.convRate >= 50 ? '#166534' : r.convRate >= 25 ? '#854d0e' : '#991b1b',
                            padding: '2px 8px', borderRadius: 99, fontWeight: 600, fontSize: 12,
                          }}>{r.convRate}%</span>
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>{r.asp > 0 ? fmt(r.asp) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Deal Lists */}
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {data.topDeals.length > 0 && (
                <div style={{ flex: '1 1 300px' }}>
                  <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: '#0f172a' }}>Top Closed Won</h3>
                  {data.topDeals.map((d, i) => (
                    <div key={d.id} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '10px 12px', borderRadius: 8, marginBottom: 6,
                      background: '#f0fdf4', border: '1px solid #bbf7d0',
                    }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{d.name}</div>
                        <div style={{ fontSize: 11, color: '#64748b' }}>{d.repName}</div>
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#16a34a' }}>{fmt(d.amount)}</div>
                    </div>
                  ))}
                </div>
              )}
              {data.commitDeals.length > 0 && (
                <div style={{ flex: '1 1 300px' }}>
                  <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: '#0f172a' }}>Commit Pipeline</h3>
                  {data.commitDeals.map(d => (
                    <div key={d.id} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '10px 12px', borderRadius: 8, marginBottom: 6,
                      background: '#eff6ff', border: '1px solid #bfdbfe',
                    }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{d.name}</div>
                        <div style={{ fontSize: 11, color: '#64748b' }}>{d.repName} · Close {new Date(d.closeDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#2563eb' }}>{fmt(d.amount)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
