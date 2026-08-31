import { useForecast } from '@/context/ForecastContext';
import { UserPlus, X } from 'lucide-react';

/**
 * Non-blocking notice for owner names an import added to the roster.
 *
 * Every new name defaults to off-team, so nothing it owns can reach a funnel total or
 * rollup before the user has classified it. This banner is also the name-drift safety
 * net: if Salesforce renders an existing person's name differently, the variant arrives
 * as a "new owner" and surfaces here rather than silently splitting that person's book.
 */
export default function NewOwnerBanner() {
  const { newOwnerNotice, dismissNewOwnerNotice } = useForecast();
  if (newOwnerNotice.names.length === 0) return null;

  const { names } = newOwnerNotice;
  const goToRoster = () => {
    window.dispatchEvent(new CustomEvent('forecast:navigate-tab', { detail: 'goals' }));
  };

  return (
    <div className="mb-4 border border-blue-500/40 bg-blue-500/10 rounded-md text-xs">
      <div className="flex items-start justify-between gap-3 px-3 py-2">
        <span className="flex items-start gap-2 text-blue-700 dark:text-blue-400">
          <UserPlus size={13} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium">New owners detected: {names.join(', ')}.</span>{' '}
            <button onClick={goToRoster} className="underline underline-offset-2 hover:no-underline">
              Review team roster.
            </button>{' '}
            <span className="opacity-80">
              Added as not on team, so their deals are stored and visible but excluded from
              funnel totals and rollups until you say otherwise.
            </span>
          </span>
        </span>
        <button
          onClick={dismissNewOwnerNotice}
          title="Dismiss"
          className="shrink-0 text-blue-700/70 dark:text-blue-400/70 hover:text-blue-700 dark:hover:text-blue-400"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
