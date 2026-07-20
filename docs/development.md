# Talos PMS 개발자 가이드

## 설치 및 Supabase 연결

### 요구사항

- Node.js `24.x` (`package.json#engines`와 동일)
- npm
- Supabase 프로젝트
- GitHub CLI는 게시 작업에만 필요

### 설치

```bash
npm install
npm run dev
```

기본 개발 주소는 `http://localhost:3000`입니다.

### 환경 변수

`.env.local`에 다음 값을 저장합니다. 실제 키를 README나 Git에 기록하지 마세요.

```dotenv
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=<server-secret-key>
DATABASE_URL=postgresql://<user>:<password>@<pooler-host>:6543/postgres?sslmode=require
DIRECT_URL=postgresql://<user>:<password>@<session-or-direct-host>:5432/postgres?sslmode=require
PMS_RATE_LIMIT_SECRET=<32-or-more-random-characters>
# 개발 회귀에서만 선택적으로 사용
PMS_ALLOW_DEMO_AUTH=false
# PMS_DEMO_USER_EMAIL=pms@allmytour.com
# PMS_DEMO_AUTH_TOKEN=<32-or-more-random-characters>
```

- `SUPABASE_URL`: Project API URL
- `SUPABASE_SECRET_KEY`: 서버 런타임 전용이며 브라우저에 노출하지 않음
- `DATABASE_URL`: 애플리케이션 전용 Supavisor transaction pooler URL, port `6543`
- `DIRECT_URL`: migration·catalog 검사 전용 session 또는 direct DB URL
- `PMS_RATE_LIMIT_SECRET`: 주소를 원문 저장하지 않고 HMAC digest로 만드는 production 필수 secret
- Project URL과 Database URL은 서로 다른 값입니다.
- `PMS_ALLOW_DEMO_AUTH`, `PMS_DEMO_USER_EMAIL`, `PMS_DEMO_AUTH_TOKEN`: Production에서는 항상 무시됩니다. 비운영에서 세 값과 요청 header token을 모두 명시한 경우만 사용합니다.
- 운영 로그인은 Supabase Auth user와 같은 email의 활성 `role_assignments`가 모두 필요합니다.

### Vercel 배포

Vercel은 표준 `next build`와 Node.js Functions 런타임을 사용합니다. Auth/Storage용 Supabase API 설정과 별도로, PMS query/transaction은 serverless에 적합한 Supavisor transaction-mode `DATABASE_URL`을 사용합니다. `DIRECT_URL`은 Vercel runtime에 배포하지 않습니다.

```bash
vercel link
vercel env add SUPABASE_URL production
vercel env add SUPABASE_SECRET_KEY production --sensitive
vercel env add DATABASE_URL production --sensitive
vercel env add PMS_RATE_LIMIT_SECRET production --sensitive
vercel --prod
```

`.vercelignore`는 `.env*`, 로컬 빌드 결과, 작업 디렉터리와 Sites 설정이 Vercel source upload에 포함되지 않도록 차단합니다.

현재 `vercel.json`은 다음과 같이 동적 함수를 Seoul 한 리전에 배치합니다. Fluid Compute는 Vercel 프로젝트 기본 설정에서 활성화합니다.

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["icn1"]
}
```

정적 JS/CSS/이미지는 Vercel CDN에서 사용자와 가까운 POP으로 전달되고, Next.js Function은 `icn1`에서 실행됩니다. 한국 PMS 사용자의 snapshot cache hit와 인증 응답은 Seoul에서 끝나고, cache miss와 쓰기만 Supabase `ap-south-1` 데이터 플레인으로 전달됩니다. 응답 헤더의 `x-vercel-id`는 `접속 POP::함수 리전::request` 형태이므로 한국에서 `icn1::icn1::...`으로 확인할 수 있습니다.

### Toss Product Sans 로딩

`app/layout.tsx`가 Toss 공식 CDN에 preconnect한 뒤 `https://static.toss.im/tps/main.css`를 로드합니다. 이 stylesheet는 Regular 400과 Bold 700을 유니코드 범위별 WOFF2 subset으로 제공합니다.

