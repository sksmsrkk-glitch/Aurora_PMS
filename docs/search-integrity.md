# 검색 무결성·용량 검증 기록

이 문서는 Talos PMS 통합 검색의 정확성, 개인정보 경계, 대형 호텔 용량, UI 동작을 한 번에 재현하는 운영 계약입니다. 검색 구현을 변경하는 PR은 아래 테스트와 임계값을 낮추거나 건너뛸 수 없습니다.

## 2026-07-23 발견 사항과 수정

| 발견된 문제 | 근본 원인 | 수정 | 재발 방지 |
| --- | --- | --- | --- |
| 영문 `Kim Minji`로 `김민지`를 찾지 못함 | 검색 문서에 한글 이름과 두벌식 변환만 있고 로마자 별칭이 없음 | Revised Romanization 함수와 한국에서 흔한 성씨 별칭을 토큰에 추가하고 전체 문서를 재색인 | PostgreSQL 행동 테스트가 `Kim Minji`, `gimminji`, `kimminji`를 각각 검증 |
| 객실번호 `101` 검색에서 예약이 객실보다 먼저 표시됨 | 도메인 그룹 정렬이 상위 행 점수만 비교해 exact identifier를 구분하지 않음 | 예약번호·객실번호·청구서 번호가 정확히 일치한 그룹에 식별자 우선 점수 부여 | API 행동 테스트와 인증 UI QA가 객실 그룹 선두 및 Enter 딥링크를 검증 |
| cursor payload 변조·다른 호텔 재사용을 암호학적으로 차단하지 못함 | 기존 cursor는 opaque 형식만 갖고 서버 서명이 없었음 | HMAC-SHA256 v2 cursor, query/property fingerprint, constant-time 검증, 운영 secret fail-closed 적용 | 변조, query/kind/property 교차 사용, 운영 secret 누락, 17행 keyset 중복·누락 0건 테스트 |
| 검색 상태를 운영자가 정량적으로 알 수 없음 | 비식별 telemetry는 수집했지만 판정·리포트가 없음 | 10건 미만 LEARNING, WATCH/CRITICAL 임계값과 `search_quality` 리포트 추가 | tenant 범위와 원문 query/hash/user/entity 비노출 PostgreSQL 테스트 |
| 100,000실 exact·broad 검색이 p95 목표를 초과 | 문서 우선 correlated term scan과 BTREE/GIN 조건을 한 OR 계획에 혼합 | term-first 후보, exact BTREE 경로와 fuzzy GIN 경로 분리, exact 존재 시 fuzzy 억제 | 주간 100,000실·8동시 용량 workflow가 p95 예산 초과 시 실패 |
| 숫자·영문 오타가 초성 GIN을 중복 실행 | Latin 입력에서 `initialQuery`와 `compactQuery`가 같음 | 한글/자모가 실제 입력된 경우에만 초성 경로 실행 | 100,000실 typo p95 SLA와 검색 정규화 단위 테스트 |
| 100,000실 fixture 생성이 행 trigger 100,000회 때문에 시험 시간을 지배 | 읽기 용량과 인덱스 유지 비용을 한 시험이 동시에 측정 | 2,000실 CI는 실제 trigger 유지, 100,000실은 같은 운영 table/index/정규화 shape를 set-based 적재 | 결과에 `fixtureMode`와 `fixtureSetupMs`를 표시하고 두 workflow를 모두 유지 |
| UI 검색 회귀가 소스 테스트만으로 통과 가능 | 실제 인증·hydration·키보드·모바일 흐름을 CI가 열지 않음 | mock Supabase Auth를 사용하는 loopback 전용 production harness와 Chromium QA 추가 | 로그인, HttpOnly session, 로마자/교정/exact/Enter, 품질 리포트, 로그아웃, 390px overflow, console/500 오류를 CI에서 검증 |
| Next.js 의존성에 high 취약점이 탐지됨 | 고정 버전이 보안 수정 이전 patch였음 | Next.js 16.2.11과 Playwright 1.61.1로 갱신 | `npm audit --audit-level=high`를 CI 첫 단계에 고정 |

## 정확성 계약

