import { useEffect, useState } from 'react';
import ForecastDashboard from '@/components/ForecastDashboard';
import RepGoalSetup from '@/components/RepGoalSetup';
import ImportSheet from '@/components/ImportSheet';
import ImportChangeLog from '@/components/ImportChangeLog';
import DataBackup from '@/components/DataBackup';
import SalesDataSync from '@/components/SalesDataSync';
import OpportunityGraveyard from '@/components/OpportunityGraveyard';
import PipelineLookback from '@/components/PipelineLookback';
import DrPipeline from '@/components/DrPipeline';
import DrCleanupPlanSection from '@/components/DrCleanupPlan';
import { useForecast } from '@/context/ForecastContext';
import SlipReport from '@/components/SlipReport';
import WeeklyBriefing, { PostImportBriefingBanner } from '@/components/WeeklyBriefing';
import { BarChart3, Users, Upload, Skull, History, Layers, TrendingDown, Broom } from 'lucide-react';

type Tab = 'forecast' | 'goals' | 'import' | 'lookback' | 'dr-pipeline' | 'dr-cleanup' | 'slips' | 'graveyard';

const Index = () => {
  const [tab, setTab] = useState<Tab>('forecast');

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Tab>).detail;
      if (detail) setTab(detail);
    };
    window.addEventListener('forecast:navigate-tab', handler);
    return () => window.removeEventListener('forecast:navigate-tab', handler);
  }, []);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'forecast', label: 'Forecast', icon: <BarChart3 size={14} /> },
    { id: 'goals', label: 'Goals', icon: <Users size={14} /> },
    { id: 'import', label: 'Import', icon: <Upload size={14} /> },
    { id: 'lookback', label: 'Lookback', icon: <History size={14} /> },
    { id: 'dr-pipeline', label: 'DR Pipeline', icon: <Layers size={14} /> },
    { id: 'slips', label: 'Slips', icon: <TrendingDown size={14} /> },
    { id: 'graveyard', label: 'Graveyard', icon: <Skull size={14} /> },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold tracking-tight">FORECAST</h1>
          <span className="text-xs text-muted-foreground font-mono">offline</span>
          <DataBackup />
          <WeeklyBriefing />
        </div>
        <nav className="flex gap-0.5 bg-secondary rounded-md p-0.5">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                tab === t.id
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <PostImportBriefingBanner />

      <main className="max-w-6xl mx-auto px-6 py-6">
        {tab === 'forecast' && <ForecastDashboard />}
        {tab === 'goals' && (
          <div>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">Rep Quarterly Goals</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Set each rep's quarterly target. Click a value to edit.</p>
            </div>
            <RepGoalSetup />
          </div>
        )}
        {tab === 'import' && (
          <div className="space-y-8">
            <div>
              <div className="mb-4">
                <h2 className="text-sm font-semibold">Import Salesforce Export</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Drop your weekly Salesforce opportunity export. Columns are auto-mapped.</p>
              </div>
              <ImportSheet />
              <ImportChangeLog />
            </div>
            <div className="border-t border-border pt-8">
              <SalesDataSync />
            </div>
          </div>
        )}
        {tab === 'lookback' && (
          <div>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">Pipeline Lookback</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Pick a date to compare pipeline state then vs now and review every deal that moved.</p>
            </div>
            <PipelineLookback />
          </div>
        )}
        {tab === 'dr-pipeline' && (
          <div>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">DR Pipeline</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Upload the Salesforce DR report to analyze CAM funnel, staleness, and account padding.</p>
            </div>
            <DrPipeline />
          </div>
        )}
        {tab === 'slips' && (
          <div>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">Slip Report</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Deals that were committed or in upside last quarter but didn't close — and where they are now.</p>
            </div>
            <SlipReport />
          </div>
        )}
        {tab === 'graveyard' && (
          <div>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">Opportunity Graveyard</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Lost and removed opportunities. Restore them back to your pipeline or delete permanently.</p>
            </div>
            <OpportunityGraveyard />
          </div>
        )}
      </main>
    </div>
  );
};

export default Index;
