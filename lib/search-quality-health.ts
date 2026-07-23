/** Deterministic alert policy for privacy-safe daily search aggregates. */
export type SearchQualityDailyFact = {
  event_date: string;
  searches: number;
  zero_results: number;
  slow_searches: number;
  correction_searches: number;
};

export type SearchQualityHealth =
  | "HEALTHY"
  | "WATCH"
  | "CRITICAL"
  | "LEARNING";

export type SearchQualityDailyHealth = SearchQualityDailyFact & {
  zero_rate: number;
  slow_rate: number;
  correction_rate: number;
  health: SearchQualityHealth;
  recommendation: string;
};

function percentage(part: number, whole: number) {
  if (whole <= 0) return 0;
  return Math.round((part * 10_000) / whole) / 100;
}

/**
 * Low-volume days never alert: a single unusual search must not create an
 * operational incident. At 10 searches the day becomes observable, and at 20
 * searches the stricter critical thresholds become statistically meaningful.
 */
export function classifySearchHealth(
  fact: SearchQualityDailyFact,
): SearchQualityDailyHealth {
  const searches = Math.max(0, Number(fact.searches) || 0);
  const zeroResults = Math.min(
    searches,
    Math.max(0, Number(fact.zero_results) || 0),
  );
  const slowSearches = Math.min(
    searches,
    Math.max(0, Number(fact.slow_searches) || 0),
  );
  const correctionSearches = Math.min(
    searches,
    Math.max(0, Number(fact.correction_searches) || 0),
  );
  const zeroRate = percentage(zeroResults, searches);
  const slowRate = percentage(slowSearches, searches);
  const correctionRate = percentage(correctionSearches, searches);
  let health: SearchQualityHealth = "LEARNING";
  let recommendation = "표본 10건이 모이면 품질 판정을 시작합니다.";

  if (searches >= 20 && (slowRate >= 25 || zeroRate >= 45)) {
    health = "CRITICAL";
    recommendation =
      slowRate >= 25
        ? "느린 검색 비율이 높습니다. DB 지연과 실행계획을 즉시 점검하세요."
        : "무결과 비율이 높습니다. 검색어 별칭과 검색 문서 동기화를 점검하세요.";
  } else if (searches >= 10 && (slowRate >= 10 || zeroRate >= 30)) {
    health = "WATCH";
    recommendation =
      slowRate >= 10
        ? "검색 지연 추세를 관찰하고 인덱스·리전 상태를 확인하세요."
        : "무결과 추세를 관찰하고 검색 사전 확장을 검토하세요.";
  } else if (searches >= 10) {
    health = "HEALTHY";
    recommendation = "설정된 검색 품질 기준을 충족합니다.";
  }

  return {
    event_date: fact.event_date,
    searches,
    zero_results: zeroResults,
    slow_searches: slowSearches,
    correction_searches: correctionSearches,
    zero_rate: zeroRate,
    slow_rate: slowRate,
    correction_rate: correctionRate,
    health,
    recommendation,
  };
}
