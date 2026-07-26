// One table for the whole console: sorting, search, pagination, sticky header,
// row actions, responsive.
//
// Deliberately not a table library. Every list here is server-fetched, already
// complete in memory, and at most a few hundred rows (32 players, a handful of
// saves, a few dozen backups) — so sorting and filtering are a `sort` and a
// `filter`, and TanStack Table would be ~15kB of abstraction over that.
//
// Responsiveness is the part that usually gets faked: below `md` each row becomes
// a stacked card with the column headers as labels, because a horizontally
// scrolling table on a phone is technically responsive and practically unusable.
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export type Column<Row> = {
  key: string;
  header: string;
  /** Cell renderer. Omit to render `row[key]`. */
  cell?: (row: Row) => React.ReactNode;
  /** Value used for sorting and search. Omit to fall back to `row[key]`. */
  value?: (row: Row) => string | number | null | undefined;
  sortable?: boolean;
  align?: "left" | "right";
  /** Numbers/IDs: monospace with tabular figures so columns line up. */
  mono?: boolean;
  /** Hide below md, for detail that doesn't survive a narrow screen. */
  secondary?: boolean;
  width?: string;
};

function rawValue<Row>(row: Row, col: Column<Row>): string | number | null | undefined {
  if (col.value) return col.value(row);
  return (row as Record<string, unknown>)[col.key] as string | number | null | undefined;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  actions,
  searchable = true,
  searchPlaceholder = "Search",
  pageSize = 0,
  empty = "Nothing here yet.",
  caption,
  toolbar,
}: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Rendered in a trailing column, and in the card footer on mobile. */
  actions?: (row: Row) => React.ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** 0 disables pagination. */
  pageSize?: number;
  empty?: React.ReactNode;
  caption?: string;
  toolbar?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      columns.some((c) => String(rawValue(row, c) ?? "").toLowerCase().includes(needle)),
    );
  }, [rows, columns, query]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return filtered;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = rawValue(a, col);
      const bv = rawValue(b, col);
      // Unknown values sort last regardless of direction — an empty cell is not
      // "smallest", it's absent.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }, [filtered, sort, columns]);

  const pages = pageSize > 0 ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const current = Math.min(page, pages - 1);
  const visible = pageSize > 0 ? sorted.slice(current * pageSize, current * pageSize + pageSize) : sorted;

  function toggleSort(key: string) {
    setPage(0);
    setSort((s) =>
      s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null,
    );
  }

  const showToolbar = searchable || toolbar;

  return (
    <div className="space-y-3">
      {showToolbar ? (
        <div className="flex flex-wrap items-center gap-3">
          {searchable ? (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
              <input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(0); }}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-9 w-56 rounded-md border border-line bg-surface-2 pl-8 pr-3 text-sm placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          ) : null}
          {toolbar}
          <span className="num ml-auto font-mono text-2xs text-faint">
            {query ? `${sorted.length} of ${rows.length}` : `${rows.length}`}
          </span>
        </div>
      ) : null}

      {/* ------------------------------------------------------ table (md+) */}
      <div className="hidden overflow-x-auto rounded-lg border border-line/60 md:block">
        <table className="w-full border-collapse text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="sticky top-0 z-10 bg-surface-2">
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    style={c.width ? { width: c.width } : undefined}
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                    className={cn(
                      "border-b border-line/60 px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-faint",
                      c.align === "right" ? "text-right" : "text-left",
                      c.secondary && "hidden lg:table-cell",
                    )}
                  >
                    {c.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded transition-colors hover:text-fg",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active && "text-fg",
                        )}
                      >
                        {c.header}
                        {active ? (
                          sort!.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-50" />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
              {actions ? (
                <th scope="col" className="border-b border-line/60 px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-faint">
                  Actions
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {visible.length ? (
              visible.map((row) => (
                <tr key={rowKey(row)} className="transition-colors duration-fast hover:bg-surface-2/60">
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        "border-b border-line/40 px-3 py-2.5 align-middle",
                        c.align === "right" && "text-right",
                        c.mono && "num font-mono text-xs",
                        c.secondary && "hidden lg:table-cell",
                      )}
                    >
                      {c.cell ? c.cell(row) : (rawValue(row, c) ?? "—")}
                    </td>
                  ))}
                  {actions ? (
                    <td className="border-b border-line/40 px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">{actions(row)}</div>
                    </td>
                  ) : null}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={columns.length + (actions ? 1 : 0)} className="px-3 py-10 text-center text-sm text-faint">
                  {query ? "Nothing matches that search." : empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ------------------------------------------------- stacked cards (<md) */}
      <div className="space-y-2 md:hidden">
        {visible.length ? (
          visible.map((row) => (
            <div key={rowKey(row)} className="rounded-lg border border-line/60 bg-surface p-3">
              <dl className="space-y-1.5">
                {columns.map((c) => (
                  <div key={c.key} className="flex items-baseline justify-between gap-3">
                    <dt className="eyebrow shrink-0">{c.header}</dt>
                    <dd className={cn("min-w-0 truncate text-right text-sm", c.mono && "num font-mono text-xs")}>
                      {c.cell ? c.cell(row) : (rawValue(row, c) ?? "—")}
                    </dd>
                  </div>
                ))}
              </dl>
              {actions ? (
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line/60 pt-2.5">
                  {actions(row)}
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <p className="rounded-lg border border-dashed border-line px-3 py-8 text-center text-sm text-faint">
            {query ? "Nothing matches that search." : empty}
          </p>
        )}
      </div>

      {pageSize > 0 && pages > 1 ? (
        <div className="flex items-center justify-between gap-3">
          <span className="num font-mono text-2xs text-faint">
            Page {current + 1} of {pages}
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="icon" variant="ghost" aria-label="Previous page"
              disabled={current === 0} onClick={() => setPage(current - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              size="icon" variant="ghost" aria-label="Next page"
              disabled={current >= pages - 1} onClick={() => setPage(current + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
