import type { TranscriptSignals } from '@/lib/transcripts';

// Shared rendering for extracted transcript signals — used by the TranscriptDialog
// and the deal 360 so both render identically.

const SENTIMENT_CLASS: Record<TranscriptSignals['sentiment'], string> = {
  positive: 'bg-positive/10 text-positive',
  neutral: 'bg-secondary text-muted-foreground',
  negative: 'bg-negative/10 text-negative',
};

function Chips({ label, items, className }: { label: string; items: string[]; className: string }) {
  if (items.length === 0) return null;
  return (
    <div className="flex items-start gap-2 flex-wrap">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">{label}</span>
      {items.map((it, i) => (
        <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded ${className}`}>{it}</span>
      ))}
    </div>
  );
}

export function SignalsView({ signals }: { signals: TranscriptSignals }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Sentiment</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${SENTIMENT_CLASS[signals.sentiment]}`}>{signals.sentiment}</span>
        {signals.stakeholders.map((s, i) => (
          <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-foreground">
            {s.name}{s.role ? ` · ${s.role}` : ''}
          </span>
        ))}
      </div>
      <Chips label="Competitors" items={signals.competitors} className="bg-upside/10 text-upside" />
      <Chips label="Commitments" items={signals.commitments} className="bg-commit/10 text-commit" />
      <Chips label="Risks" items={signals.risks} className="bg-negative/10 text-negative" />
    </div>
  );
}
