import { useState } from 'react';
import ForecastDashboard from '@/components/ForecastDashboard';
import RepGoalSetup from '@/components/RepGoalSetup';
import ImportSheet from '@/components/ImportSheet';
import ImportChangeLog from '@/components/ImportChangeLog';
import DataBackup from '@/components/DataBackup';
import SalesDataSync from '@/components/SalesDataSync';
import OpportunityGraveyard from '@/components/OpportunityGraveyard';
import PipelineLookback from '@/components/PipelineLookback';
import { BarChart3, Users, Upload, Settings, Skull, History } from 'lucide-react';

type Tab = 'forecast' | 'goals' | 'import' | 'lookback' | 'settings' | 'graveyard';

const Index = () => {
  const [tab, setTab] = useState<Tab>('forecast');

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'forecast', label: 'Forecast', icon: <BarChart3 size={14} /> },
    { id: 'goals', label: 'Goals', icon: <Users size={14} /> },
    { id: 'import', label: 'Import', icon: <Upload size={14} /> },
    { id: 'lookback', label: 'Lookback', icon: <History size={14} /> },
    { id: 'graveyard', label: 'Graveyard', icon: <Skull size={14} /> },
    { id: 'settings', label: 'Convert', icon: <Settings size={14} /> },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold tracking-tight">FORECAST</h1>
          <span className="text-xs text-muted-foreground font-mono">offline</span>
          <DataBackup />
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
          <div>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">Import Salesforce Export</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Drop your weekly Salesforce opportunity export. Columns are auto-mapped.</p>
            </div>
            <ImportSheet />
            <ImportChangeLog />
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
        {tab === 'settings' && <SalesDataSync />}
      </main>
    </div>
  );
};

export default Index;