`app/globals.css` 마지막의 `--aurora-font-product`와 `html,body,body *` 규칙이 과거 Georgia 숫자 스타일, 제목, KPI, 폼, 표, modal까지 모두 같은 제품 폰트로 통일합니다. CDN 요청이 실패하면 Apple/system/Pretendard/Noto Sans KR 순서로 fallback합니다.

### 마이그레이션

```bash
npm run db:supabase:migrate
npm run db:supabase:smoke
```

| 명령 | 역할 |
| --- | --- |
| `db:supabase:migrate` | migration history lock 후 미적용 migration 실행 |
| `db:supabase:smoke` | 테이블·트리거·RLS·pooler·RPC 부재·동시성 보호 검증 |
| `qa:staging:db` | 환경·QA opt-in·Supabase project ref가 모두 맞는 격리 스테이징에서만 PostgreSQL integration 실행 |

`generate-supabase-migration.mjs`처럼 기존 migration을 다시 생성하거나 덮어쓰는 명령은 존재하지 않습니다. 새 schema 변경은 새 번호의 SQL 파일로만 추가하고, CI가 빈 PostgreSQL에 전체 history를 재적용합니다.

native type 변환이나 CHECK 재검증처럼 lock·table rewrite 가능성이 있는 migration은 `docs/operations.md`의 점검 창 절차를 따릅니다. 데이터 수리 DML은 적용 전 영향 건수와 적용 후 audit 수를 반드시 기록하며, `IF NOT EXISTS`를 migration 재실행 허가로 해석하지 않습니다.

## 개발자 가이드

### 기술 스택

| 분류 | 기술 | 선택 이유 |
| --- | --- | --- |
| Web | Next.js 16 App Router, React 19, TypeScript 5.9 | SSR/route handler와 client 업무 UI를 한 코드베이스에서 운영 |
| Auth | Supabase Auth + `jose` remote JWKS verifier | Auth 서버를 매 요청 hot path에 두지 않고 asymmetric JWT를 검증하며 key rotation을 추적 |
| Style | 단일 `globals.css`, Tailwind PostCSS import, Talos Flow tokens | 외부 컴포넌트 런타임 없이 세밀한 B2B 화면 제어 |
| DB access | `postgres` + Supavisor transaction pooler | Vercel instance별 연결을 pooler로 수렴하고 server-side transaction 보장 |
| Schema | `supabase/migrations/` 단일 원본 | 운영 DDL과 테스트 DDL의 drift 및 이미 적용된 파일 덮어쓰기 제거 |
| Excel | `fflate` 기반 직접 Open XML writer | 무거운 `xlsx` runtime dependency 없이 실제 `.xlsx` 생성 |
| Cache | TanStack Query 5 + server read-model cache | command receipt의 invalidation key로 필요한 projection만 재조회 |
| Test | Node test runner + PostgreSQL 17 service + live staging workflow | 실제 migration, RLS, trigger, advisory lock과 E2E를 같은 계약으로 검증 |
| Hosting | Vercel Production Seoul `icn1` + Fluid Compute | 한국 사용자 locality, instance concurrency와 표준 Next.js runtime |

PMS 공통 shell은 workspace URL 사이에서 유지됩니다. 첫 화면은 `view=core`, 그룹·폴리오·채널은 각각 `view=groups|finance|channels`를 사용하며 메뉴 hover/focus/pointer intent 시 route chunk와 projection을 미리 준비합니다. 기본 전체 snapshot은 호환·QA 용도이며 일반 페이지 전환 hot path에는 사용하지 않습니다.

### npm 명령 전체 목록

