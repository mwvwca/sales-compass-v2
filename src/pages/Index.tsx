import { Fragment, useEffect, useMemo, useState } from 'react';
import ForecastDashboard from '@/components/ForecastDashboard';
import RepGoalSetup from '@/components/RepGoalSetup';
import ImportSheet from '@/components/ImportSheet';
import ImportChangeLog from '@/components/ImportChangeLog';
import { useDataBackup } from '@/components/DataBackup';
import SalesDataSync from '@/components/SalesDataSync';
import OpportunityGraveyard from '@/components/OpportunityGraveyard';
import PipelineLookback from '@/components/PipelineLookback';
import DrPipeline from '@/components/DrPipeline';
import DrCleanupPlanSection from '@/components/DrCleanupPlan';
import InspectionPrep from '@/components/InspectionPrep';
import { useForecast } from '@/context/ForecastContext';
import { buildTeamRepNameSet, isTeamOwned } from '@/lib/repUtils';
import SlipReport from '@/components/SlipReport';
import WeeklyBriefing, { PostImportBriefingBanner } from '@/components/WeeklyBriefing';
import RepScorecard from '@/components/RepScorecard';
import DealRiskView from '@/components/DealRiskView';
import DealView from '@/components/DealView';
import { supabase } from '@/integrations/supabase/client';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetTrigger, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { BarChart3, Users, Upload, Skull, History, Layers, TrendingDown, Sparkles, AlertTriangle, Search, Compass, MoreHorizontal, MoreVertical, Download, LogOut, Menu, ClipboardCheck } from 'lucide-react';

type Tab = 'forecast' | 'goals' | 'scorecard' | 'deal-risk' | 'deal' | 'import' | 'lookback' | 'dr-pipeline' | 'dr-cleanup' | 'slips' | 'graveyard' | 'inspection';

const TAB_META: Record<Tab, { label: string; icon: React.ReactNode }> = {
  forecast: { label: 'Forecast', icon: <BarChart3 size={14} /> },
  goals: { label: 'Goals', icon: <Users size={14} /> },
  scorecard: { label: '1:1s', icon: <Users size={14} /> },
  'deal-risk': { label: 'Deal risk', icon: <AlertTriangle size={14} /> },
  'dr-pipeline': { label: 'DR Pipeline', icon: <Layers size={14} /> },
  'dr-cleanup': { label: 'Pipeline Cleanup', icon: <Sparkles size={14} /> },
  deal: { label: 'Search', icon: <Search size={14} /> },
  import: { label: 'Import', icon: <Upload size={14} /> },
  lookback: { label: 'Lookback', icon: <History size={14} /> },
  slips: { label: 'Slips', icon: <TrendingDown size={14} /> },
  graveyard: { label: 'Graveyard', icon: <Skull size={14} /> },
  inspection: { label: 'SQL Inspection', icon: <ClipboardCheck size={14} /> },
};

// Visible nav, in three groups separated by dividers; the rest live under "More".
const VISIBLE_GROUPS: Tab[][] = [
  ['forecast', 'goals', 'scorecard'],
  ['deal-risk', 'dr-pipeline', 'dr-cleanup'],
  ['deal', 'import'],
];
const OVERFLOW_TABS: Tab[] = ['inspection', 'lookback', 'slips', 'graveyard'];

const tabClass = (active: boolean) =>
  `flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
    active ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
  }`;

