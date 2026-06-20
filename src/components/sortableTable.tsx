import { useMemo, useState } from 'react';
import { ChevronsUpDown, ChevronUp, ChevronDown } from 'lucide-react';

// Shared table-sorting primitive, modeled on OpportunityList's existing sort:
// ChevronsUpDown when unsorted, ChevronUp for asc, ChevronDown for desc.

export type SortDir = 'asc' | 'desc';

export function useSortableRows<T, K extends string>(
  rows: T[],
  comparators: Record<K, (a: T, b: T) => number>, // each ascending
  initial?: { key: K; dir: SortDir },
): { sorted: T[]; sortKey: K | null; sortDir: SortDir; toggleSort: (key: K) => void } {
  const [sortKey, setSortKey] = useState<K | null>(initial?.key ?? null);
  const [sortDir, setSortDir] = useState<SortDir>(initial?.dir ?? 'asc');

  const toggleSort = (key: K) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc'); // a new column starts descending, sensible for metric-heavy tables
    }
  };

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const cmp = comparators[sortKey];
    return [...rows].sort((a, b) => (sortDir === 'desc' ? -cmp(a, b) : cmp(a, b)));
  }, [rows, comparators, sortKey, sortDir]);

  return { sorted, sortKey, sortDir, toggleSort };
}

export function SortHeader<K extends string>({
  field, label, sortKey, sortDir, onSort, align = 'left', title, className,
}: {
  field: K;
  label: string;
  sortKey: K | null;
  sortDir: SortDir;
  onSort: (key: K) => void;
  align?: 'left' | 'right' | 'center';
  title?: string;
  className?: string;
}): JSX.Element {
  const alignClass = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  const justifyClass = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : '';
  const Icon = field !== sortKey
    ? <ChevronsUpDown size={12} className="text-muted-foreground/50" />
    : sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />;
  return (
    <th
      onClick={() => onSort(field)}
      title={title}
      className={`${className ?? ''} ${alignClass} cursor-pointer select-none hover:text-foreground transition-colors`}
    >
      <span className={`inline-flex items-center gap-1 ${justifyClass}`}>{label} {Icon}</span>
    </th>
  );
}