| 명령 | 설명 | 외부 상태 변경 |
| --- | --- | --- |
| `npm run dev` | Next 개발 서버 | 없음 |
| `npm run build` | production bundle과 TypeScript 검증 | 없음 |
| `npm start` | 빌드 결과 실행 | 없음 |
| `npm run lint` | ESLint 전체 검사 | 없음 |
| `npm test` | production build 후 모든 Node test | 없음 |
| `npm run test:unit` | route·schema·보안 정책·UI 행동의 빠른 behavior test | 없음 |
| `npm run test:integration` | migrated PostgreSQL에서 RLS·RPC·rate limit·원장·동시성 검증 | 전용 test DB에 격리 fixture 생성 후 삭제 |
| `npm run test:ci` | lint → build → unit → PostgreSQL integration 순서의 전체 gate | 전용 test DB 필요 |
| `npm run benchmark` | 기본 Snapshot 30 warm-up + 300 요청 성능 gate | 읽기 요청 |
| `npm run qa:workflow` | 24 checkpoint end-to-end 업무 QA | staging proof 통과 후 QA 레코드 생성 |
| `npm run qa:booking` | 공개 조회·예약·동일 key replay·취소·재고 원복·same-origin 방어 E2E | staging proof 통과 후 취소 상태 QA 예약 생성 |
| `npm run qa:staff` | 관리자 직원 생성·최초 비밀번호 변경·페이지 조회/쓰기 차단·비활성화 전파 E2E | staging에서만 임시 계정 생성 후 비활성화 |
| `npm run db:supabase:migrate` | 미적용 SQL migration 실행 | DB schema 변경 |
| `npm run db:supabase:smoke` | Supabase 구조·RLS·pooler·RPC 부재·원장 검증 | rollback-only 검증 트랜잭션 |
| `npm run db:provision-role` | 명시 confirmation·property·email·role·display name으로 운영자 assignment와 역할 템플릿 provisioning | 지정 사용자 권한 변경 |
| `npm run db:test:bootstrap` | plain PostgreSQL에 CI용 Supabase role/storage 최소 표면 생성 | 전용 test DB만 변경 |

### 새 Command 추가 절차

1. `app/api/pms/action-registry.ts`에 action, 최소 capability, 도메인, Zod transport schema를 등록합니다.
2. 코어 예약·폴리오 action이면 `command-gateway.ts`, 재고·채널·회계·CMS action이면 해당 domain handler에 구현합니다.
3. Zod는 transport shape를, handler는 현재 재고·상태·version·금액 불변식을 검증합니다.
4. 업무 데이터 + audit + idempotency + 필요한 outbox를 하나의 `db.batch`에 넣습니다.
5. 재무·재고 불변식은 UI/TypeScript만이 아니라 migration의 constraint/trigger로도 추가합니다.
6. `scripts/qa-full-workflow.mjs`에 정상 경로와 대표 차단 경로를 추가합니다.
7. 순수 규칙은 unit behavior test에, constraint/trigger/RLS/경합은 `postgres-*.integration.mjs`에 추가합니다.
8. 이 README의 Action 표, 데이터 모델, QA 범위를 같이 갱신합니다.

### 새 Report 추가 절차

1. `app/api/pms/reporting.ts`의 `reportCatalog`에 key, label, group, description을 추가합니다.
2. 모든 사용자 입력은 bind parameter로 전달하고 property/date scope를 포함합니다.
3. count query와 rows query가 같은 filter를 사용하도록 작성합니다.
4. `columns`, `rows`, `summary`를 반환하고 개인정보 열의 마스킹 정책을 결정합니다.
5. `app/reports-center.tsx` fallback catalog와 상태 filter를 추가합니다.
6. CSV/XLSX export에서 숫자·통화·날짜 형식과 최대 25,000행을 확인합니다.
7. workflow QA의 표준 report 목록과 rendered test를 갱신합니다.

### 데이터베이스 adapter 계약

`PmsDatabase`는 다음 네 동작만 도메인 코드에 노출합니다.

