"use client";

/** Always-available cross-domain PMS search with keyboard navigation. */

import { useRouter } from "next/navigation";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

type SearchItem = {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  meta: string;
  path: string;
};
type SearchGroup = { id: string; label: string; items: SearchItem[] };
type SearchResponse = { q: string; groups: SearchGroup[]; total: number; error?: string };

export type GlobalSearchHandle = { focus: () => void };

const GlobalPmsSearch = forwardRef<GlobalSearchHandle, { onNavigate?: () => void }>(
  function GlobalPmsSearch({ onNavigate }, forwardedRef) {
    const router = useRouter();
    const inputRef = useRef<HTMLInputElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const [query, setQuery] = useState("");
    const [result, setResult] = useState<SearchResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    useImperativeHandle(forwardedRef, () => ({ focus: () => inputRef.current?.focus() }));

    useEffect(() => {
      const close = (event: PointerEvent) => {
        if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
      };
      document.addEventListener("pointerdown", close);
      return () => document.removeEventListener("pointerdown", close);
    }, []);

    useEffect(() => {
      const keyword = query.trim();
      if (keyword.length < 2) {
        setResult(null);
        setLoading(false);
        return;
      }
      const controller = new AbortController();
      const timer = window.setTimeout(async () => {
        setLoading(true);
        try {
          const response = await fetch(`/api/pms?view=search&q=${encodeURIComponent(keyword)}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          const json = (await response.json()) as SearchResponse;
          if (!response.ok) throw new Error(json.error || "검색하지 못했습니다.");
          setResult(json);
          setActive(0);
          setOpen(true);
        } catch (reason) {
          if (!(reason instanceof DOMException && reason.name === "AbortError")) {
            setResult({ q: keyword, groups: [], total: 0, error: reason instanceof Error ? reason.message : "검색하지 못했습니다." });
            // A failed request must still open the result surface; otherwise the
            // search appears to do nothing and operators cannot distinguish a
            // backend incident from a genuine zero-result query.
            setOpen(true);
          }
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      }, 250);
      return () => {
        window.clearTimeout(timer);
        controller.abort();
      };
    }, [query]);

    const items = useMemo(() => result?.groups.flatMap((group) => group.items) ?? [], [result]);
    const select = (item: SearchItem) => {
      setOpen(false);
      setQuery("");
      onNavigate?.();
      router.push(item.path);
    };
    return (
      <div className="global-pms-search" ref={rootRef} role="search">
        <span aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          value={query}
          onFocus={() => setOpen(Boolean(result || query.trim().length >= 2))}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
            if (event.key === "ArrowDown" && items.length) {
              event.preventDefault();
              setActive((value) => (value + 1) % items.length);
              setOpen(true);
            }
            if (event.key === "ArrowUp" && items.length) {
              event.preventDefault();
              setActive((value) => (value - 1 + items.length) % items.length);
              setOpen(true);
            }
            if (event.key === "Enter" && open && items[active]) {
              event.preventDefault();
              select(items[active]);
            }
          }}
          placeholder="고객, 예약번호, 전화, 채널번호, 객실, 청구서 검색"
          aria-label="PMS 통합 검색"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="global-search-results"
          autoComplete="off"
        />
        {loading ? <i className="search-spinner" aria-label="검색 중" /> : query ? (
          <button type="button" aria-label="검색어 지우기" onClick={() => { setQuery(""); setResult(null); inputRef.current?.focus(); }}>×</button>
        ) : <kbd>⌘ K</kbd>}
        {open && (
          <div className="global-search-results" id="global-search-results" role="listbox">
            {result?.error ? <p className="global-search-message error">{result.error}</p> : null}
            {!loading && result && result.total === 0 && !result.error ? (
              <p className="global-search-message"><b>검색 결과가 없습니다.</b><span>예약번호나 전화번호 일부를 다시 입력해 보세요.</span></p>
            ) : null}
            {result?.groups.map((group) => (
              <section key={group.id} aria-label={group.label}>
                <h3>{group.label}</h3>
                {group.items.map((item) => {
                  const index = items.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id);
                  return <button type="button" role="option" aria-selected={index === active} className={index === active ? "active" : ""} key={`${item.kind}:${item.id}`} onMouseEnter={() => setActive(index)} onClick={() => select(item)}>
                    <span><b>{item.title}</b><small>{item.subtitle}</small></span><em>{item.meta}</em><i aria-hidden="true">›</i>
                  </button>;
                })}
              </section>
            ))}
            {result && result.total > 0 ? <footer>{result.total}건 · ↑↓ 이동 · Enter 열기</footer> : null}
          </div>
        )}
      </div>
    );
  },
);

export default GlobalPmsSearch;
