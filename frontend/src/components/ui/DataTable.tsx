import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import { EmptyState } from './EmptyState';
import { IconButton } from './IconButton';
import { Skeleton } from './Skeleton';

export type SortDir = 'asc' | 'desc';
export interface SortState { key: string; dir: SortDir }
type Primitive = string | number | boolean | Date | null | undefined;

export interface Column<T> {
  /** Unique column key (also the default accessor: `row[key]`). */
  key: string;
  header: ReactNode;
  /** Value used for sorting & searching. Defaults to `row[key]`. */
  accessor?: (row: T) => Primitive;
  /** Custom cell renderer. Defaults to the accessor value. */
  cell?: (row: T) => ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right' | 'center';
  /** Hide on small screens. */
  hideBelow?: 'sm' | 'md' | 'lg';
  className?: string;
  /** e.g. 'w-32' */
  width?: string;
}

export interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  /** Show the search box (filters across all accessors, case-insensitive). */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Rows per page; 0 disables pagination. Default 10. */
  pageSize?: number;
  initialSort?: SortState;
  loading?: boolean;
  /** Shown when there are no rows (or no search matches). */
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Highlight a row (e.g. selected request). */
  isRowActive?: (row: T) => boolean;
  /** Extra controls on the right of the toolbar (filters, export). */
  toolbar?: ReactNode;
  /** Accessible table caption (visually hidden). */
  caption: string;
  /** Max height with sticky header scroll (e.g. '28rem'). */
  maxHeight?: string;
  className?: string;
}

const getVal = <T,>(row: T, col: Column<T>): Primitive =>
  col.accessor ? col.accessor(row) : ((row as Record<string, unknown>)[col.key] as Primitive);

function cmp(a: Primitive, b: Primitive): number {
  const an = a === null || a === undefined || a === '', bn = b === null || b === undefined || b === '';
  if (an && bn) return 0;
  if (an) return 1; // empties last regardless of direction (handled by caller)
  if (bn) return -1;
  if (a instanceof Date || b instanceof Date) return new Date(a as Date).getTime() - new Date(b as Date).getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), 'en-IN', { numeric: true, sensitivity: 'base' });
}

/** Pure, stable sort used by DataTable (exported for tests). Empty values always sort last. */
export function sortRows<T>(rows: T[], columns: Column<T>[], sort: SortState | null): T[] {
  if (!sort) return rows;
  const col = columns.find((c) => c.key === sort.key);
  if (!col) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: getVal(row, col) }))
    .sort((x, y) => {
      const xe = x.v === null || x.v === undefined || x.v === '', ye = y.v === null || y.v === undefined || y.v === '';
      if (xe !== ye) return xe ? 1 : -1;
      return cmp(x.v, y.v) * sign || x.i - y.i;
    })
    .map((x) => x.row);
}

/** Pure search filter (exported for tests). */
export function filterRows<T>(rows: T[], columns: Column<T>[], q: string): T[] {
  const s = q.trim().toLowerCase();
  if (!s) return rows;
  return rows.filter((r) => columns.some((c) => {
    const v = getVal(r, c);
    return v !== null && v !== undefined && String(v instanceof Date ? v.toISOString() : v).toLowerCase().includes(s);
  }));
}

const HIDE = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' };
const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' };