```ts
interface PmsDatabase {
  prepare(query: string): PmsPreparedStatement;
  batch(statements: PmsPreparedStatement[]): Promise<PmsResult[]>;
  forProperty(propertyId: string): PmsDatabase;
}

interface PmsPreparedStatement {
  bind(...values: unknown[]): PmsPreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<PmsResult<T>>;
  run<T>(): Promise<PmsResult<T>>;
}
```

- adapter는 PostgreSQL만 지원하며 `?` placeholder를 quote/comment-aware lexer로 `$1...$n`에 변환합니다.
- PostgreSQL 경로는 Supavisor transaction pooler를 사용하고 `prepare:false`로 transaction-mode 제약을 지킵니다.
- `scopePmsDatabase()`는 property ID를 검증하고 매 statement/batch transaction에서 `SET LOCAL ROLE aurora_app`과 `set_config('app.property_id', ...)`를 설정합니다.
- tenant table을 root scope에서 조회하면 adapter가 거부합니다. 유일한 예외는 로그인 뒤 property assignment를 찾는 제한된 `role_assignments` query입니다.
- SQL text를 HTTP RPC에 전달하는 adapter를 다시 추가하지 않습니다.
- SQL 문자열 안의 작은따옴표·큰따옴표 내부 `?`는 placeholder로 변환하지 않습니다.
- prepared bind를 우회한 사용자 입력 문자열 연결은 금지합니다.

### 소스 주석 품질 기준

Talos PMS의 유지보수 대상은 `app`, `db`, `scripts`, `tests` 아래의 TypeScript, TSX, JavaScript, MJS 파일입니다. 파일 상단에는 책임을 설명하고, 보안 경계·트랜잭션·회계/재고 불변식처럼 코드만으로 의도가 불명확한 곳에는 “왜”를 기록합니다. 줄 수나 주석 개수를 품질 대리 지표로 강제하지 않습니다.

주석은 문법을 다시 읽어 주는 대신 다음 내용을 기록합니다.

- 테넌트/property scope, 권한 확인 순서, 서버 전용 credential 경계
- 예약·재고의 원자성, 초과 판매 방지, idempotency와 optimistic concurrency
- folio·AR·회계 journal의 append-only 및 reversal 불변조건
- 판매가·채널 판매가·입금가·수수료 계약의 계산 기준
- CMS 게시 여부와 PMS 내부 판매 가능 상태가 분리되는 이유
- 캐시 키의 범위, 쓰기 후 무효화 시점, 제한값의 운영상 근거
- UI에서 서버 데이터와 로컬 검색·draft state를 분리하는 이유
- QA fixture가 남는 범위, 예상 실패가 성공 조건인 checkpoint

반대로 변수명이나 `if` 조건을 그대로 번역한 주석, 현재 코드와 다른 미래 계획, 비밀키·토큰·고객 개인정보 예시는 남기지 않습니다. 핵심 동작을 바꾸는 커밋은 구현·행동 테스트·README와 함께 관련 주석도 갱신합니다.

### 코드 변경 원칙

- 기존 dirty worktree의 관련 없는 사용자 변경을 덮어쓰지 않습니다.
- 금액은 UI 표시 값이 아니라 원장 합계에서 계산합니다.
- 날짜는 호텔 영업일과 투숙일을 구분하고 API에서는 `YYYY-MM-DD`를 사용합니다.
- 확정 원장은 update/delete하지 않고 reversal action을 추가합니다.
- 외부 전달은 코어 transaction 안에서 직접 HTTP 호출하지 않고 outbox를 기록합니다.
- 새 UI 버튼은 `onClick`, submit contract 또는 의도된 disabled 상태 중 하나를 가져야 합니다.
- 긴 modal은 `100dvh` 안에서 body만 scroll하고 action bar는 sticky로 유지합니다.
- 기능 구현과 README 업데이트를 같은 commit/PR에 포함합니다.

## 테스트 및 Loop QA

