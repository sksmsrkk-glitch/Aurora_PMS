/** Privacy-safe search quality aggregation; raw queries never reach storage. */
import type { PmsDatabase } from "../../../db/pms-database";

export type SearchQualityInput = {
  query: string;
  total: number;
  truncated: boolean;
  correctionApplied: boolean;
  latencyMs: number;
};

export type SearchQualityDimensions = {
  queryLengthBucket: 2 | 4 | 8 | 16 | 32 | 64 | 120;
  queryScript: "HANGUL" | "LATIN" | "NUMERIC" | "MIXED" | "OTHER";
  correctionUsed: boolean;
  resultBucket: "ZERO" | "ONE" | "FEW" | "MANY" | "TRUNCATED";
  latencyBucket: "FAST" | "NORMAL" | "SLOW";
  zeroResult: boolean;
};

function lengthBucket(length: number): SearchQualityDimensions["queryLengthBucket"] {
  return ([2, 4, 8, 16, 32, 64, 120] as const).find(
    (boundary) => length <= boundary,
  ) ?? 120;
}

function scriptBucket(query: string): SearchQualityDimensions["queryScript"] {
  const value = query.replace(/\s/gu, "");
  if (/^\d+$/u.test(value)) return "NUMERIC";
  if (/^[가-힣ㄱ-ㅎㅏ-ㅣ]+$/u.test(value)) return "HANGUL";
  if (/^[A-Za-z]+$/u.test(value)) return "LATIN";
  const families = [
    /[0-9]/u.test(value),
    /[A-Za-z]/u.test(value),
    /[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(value),
  ].filter(Boolean).length;
  return families >= 2 ? "MIXED" : "OTHER";
}

export function classifySearchQuality(
  input: SearchQualityInput,
): SearchQualityDimensions {
  const queryLength = Math.max(2, Array.from(input.query.trim()).length);
  const resultBucket = input.truncated
    ? "TRUNCATED"
    : input.total === 0
      ? "ZERO"
      : input.total === 1
        ? "ONE"
        : input.total <= 5
          ? "FEW"
          : "MANY";
  return {
    queryLengthBucket: lengthBucket(queryLength),
    queryScript: scriptBucket(input.query),
    correctionUsed: input.correctionApplied,
    resultBucket,
    latencyBucket:
      input.latencyMs < 200
        ? "FAST"
        : input.latencyMs < 800
          ? "NORMAL"
          : "SLOW",
    zeroResult: input.total === 0,
  };
}

export async function recordSearchQuality(
  db: PmsDatabase,
  input: SearchQualityInput,
) {
  const dimensions = classifySearchQuality(input);
  await db
    .prepare(
      `INSERT INTO pms_search_quality_daily(
         property_id,event_date,query_length_bucket,query_script,
         correction_used,result_bucket,latency_bucket,searches,zero_results,
         updated_at
       )
       SELECT
         p.id,p.business_date,?,?,?,?,?,?,?,clock_timestamp()
         FROM properties p
        WHERE p.id=pms_current_property_id()
       ON CONFLICT(
         property_id,event_date,query_length_bucket,query_script,
         correction_used,result_bucket,latency_bucket
       )
       DO UPDATE SET
         searches=pms_search_quality_daily.searches+1,
         zero_results=pms_search_quality_daily.zero_results+excluded.zero_results,
         updated_at=excluded.updated_at`,
    )
    .bind(
      dimensions.queryLengthBucket,
      dimensions.queryScript,
      dimensions.correctionUsed,
      dimensions.resultBucket,
      dimensions.latencyBucket,
      1,
      dimensions.zeroResult ? 1 : 0,
    )
    .run();
  return dimensions;
}