/** Sortable (aria-sort), searchable, paginated table with sticky header and loading/empty rows. */
export function DataTable<T>({
  data, columns, rowKey, searchable, searchPlaceholder = 'Search', pageSize = 10, initialSort, loading, empty,
  onRowClick, isRowActive, toolbar, caption, maxHeight, className,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);

  const rows = useMemo(() => sortRows(filterRows(data, columns, q), columns, sort), [data, columns, q, sort]);
  const pages = pageSize > 0 ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1;
  const cur = Math.min(page, pages - 1);
  const visible = pageSize > 0 ? rows.slice(cur * pageSize, cur * pageSize + pageSize) : rows;

  const toggle = (key: string) => {
    setPage(0);
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));
  };

  return (
    <div className={cn('overflow-hidden rounded-lg border border-line/70 bg-surface shadow-card', className)}>
      {(searchable || toolbar) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          {searchable && (
            <label className="relative min-w-[200px] flex-1 sm:max-w-xs">
              <span className="sr-only">{searchPlaceholder}</span>
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden />
              <input
                type="search"
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(0); }}
                placeholder={searchPlaceholder}
                className="h-10 w-full rounded-md border border-line-strong bg-surface pl-9 pr-3 text-sm placeholder:text-ink-400 focus:border-brand-500 focus:shadow-focus focus:outline-none"
              />
            </label>
          )}
          {toolbar && <div className="ml-auto flex items-center gap-2">{toolbar}</div>}
        </div>
      )}
      <div className="overflow-auto scrollbar-thin" style={maxHeight ? { maxHeight } : undefined}>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 z-[1] bg-surface shadow-[inset_0_-1px_0_rgb(var(--line))]">
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const ariaSort = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : c.sortable ? 'none' : undefined;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={cn('whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-500', ALIGN[c.align ?? 'left'], c.hideBelow && HIDE[c.hideBelow], c.width)}
                  >
                    {c.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggle(c.key)}
                        className={cn('-mx-1 inline-flex items-center gap-1 rounded-sm px-1 uppercase hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500', active && 'text-ink-900', c.align === 'right' && 'flex-row-reverse')}
                      >
                        {c.header}
                        {active ? (sort!.dir === 'asc' ? <ArrowUp size={14} aria-hidden /> : <ArrowDown size={14} aria-hidden />) : <ChevronsUpDown size={14} className="opacity-50" aria-hidden />}
                      </button>
                    ) : c.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && data.length === 0 ? (
              Array.from({ length: Math.min(pageSize || 5, 5) }, (_, i) => (
                <tr key={`sk-${i}`} className="border-t border-line first:border-0">
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-4 py-3.5', c.hideBelow && HIDE[c.hideBelow])}><Skeleton className="h-4 w-full max-w-[140px]" /></td>
                  ))}
                </tr>
              ))
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  {empty ?? <EmptyState compact title={q ? 'No matches' : 'Nothing here yet'} description={q ? `Nothing matches “${q}”.` : undefined} />}
                </td>
              </tr>
            ) : (
              visible.map((row) => {
                const active = isRowActive?.(row);
                return (
                  <tr
                    key={rowKey(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row); } : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    aria-selected={isRowActive ? !!active : undefined}
                    className={cn(
                      'border-t border-line/80 transition-colors first:border-0',
                      onRowClick && 'cursor-pointer hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-none',
                      active && 'bg-brand-50/60 hover:bg-brand-50',
                    )}
                  >
                    {columns.map((c) => (
                      <td key={c.key} className={cn('px-4 py-3 text-ink-900', ALIGN[c.align ?? 'left'], c.align === 'right' && 'tabular-nums', c.hideBelow && HIDE[c.hideBelow], c.className)}>
                        {c.cell ? c.cell(row) : String(getVal(row, c) ?? '--')}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {pageSize > 0 && rows.length > pageSize && (
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2 text-sm text-ink-500">
          <span className="tabular-nums">
            {cur * pageSize + 1}–{Math.min(rows.length, (cur + 1) * pageSize)} of {rows.length}
          </span>
          <div className="flex items-center gap-1">
            <IconButton label="Previous page" icon={ChevronLeft} size="sm" disabled={cur === 0} onClick={() => setPage(cur - 1)} />
            <span className="px-1 tabular-nums" aria-live="polite">Page {cur + 1} of {pages}</span>
            <IconButton label="Next page" icon={ChevronRight} size="sm" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} />
          </div>
        </div>
      )}
    </div>
  );
}