### 빠른 검증

```bash
npm run lint
npm test
npm run test:integration
npm run db:supabase:smoke
```

`npm test`는 production build와 빠른 unit/behavior suite를 실행합니다. PostgreSQL integration suite는 `TEST_DATABASE_URL`이 있을 때 실행하며 CI에서는 `AURORA_REQUIRE_POSTGRES_TESTS=true`로 skip을 금지합니다.

현재 release gate는 unit/behavior suite와 실제 PostgreSQL integration suite로 구성되며 정확한 개수는 [자동 생성 지표](generated/project-metrics.md)가 관리합니다.

| Suite | 검증 내용 |
| --- | --- |
| `action-registry.test.mjs` | action registry의 capability/domain/Zod 계약과 안정된 오류 매핑 행동 |
| `database-adapter.test.mjs` | SQL literal·identifier·comment를 침범하지 않는 placeholder lexer와 bind mismatch 거부 |
| `application-behavior.test.mjs` | 13개 route round-trip, 작은 mutation receipt, production demo-auth 차단, proxy trust, staging QA hard gate, inert button 부재 |
| `postgres-core.integration.mjs` | 실제 migration의 booking table, 위험 RPC 0개, RLS 교차 접근 거부, 동시 rate limit, append-only folio, 마지막 1실 20건 경합 |
| `api-benchmark.mjs` | 동시성 30, 총 300 Snapshot, 실패 0, p95 250ms 미만 |

### GitHub Actions PR gate

`.github/workflows/ci.yml`은 `pull_request`와 `main` push에서 다음 순서를 강제합니다.

1. Node.js 24 locked dependency install (`npm ci`)
2. ESLint
3. Next.js production build와 TypeScript
4. unit/behavior tests
5. 격리 PostgreSQL 17 service에 Supabase 호환 role/storage bootstrap
6. 빈 DB를 `202607170009`까지 구축·seed한 뒤 현재 migration으로 업그레이드해 fresh install과 populated upgrade 경로를 함께 검증
7. `AURORA_REQUIRE_POSTGRES_TESTS=true` integration/concurrency tests

CI는 production 또는 staging Supabase secret을 사용하지 않습니다. 각 job의 임시 DB는 job 종료 시 폐기되므로 테스트 fixture가 운영 데이터에 남지 않습니다. GitHub 저장소 설정에서는 `Lint, build, behavior and PostgreSQL tests` check를 `main` 병합 필수 status check로 지정해야 합니다.

### 전체 더미데이터 Workflow QA

Stateful QA는 로컬 URL이라도 production Supabase에 연결될 수 있으므로 기본 실행을 허용하지 않습니다. 전용 Supabase staging 프로젝트와 staging Vercel deployment를 준비한 뒤, target health가 `environment=staging`, `qaAllowed=true`, 실제 `databaseProjectRef` 일치를 증명해야 합니다. migration release는 Vercel cloud build의 `release:staging`에서 대상 ref 확인 → `preflight-saas-migration.mjs` → migration 적용 → PostgreSQL integration → runtime contract/build 순서를 한 번에 실행합니다. 스크립트를 저장소 밖에서 호출할 때는 루트 운영 `.env.local`로 폴백하지 않아 잘못된 DB를 조용히 선택할 수 없습니다.