- NFKC, 대소문자, 연속 공백, 구두점 없는 전화번호, `%`·`_`·`\` 리터럴을 동일하게 처리합니다.
- 한국어 이름은 이름+성, 성+이름, 초성, 두벌식 오입력과 로마자 별칭으로 찾습니다. 일반 영문 이름은 한글로 임의 변환하지 않습니다.
- exact token → prefix → contains/초성 → trigram 순으로 평가하고, exact 예약번호·객실번호·청구서 번호는 해당 업무 그룹을 우선합니다.
- 검색 cursor에는 원문이 없으며 서명, query, entity kind, property가 모두 일치해야 합니다.
- 예약·객실·AR 검색은 현재 사용자의 workspace READ 권한을 넘지 않습니다.

## 개인정보·경보 계약

`pms_search_quality_daily`에는 query, query hash, 사용자 ID, entity ID를 저장하지 않습니다. 길이 bucket, 문자군, 교정 사용 여부, 결과 bucket, 지연 bucket과 횟수만 호텔·일자별로 집계합니다.

| 상태 | 판정 |
| --- | --- |
| `LEARNING` | 일 검색 10건 미만 |
| `HEALTHY` | 10건 이상이며 WATCH/CRITICAL 미해당 |
| `WATCH` | 10건 이상, 느린 검색률 10% 이상 또는 무결과율 30% 이상 |
| `CRITICAL` | 20건 이상, 느린 검색률 25% 이상 또는 무결과율 45% 이상 |

단일 검색이나 적은 표본으로 사고 경보가 발생하지 않도록 최소 표본을 강제합니다.

## 용량 계약과 기준 결과

모든 benchmark는 loopback PostgreSQL만 허용하고 합성 호텔을 별도 `property_id`로 만든 뒤 잔여 행 0건을 확인합니다.

```bash
# PR/main: 실제 trigger 유지와 검색을 함께 확인
SEARCH_BENCHMARK_ROWS=2000 \
SEARCH_BENCHMARK_SAMPLES=5 \
SEARCH_BENCHMARK_CONCURRENCY=4 \
npm run benchmark:search:ci

# 주간/manual: 운영 table/index shape의 대형 read capacity
SEARCH_BENCHMARK_ROWS=100000 \
SEARCH_BENCHMARK_SAMPLES=20 \
SEARCH_BENCHMARK_CONCURRENCY=8 \
npm run benchmark:search
```

2026-07-23 로컬 PostgreSQL 17 기준:

| 규모·방식 | exact p95 | typo p95 | broad p95 | 동시 p95 | 처리량 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2,000실, 실제 trigger, 4명×5회 | 12.87ms | 105.58ms | 35.43ms | 103.37ms | 70.86 ops/s |
| 100,000실, 운영 shape bulk, 8명×20회 | 76.59ms | 965.03ms | 1,242.37ms | 2,135.61ms | 6.51 ops/s |

게이트는 순차 p95 1,500ms, 동시 p95 5,000ms입니다. 수치는 개발 PC의 회귀 기준이며 실제 계약 SLA는 스테이징/운영과 동일한 compute·pool·region에서 다시 정합니다.

## 자동 검증

- `tests/search-behavior.test.mjs`: 정규화, 키보드, privacy dimension, alert threshold, history, signed cursor, keyset merge.
- `tests/postgres-core.integration.mjs`: 실제 migration, tenant RLS, trigger sync, romanization, exact ordering, cursor paging, privacy aggregation/report.
- `scripts/benchmark-search.mjs`: loopback 전용 용량, 동시성, p95 budget, fixture cleanup.
- `scripts/qa-search-ui.mjs`: 실제 production build의 인증된 desktop/390px 흐름.
- `.github/workflows/ci.yml`: 보안 audit → lint → build → unit → migration → contract/smoke → PostgreSQL integration → 2,000실 → UI QA.
- `.github/workflows/search-capacity.yml`: 매주 100,000실·8동시 장기 회귀.

## 운영자 점검

리포트 센터의 `검색 품질 · 경보`를 일별로 확인합니다. WATCH/CRITICAL 발생 시 원문 검색어를 수집하지 말고 먼저 DB 실행계획, 리전 지연, 검색 문서 trigger 동기화, 로마자/업무 별칭 사전을 점검합니다. 별칭 확장이 필요하면 개인 검색어 로그가 아니라 검증된 도메인 용어를 forward migration과 행동 테스트로 추가합니다.