const VALID_TABS = new Set<string>(Object.keys(TAB_META));
const tabFromHash = (): Tab => {
  const h = window.location.hash.replace(/^#/, '');
  return VALID_TABS.has(h) ? (h as Tab) : 'forecast';
};

const Index = () => {
  // N1 fix: tab state lives in the URL hash so the browser Back button
  // navigates tabs instead of exiting the app, refresh keeps your place,
  // and every tab is deep-linkable.
  const [tab, setTabState] = useState<Tab>(() => tabFromHash());
  const [selectedOppId, setSelectedOppId] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const setTab = (next: Tab) => {
    setTabState(next);
    if (window.location.hash.replace(/^#/, '') !== next) {
      window.history.pushState(null, '', `#${next}`);
    }
  };

  useEffect(() => {
    const onHashNav = () => setTabState(tabFromHash());
    window.addEventListener('popstate', onHashNav);
    window.addEventListener('hashchange', onHashNav);
    return () => {
      window.removeEventListener('popstate', onHashNav);
      window.removeEventListener('hashchange', onHashNav);
    };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Tab>).detail;
      if (detail) setTab(detail);
    };
    window.addEventListener('forecast:navigate-tab', handler);
    return () => window.removeEventListener('forecast:navigate-tab', handler);
  }, []);

  // Clicking a deal anywhere in the app opens its 360 in the Search tab.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (!detail) return;
      setSelectedOppId(detail);
      setTab('deal');
    };
    window.addEventListener('forecast:open-opportunity', handler);
    return () => window.removeEventListener('forecast:open-opportunity', handler);
  }, []);

  const { handleSave, openRestore, restoreInput } = useDataBackup();
  const { cloudSyncError } = useForecast();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-4 md:px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="md:hidden">
            <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <SheetTrigger asChild>
                <button aria-label="Open menu" className="p-1.5 -ml-1.5 text-muted-foreground hover:text-foreground transition-colors">
                  <Menu size={18} />
                </button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0 flex flex-col">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <nav className="flex-1 overflow-y-auto p-2">
                  {VISIBLE_GROUPS.map((group, gi) => (
                    <Fragment key={gi}>
                      {gi > 0 && <div className="my-1 border-t border-border" />}
                      {group.map(id => (
                        <button
                          key={id}
                          onClick={() => { setTab(id); setMobileNavOpen(false); }}
                          className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm text-left ${tab === id ? 'bg-foreground text-background' : 'text-foreground hover:bg-secondary'}`}
                        >
                          {TAB_META[id].icon}
                          {TAB_META[id].label}
                        </button>
                      ))}
                    </Fragment>
                  ))}
                  <div className="my-1 border-t border-border" />
                  {OVERFLOW_TABS.map(id => (
                    <button
                      key={id}
                      onClick={() => { setTab(id); setMobileNavOpen(false); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm text-left ${tab === id ? 'bg-foreground text-background' : 'text-foreground hover:bg-secondary'}`}
                    >
                      {TAB_META[id].icon}
                      {TAB_META[id].label}
                    </button>
                  ))}
                </nav>
                <div className="border-t border-border p-2">
                  <button onClick={() => { handleSave(); setMobileNavOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm text-left text-foreground hover:bg-secondary">
                    <Download size={16} /> Save backup
                  </button>
                  <button onClick={() => { openRestore(); setMobileNavOpen(false); }} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm text-left text-foreground hover:bg-secondary">
                    <Upload size={16} /> Restore
                  </button>
                  <button onClick={() => { void supabase.auth.signOut(); }} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm text-left text-foreground hover:bg-secondary">
                    <LogOut size={16} /> Sign out
                  </button>
                </div>
              </SheetContent>
            </Sheet>
          </div>
          <span className="flex items-center justify-center w-[18px] h-[18px] rounded bg-foreground">
            <Compass size={11} className="text-background" />
          </span>
          <h1 className="text-sm font-semibold tracking-tight">Sales Compass</h1>
        </div>
        <div className="flex items-center gap-3">
          {cloudSyncError && (
            <span
              title={`Last failed sync: ${new Date(cloudSyncError).toLocaleTimeString()}. Changes are saved on this device and will sync when the connection recovers.`}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-400"
            >
              <AlertTriangle size={11} /> Sync failed · working locally
            </span>
          )}
          <nav className="hidden md:flex items-center gap-0.5 bg-secondary rounded-md p-0.5">
            {VISIBLE_GROUPS.map((group, gi) => (
              <Fragment key={gi}>
                {gi > 0 && <span className="w-px h-4 bg-border mx-1" />}
                {group.map(id => (
                  <button key={id} onClick={() => setTab(id)} className={tabClass(tab === id)}>
                    {TAB_META[id].icon}
                    {TAB_META[id].label}
                  </button>
                ))}
              </Fragment>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className={tabClass(OVERFLOW_TABS.includes(tab))}>
                  <MoreHorizontal size={14} />
                  More
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {OVERFLOW_TABS.map(id => (
                  <DropdownMenuItem key={id} className="gap-2 text-xs" onSelect={() => setTab(id)}>
                    {TAB_META[id].icon}
                    {TAB_META[id].label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </nav>
          <WeeklyBriefing />
          <div className="hidden md:block">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button title="More actions" className="p-1.5 text-muted-foreground hover:text-foreground transition-colors">
                  <MoreVertical size={16} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem className="gap-2 text-xs" onSelect={handleSave}>
                  <Download size={14} /> Save backup
                </DropdownMenuItem>
                <DropdownMenuItem className="gap-2 text-xs" onSelect={openRestore}>
                  <Upload size={14} /> Restore
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2 text-xs" onSelect={() => { void supabase.auth.signOut(); }}>
                  <LogOut size={14} /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {restoreInput}
        </div>
      </header>

      <PostImportBriefingBanner />

      <main className="max-w-6xl mx-auto px-4 md:px-6 py-6">
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
        {tab === 'dr-cleanup' && <DrCleanupTab />}
        {tab === 'scorecard' && (
          <div>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">Rep Scorecard (1:1s)</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Per-rep attainment, forecast, pipeline health, at-risk deals and channel quality — for 1:1 prep.</p>
            </div>
            <RepScorecard />
          </div>
        )}
        {tab === 'deal-risk' && (
          <div>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">Deal Risk</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Every open deal across all reps that's flagged at risk — pushed, stalled, or under-qualified.</p>
            </div>
            <DealRiskView />
          </div>
        )}
        {tab === 'deal' && (
          <div>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">Deal 360</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Search for a deal to see its overview, risk, next step, and call history in one place.</p>
            </div>
            <DealView selectedOppId={selectedOppId} onSelect={setSelectedOppId} />
          </div>
        )}
        {tab === 'inspection' && (
          <div>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">SQL Inspection</h2>
              <p className="text-xs text-muted-foreground">Manager sign-off prep for Qualified 5% to Discovery 25% advancement</p>
            </div>
            <InspectionPrep />
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

const DrCleanupTab = () => {
  const { dealRegistrations, reps } = useForecast();
  // Cleanup emails only address the team's own registrations. Records whose CURRENT
  // owner is off the configured rep roster are excluded here (derived at read time),
  // so no partner/owner ever gets a cleanup email about an off-team registration.
  const teamRepNameSet = useMemo(() => buildTeamRepNameSet(reps), [reps]);
  const teamDealRegistrations = useMemo(
    () => dealRegistrations.filter(d => isTeamOwned(d, teamRepNameSet)),
    [dealRegistrations, teamRepNameSet],
  );
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-semibold">Pipeline Cleanup</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Anchor-aware partner outreach cadence for stale and padded deal registrations.</p>
      </div>
      <DrCleanupPlanSection dealRegistrations={teamDealRegistrations} />
    </div>
  );
};

export default Index;