현재 격리 환경은 Vercel 프로젝트 `allmytour/aurora-pms-staging`의 공개 Production target과 Supabase Micro 프로젝트 `tkfcnkxxcsgslqfnoclg`를 결합합니다. URL은 [aurora-pms-staging.vercel.app](https://aurora-pms-staging.vercel.app)이며 `/api/health`가 `environment=staging`, `qaAllowed=true`, `databaseProjectRef=tkfcnkxxcsgslqfnoclg`를 반환합니다. Vercel target은 배포 보호 없는 실제 E2E를 위해 Production이지만 애플리케이션 환경은 명시적으로 staging입니다. `NODE_ENV=production`이므로 demo authentication은 `PMS_ALLOW_DEMO_AUTH=false`로 닫혀 있고, QA는 수동 provision된 `qa-staging@aurora.local` assignment와 확인된 Supabase Auth 사용자의 임시 비밀번호로만 로그인합니다. 비밀번호는 저장소·README·Vercel 환경 변수에 저장하지 않고 실행마다 회전합니다.

```bash
PMS_BASE_URL=https://<staging>.vercel.app \
PMS_QA_ENVIRONMENT=staging \
PMS_QA_CONFIRM=AURORA_STAGING_ONLY \
PMS_QA_PROJECT_REF=<staging-project-ref> \
PMS_TEST_EMAIL=<staging-user> \
PMS_TEST_PASSWORD='<temporary-secret>' \
npm run qa:workflow
```

동일한 네 가지 target proof 변수는 `qa:booking`, `qa:website`에도 필수입니다. 비밀번호는 파일에 기록하지 말고 현재 shell에만 전달합니다.

```bash
PMS_BASE_URL=https://<staging>.vercel.app PMS_QA_ENVIRONMENT=staging PMS_QA_CONFIRM=AURORA_STAGING_ONLY PMS_QA_PROJECT_REF=<staging-project-ref> npm run qa:booking
PMS_BASE_URL=https://<staging>.vercel.app PMS_QA_ENVIRONMENT=staging PMS_QA_CONFIRM=AURORA_STAGING_ONLY PMS_QA_PROJECT_REF=<staging-project-ref> npm run qa:website
```

> Production URL `aurora-pms-gilt.vercel.app`, production project ref `tnbxreeidezidckemflb`, staging opt-in이 없는 deployment, 선언 ref와 실제 pooler ref가 다른 target은 코드에서 즉시 거부합니다. 운영 DB 실행은 “권장하지 않음”이 아니라 불가능한 release invariant입니다.

2026-07-17 검증 결과:

아래 production workflow 기록은 hard gate 도입 전의 역사적 감사 기록이며 안전한 관행의 근거로 사용하지 않습니다. 현재 스크립트로 같은 production URL/DB에 재실행하면 사전 검사 단계에서 실패합니다.

| 환경 | 결과 |
| --- | --- |
| 격리 Vercel/Supabase staging | `qa:workflow` 24개 핵심 checkpoint; health ref proof·실제 Supabase Auth·중단 캐셔 조건부 복구 포함 |
| 로컬 Next.js + 격리 PostgreSQL | 24개 핵심 checkpoint와 필요 시 중단 캐셔 복구, `qa:public` SEO·CSS·검색 smoke |
| Vercel Seoul Production + 실제 Supabase | 배포마다 같은 workflow·booking·CMS gate를 새 run ID로 기록 |
| Node test suite | 28개 unit/behavior + 9개 PostgreSQL integration gate, production build·TypeScript 포함 |
| 홈페이지 CMS E2E | 공개 projection, visual settings 저장, hero 이미지 선택·원상 복원, 잘못된 날짜 400, WEB OFF 제외·복원, Storage upload/public read/delete 통과 |
| Supabase smoke | 51 tables, 29 application triggers(public schema), 79 validated FK, 51 RLS tables, 3개 공개 객실, Storage bucket·pooler 정상, 임의 SQL RPC 0 |
| 데이터 감사 | 26개 관계·재고·원장·상태 검사, violation 0 |
| Auth E2E | login 200, access/refresh HttpOnly·Secure·SameSite=Lax, `PROPERTY_ADMIN`, cross-property 401, logout 200 |
| 500객실 경쟁 | 동시 응답 200/409, 최종 500실, 부분 commit 0, replay header true, QA 객실 정리 완료 |
| 직접 예약 E2E | 실시간 조회, 예약 201, 동일 key 200, 취소 200, 중복 취소 200, 재고 원복 |
| 격리 홈페이지 CMS E2E | homepage 200, 게시 객실 3, 검색 offer 3, 잘못된 날짜 400, 설정 version 증가, WEB OFF 제외·복원, media lifecycle 통과 |
| 반응형 브라우저 QA | 1440px desktop·390px mobile, 가로 scroll 0, 홈페이지 검색 날짜 자동 보정, 공개 객실 3개, CMS 3개 탭·visual editor 3개 control group·hero picker·메뉴 3행·preview device 전환, 재고 WEB 노출 selector, 콘솔 오류 0 |
| PMS 헤드리스 UI 전수 QA | 13개 업무 화면 가로 overflow 0, 10개 업무 검색 영역 필터·초기화 정상, 17개 dialog/drawer 포커스·Escape·action bar 정상, 객실 타입 modal 860px→416px, 모바일 modal 최대 92dvh |
| 리포트 브라우저 QA | 11/11 서버 리포트 오류 0, 키워드 0건·초기화 복원, CSV `Talos_room_inventory_2026-07-16.csv`, XLSX `Talos_객실_마스터_2026-07-16.xlsx` 실제 다운로드 |
| Core benchmark | Vercel `icn1`, 200 requests, concurrency 10, 실패 0, 252.04 req/s, p50 36.13ms, p95 53.20ms, p99 96.01ms |
| Security | health 200, CSP/HSTS/DENY/nosniff, cross-origin write 403, production dependency vulnerability 0 |

### Loop QA 범위

기존 25개 운영 요구사항은 실행 스크립트에서 관련 업무를 묶어 24개의 checkpoint로 보고하며, 인증·대량 경쟁·보안·직접 예약은 별도 E2E와 invariant test에서 검증합니다.

1. 대시보드와 Snapshot 로딩
2. 리포트 11종 조회와 필터
3. CSV/XLSX export
4. 객실 타입 생성·수정·멱등 replay
5. 단일/대량 객실 생성과 수정
6. 하우스키핑 청소·점검 전환
7. 판매 한도·MLOS·CTA·요금
8. 회사·그룹 프로필
9. 블록·할당·rooming·pickup·cutoff
10. 캐셔 개시·마감
11. 예약 생성·수정·배정·체크인·룸 무브
12. 폴리오 창·라우팅·분할·반대전표·결제·환불
13. 체크아웃 후 housekeeping 생성
14. AR 이관·청구·수납·완납
15. 노쇼·취소·재고 복원
16. 채널 연결·매핑·ARI·NEW/MODIFY/CANCEL
17. Message ID 멱등·DLQ replay
18. Outbox 장애 주입·재전송
19. 야간 감사 blocker
20. 감사 로그 추적
21. 최대 730일 재고 조회와 타입·요일·기간 벌크 변경
22. 수수료/입금가 채널 계약과 날짜별 판매가·입금가
23. 채널 정산 발생·지급 완료와 판매가/비용/입금가 보존
24. 수기 복식전표·차대 균형·반대전표·원장 불변성
25. 회계 분개장과 채널 정산 리포트·XLSX export

### Loop Engineering 완료 조건

```text
기능 목록화
  → 정상 경로 실행
  → 오류/차단 경로 실행
  → 데이터베이스 결과 확인
  → 결함 수정
  → build/lint/unit/invariant/workflow 재실행
  → Git commit/push
  → 운영 배포
  → 배포 상태 확인
```

## 프로젝트 구조

```text
Aurora_PMS/
├─ .github/workflows/ci.yml     # PR lint/build/PostgreSQL behavior gate
├─ app/
│  ├─ (pms)/
│  │  ├─ _components/pms-shell.tsx # Shared shell, drawers and operational panels
│  │  └─ {overview..audit}/page.tsx # 13 bookmarkable workspace routes
│  ├─ api/auth/                 # Supabase login/logout session routes
│  ├─ api/booking/              # Public availability + reservation/cancellation
│  ├─ api/health/               # Database readiness probe
│  ├─ api/pms/
│  │  ├─ route.ts               # Thin GET/POST boundary
│  │  ├─ auth.ts                # Identity, assignment and capability principal
│  │  ├─ action-registry.ts     # 51 Zod-validated commands
│  │  ├─ command-gateway.ts     # Domain dispatch + mutation receipts
│  │  ├─ read-model.ts          # Core/full projections and read cache
│  │  ├─ error-map.ts           # Stable database error mapping
│  │  ├─ extended.ts            # Inventory/channel/accounting/CMS handlers
│  │  └─ reporting.ts           # 11 report queries
│  ├─ hotel/                    # Dynamic public site and direct booking UI
│  ├─ accounting-center.tsx     # Hotel accounting & P/L
│  ├─ channel-contracts.tsx     # Commission/net-rate contracts
│  ├─ homepage-manager.tsx      # Hotel content, room publish and media CMS
│  ├─ inventory-calendar.tsx    # 730-day rate/inventory calendar
│  ├─ pms-action-context.tsx    # Shared command execution context
│  ├─ pms-mutation.ts           # Small receipt + invalidation contract
│  ├─ pms-workspaces.ts         # Canonical route registry
│  ├─ query-provider.tsx        # TanStack Query client lifecycle
│  ├─ reports-center.tsx        # Report center
│  ├─ room-master.tsx           # Room master
│  ├─ supabase-session.ts       # Verified access/refresh cookie session
│  └─ xlsx-export.ts            # XLSX workbook writer
├─ db/
│  ├─ pms-database.ts           # PostgreSQL pool + transaction tenant context
│  └─ postgres-parameters.mjs   # Quote-aware positional parameter compiler
├─ scripts/
│  ├─ bootstrap-test-postgres.mjs # Plain PostgreSQL CI bootstrap
│  ├─ migrate-supabase.mjs       # Ordered immutable migration runner
│  ├─ qa-full-workflow.mjs       # Entire dummy workflow QA
│  ├─ qa-booking-engine.mjs      # Booking/cancel/idempotency E2E
│  ├─ qa-website-cms.mjs         # CMS/WEB OFF/Storage E2E
│  ├─ qa-target.mjs              # Production URL/ref hard gate
│  └─ smoke-supabase.mjs
├─ supabase/
│  ├─ migrations/
│  │  ├─ 202607160001_aurora_pms.sql ... 202607170009_remove_arbitrary_sql_rpc.sql
│  │  └─ 202607170010_tenant_context_rls.sql
│  └─ seed.sql
├─ tests/
│  ├─ action-registry.test.mjs
│  ├─ application-behavior.test.mjs
│  ├─ database-adapter.test.mjs
│  ├─ postgres-core.integration.mjs
│  └─ api-benchmark.mjs
├─ vercel.json                  # Vercel Function region icn1 + Fluid Compute
└─ .vercelignore                # secret/local artifact upload exclusion
```
### 직원 권한 개발 규칙

새 workspace를 추가할 때는 `PMS_WORKSPACES`, `WORKSPACE_LABELS`, 9개 `ROLE_ACCESS_TEMPLATES`, DB JSONB CHECK, 읽기 route guard, write capability map을 한 변경에서 모두 갱신합니다. UI 버튼 숨김은 권한 경계가 아니므로 action registry capability와 GET projection guard가 반드시 동반되어야 합니다. 기존 root role lookup의 선택 컬럼·조건을 임의로 확장하지 말고, tenant 내부 직원 목록과 변경은 항상 `scopePmsDatabase()`를 사용합니다.

직원 비밀번호를 fixture, README, 로그, mutation receipt에 기록하지 않습니다. QA 계정은 스테이징 Supabase에서만 생성하고 검증 직후 비활성화 또는 삭제합니다. 운영 계정 생성 E2E는 실제 사람의 명시적 요청 없이 수행하지 않습니다.
