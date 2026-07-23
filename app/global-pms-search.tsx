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
import {
  parseSearchHistory,
  SEARCH_HISTORY_STORAGE_PREFIX,
  SearchHistoryEntry,
  updateSearchHistory,
} from "@/lib/search-history";
import { mergeSearchPage } from "@/lib/search-pagination";

type SearchItem = {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  meta: string;
  path: string;
};
type SearchGroup = {
  id: string;
  label: string;
  items: SearchItem[];
  nextCursor?: string;
};
type SearchResponse = {
  q: string;
  groups: SearchGroup[];
  total: number;
  truncated?: boolean;
  interpretedQuery?: string;
  correctionApplied?: boolean;
  error?: string;
};

export type GlobalSearchHandle = { focus: () => void };

const GlobalPmsSearch = forwardRef<
  GlobalSearchHandle,
  { propertyId: string; identity: string; onNavigate?: () => void }
>(function GlobalPmsSearch(
  { propertyId, identity, onNavigate },
  forwardedRef,
) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [history, setHistory] = useState<SearchHistoryEntry[]>([]);
  const [historyKey, setHistoryKey] = useState("");
  useImperativeHandle(forwardedRef, () => ({
    focus: () => inputRef.current?.focus(),
  }));

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Hash the already-authenticated identity before using it in a browser
    // storage key. The history value is session-only and expires after four
    // hours; a hard logout also clears every Talos search-history key.
    void crypto.subtle
      .digest(
        "SHA-256",
        new TextEncoder().encode(`${propertyId}\u0000${identity}`),
      )
      .then((digest) => {
        if (cancelled) return;
        const scope = Array.from(new Uint8Array(digest).slice(0, 12))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        const key = `${SEARCH_HISTORY_STORAGE_PREFIX}${propertyId}:${scope}`;
        setHistoryKey(key);
        setHistory(parseSearchHistory(sessionStorage.getItem(key)));
      })
      .catch(() => {
        // Search remains fully usable when storage or Web Crypto is blocked.
        if (!cancelled) {
          setHistoryKey("");
          setHistory([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [identity, propertyId]);

  useEffect(() => {
    const keyword = query.trim();
    if (keyword.length < 2) {
      setResult(null);
      setLoading(false);
      setActive(0);
      setOpen(keyword.length > 0);
      return;
    }
    // Never leave results from the previous query interactive during debounce.
    setResult(null);
    setActive(0);
    setOpen(true);
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/pms?view=search&q=${encodeURIComponent(keyword)}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const json = (await response.json()) as SearchResponse;
        if (!response.ok) throw new Error(json.error || "검색하지 못했습니다.");
        setResult(json);
        setActive(0);
        setOpen(true);
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setResult({
            q: keyword,
            groups: [],
            total: 0,
            error:
              reason instanceof Error ? reason.message : "검색하지 못했습니다.",
          });
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

  const showingHistory = query.trim().length === 0;
  const items = useMemo(
    () =>
      showingHistory
        ? history
        : (result?.groups.flatMap((group) => group.items) ?? []),
    [history, result, showingHistory],
  );
  const activeOptionId = items[active]
    ? `global-search-option-${active}`
    : undefined;
  const loadMore = async (group: SearchGroup) => {
    if (!group.nextCursor || loadingMore) return;
    const keyword = result?.interpretedQuery || result?.q || query.trim();
    setLoadingMore(group.id);
    try {
      const response = await fetch(
        `/api/pms?view=search&q=${encodeURIComponent(keyword)}&kind=${encodeURIComponent(group.id)}&cursor=${encodeURIComponent(group.nextCursor)}&limit=8`,
        { cache: "no-store" },
      );
      const json = (await response.json()) as SearchResponse;
      if (!response.ok)
        throw new Error(json.error || "다음 검색 결과를 불러오지 못했습니다.");
      const nextGroup = json.groups.find(
        (candidate) => candidate.id === group.id,
      );
      setResult((current) => {
        if (!current || !nextGroup) return current;
        const groups = mergeSearchPage(current.groups, nextGroup);
        return {
          ...current,
          groups,
          total: groups.reduce(
            (sum, candidate) => sum + candidate.items.length,
            0,
          ),
          truncated: groups.some((candidate) =>
            Boolean(candidate.nextCursor),
          ),
          error: undefined,
        };
      });
    } catch (reason) {
      setResult((current) =>
        current
          ? {
              ...current,
              error:
                reason instanceof Error
                  ? reason.message
                  : "다음 검색 결과를 불러오지 못했습니다.",
            }
          : current,
      );
    } finally {
      setLoadingMore("");
    }
  };
  const select = (item: SearchItem) => {
    const nextHistory = updateSearchHistory(history, item);
    setHistory(nextHistory);
    if (historyKey) {
      try {
        sessionStorage.setItem(historyKey, JSON.stringify(nextHistory));
      } catch {
        // Private browsing and storage quotas must not block navigation.
      }
    }
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
        onFocus={() =>
          setOpen(Boolean(result || query.trim().length > 0 || history.length))
        }
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
        aria-activedescendant={open ? activeOptionId : undefined}
        autoComplete="off"
      />
      {loading ? (
        <i className="search-spinner" aria-label="검색 중" />
      ) : query ? (
        <button
          type="button"
          aria-label="검색어 지우기"
          onClick={() => {
            setQuery("");
            setResult(null);
            inputRef.current?.focus();
          }}
        >
          ×
        </button>
      ) : (
        <kbd>⌘ K</kbd>
      )}
      {open && (
        <div
          className="global-search-results"
          id="global-search-results"
          role="listbox"
        >
          {query.trim().length === 1 ? (
            <p className="global-search-message">
              <b>2자 이상 입력해 주세요.</b>
              <span>
                고객명, 예약번호, 전화번호, 객실 또는 청구서를 검색할 수
                있습니다.
              </span>
            </p>
          ) : null}
          {showingHistory && history.length > 0 ? (
            <section
              className="global-search-history"
              role="group"
              aria-label="최근 열어본 검색 결과"
            >
              <h3>최근 열어본 검색 결과</h3>
              {history.map((item, index) => (
                <button
                  id={`global-search-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? "active" : ""}
                  key={`${item.kind}:${item.id}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => select(item)}
                >
                  <span>
                    <b>{item.title}</b>
                    <small>{item.subtitle}</small>
                  </span>
                  <em>
                    {item.selectionCount > 1
                      ? `자주 사용 · ${item.selectionCount}회`
                      : item.meta}
                  </em>
                  <i aria-hidden="true">›</i>
                </button>
              ))}
            </section>
          ) : null}
          {result?.error ? (
            <p className="global-search-message error">{result.error}</p>
          ) : null}
          {result?.correctionApplied && result.interpretedQuery ? (
            <p className="global-search-message" role="status">
              <b>한/영 키 입력을 자동 교정했어요.</b>
              <span>“{result.interpretedQuery}” 검색 결과입니다.</span>
            </p>
          ) : null}
          {!loading && result && result.total === 0 && !result.error ? (
            <p className="global-search-message">
              <b>검색 결과가 없습니다.</b>
              <span>예약번호나 전화번호 일부를 다시 입력해 보세요.</span>
            </p>
          ) : null}
          {!showingHistory &&
            result?.groups.map((group) => (
            <section key={group.id} role="group" aria-label={group.label}>
              <h3>{group.label}</h3>
              {group.items.map((item) => {
                const index = items.findIndex(
                  (candidate) =>
                    candidate.kind === item.kind && candidate.id === item.id,
                );
                return (
                  <button
                    id={`global-search-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={index === active ? "active" : ""}
                    key={`${item.kind}:${item.id}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => select(item)}
                  >
                    <span>
                      <b>{item.title}</b>
                      <small>{item.subtitle}</small>
                    </span>
                    <em>{item.meta}</em>
                    <i aria-hidden="true">›</i>
                  </button>
                );
              })}
              {group.nextCursor ? (
                <button
                  type="button"
                  className="global-search-more"
                  disabled={Boolean(loadingMore)}
                  aria-busy={loadingMore === group.id}
                  onClick={() => void loadMore(group)}
                >
                  {loadingMore === group.id
                    ? "다음 결과 불러오는 중…"
                    : `${group.label} 결과 더 보기`}
                </button>
              ) : null}
            </section>
            ))}
          {!showingHistory && result && result.total > 0 ? (
            <footer>
              {result.total}{result.truncated ? "건 이상 · 상위 결과만 표시" : "건"} · ↑↓ 이동 · Enter 열기
            </footer>
          ) : null}
        </div>
      )}
    </div>
  );
});

export default GlobalPmsSearch;
