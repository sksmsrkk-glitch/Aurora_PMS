# Aurora PMS 운영 가이드

## 운영 체크리스트

### 배포 전

- [ ] Vercel Production에 `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `PMS_RATE_LIMIT_SECRET` 존재
- [ ] Secret Key가 Git diff에 없음
- [ ] migration과 migration history 일치
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run db:supabase:smoke`
- [ ] 별도 project ref를 health에서 확인한 staging에서 `npm run qa:workflow`
- [ ] 같은 staging에서 `npm run qa:website`
- [ ] RLS와 browser role grant 재검증

### 테이블 재작성 마이그레이션 점검 창

native date/time·boolean·JSONB처럼 `ALTER COLUMN ... TYPE`으로 테이블을 다시 쓰는 변경은 일반 배포와 분리합니다. 다음 순서를 스테이징과 운영에서 동일하게 지킵니다.

1. 적용 대상과 현재 migration history를 확인하고, 동일 파일을 재실행하거나 수정하지 않습니다.
2. 데이터 수리 쿼리가 있으면 먼저 영향 건수를 읽기 전용 SQL로 기록합니다. 예약 날짜 변경이라면 최소한 아래 preflight를 실행합니다.

```sql
SELECT COUNT(*) AS invalid_stays
FROM reservations
WHERE departure_date <= arrival_date;
```

3. 쓰기 트래픽이 없는 점검 창을 확보하고 예약·체크인·원장 전기를 잠시 중지합니다.
4. Supabase PITR/backup 복구 지점을 확인한 뒤 migration을 순서대로 적용합니다.
5. `npm run db:contract:verify`, `npm run db:supabase:smoke`, 스테이징 `qa:workflow`를 통과한 뒤 애플리케이션을 배포합니다.
6. 긴 lock, dead tuple, API 5xx, 예약·room-night·원장 합계를 관찰하고 쓰기를 재개합니다.

2026-07-17 운영 점검 결과 `0011`~`0014`는 이미 적용되어 추가 테이블 재작성은 필요하지 않았습니다. `0013` 적용 이력에는 0박 예약 32건이 `NORMALIZE_ZERO_NIGHT_RESERVATION`으로 기록되어 있었고 모두 Direct 소스였습니다. 점검 시점의 `departure_date <= arrival_date` 잔존 건수는 0건입니다. 이 수치는 과거 수리 영향 감사 기록이며 fixture나 재적용 지시가 아닙니다.

### 매일 운영

- [ ] 도착 예정 미처리 건 확인
- [ ] 캐셔 세션 마감
- [ ] 실패 inbound/outbox/ARI 확인
- [ ] 판매 중지 객실 확인
- [ ] 야간 감사 blocker 해소
- [ ] 영업일 마감 실행

## 장애 대응 Runbook

### 1. API 전체 장애 또는 500 증가

1. Vercel deployment 상태와 최근 build log를 확인합니다.
2. `/api/health`의 `status`, `database`, `latencyMs`와 HTTP 200/503을 먼저 확인합니다. 응답에는 연결 문자열이나 DB 오류가 포함되지 않습니다.
3. `/api/pms` 응답 status, `x-vercel-id`, cold/warm latency와 응답의 `errorId`를 기록하고 같은 UUID를 Vercel server log에서 찾습니다.
4. Supabase Project Health와 Supavisor pooler 상태를 확인합니다.
5. `npm run db:supabase:smoke`로 pooler, RLS, trigger, 임의 SQL RPC 0개를 검증합니다.
6. Secret 환경 변수 이름이 `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `PMS_RATE_LIMIT_SECRET`와 정확히 일치하는지 확인합니다. 값 자체를 log에 출력하지 않습니다.
7. 최근 migration이 실패했다면 migration history와 실제 catalog를 비교하고 새 corrective migration을 작성합니다.
8. 애플리케이션 회귀라면 Vercel에서 직전 정상 deployment를 promote합니다. DB migration은 애플리케이션 rollback과 자동으로 되돌아가지 않습니다.

### 2. 재고 불일치 또는 예약 409

1. `reservation_type_nights`, `reservation_nights`, `block_inventory`, `block_pickup_nights`, `inventory_controls`를 같은 room type/date로 조회합니다.
2. 물리 판매 객실, 확정 예약, deduct hold, sell limit 공식을 다시 계산합니다.
3. `room type sold out`, `room type closed`, `reservation_type_night_uq`, `room_night_uq` 중 어떤 DB guard가 차단했는지 확인합니다.
4. 사용자에게 최신 Snapshot을 다시 읽게 하고 같은 expected version을 재사용하지 않습니다.
5. night row를 직접 삭제해 해결하지 않습니다. 예약 취소·일정 수정·block cutoff 같은 도메인 action을 사용합니다.

### 3. OTA inbound 또는 ARI 장애

1. `channel_connections.status`와 `channel_mappings.active`를 확인합니다.
2. inbound는 `message_id`, `external_reservation_id`, `revision`, `status`, `error_message`를 확인합니다.
3. mapping 오류를 수정한 뒤 `replay_channel_message`를 실행합니다.
4. ARI는 날짜·mapping별 최신 revision과 `integration_delivery_attempts`를 확인합니다.
5. outbox는 `PENDING`/`FAILED`, attempts, last error를 확인한 뒤 `dispatch_outbox_event`로 재전송합니다.
6. 이미 `ACKED`/`PUBLISHED`인 전달을 새 ID로 임의 재생성하지 않습니다.

### 3-A. 공개 부킹 검색·확정 장애

1. `/api/health`와 `/api/booking/availability`를 같은 날짜·인원으로 확인합니다.
2. 객실 타입의 물리 객실, `inventory_controls`, `reservation_type_nights`, deduct `block_inventory`를 같은 투숙일로 대조합니다.
3. `OFFER_CHANGED`/`SOLD_OUT` 409는 정상 경쟁 결과이므로 새 availability를 읽고 다시 선택하게 합니다.
4. 고객이 네트워크 오류 후 재시도했다면 같은 `Idempotency-Key`의 `booking_requests`와 연결 예약번호를 확인합니다. 새 예약을 임의 생성하지 않습니다.
5. 예약 당시 금액은 `reservation_rate_nights`로 확인하고 직접 update/delete하지 않습니다.
6. 온라인 취소가 차단되면 호텔 영업일, 도착일과 예약 상태가 `DUE_IN`인지 확인합니다.

### 3-B. 홈페이지 콘텐츠·이미지·노출 장애

1. `website_settings.published`, `room_type_website.published`, 객실 타입 `active`를 순서대로 확인합니다.
2. 특정 날짜만 검색에서 사라지면 `inventory_controls.closed`와 `website_closed`, CTA/CTD/MLOS를 같은 타입·날짜로 확인합니다.
3. 공개 가격은 `inventory_controls.price_override` 또는 `room_types.base_rate`이며 CMS에 별도 가격 복사본을 만들지 않습니다.
4. 이미지가 깨지면 `website_media.object_path/public_url/active`와 `storage.buckets.id='hotel-media'`, 실제 object 존재를 확인합니다.
5. 히어로가 예상 이미지와 다르면 `hero_media_id`가 같은 property의 활성 `HOTEL` media인지 확인하고, 없으면 `role='HERO'`, 첫 호텔 이미지 순서로 fallback됨을 확인합니다.
6. 메뉴가 사라지면 `navigation_json`이 세 고정 ID를 중복 없이 포함하고 최소 하나가 `enabled=true`인지 확인합니다. 임의 href는 저장할 수 없습니다.
7. Storage object만 직접 지우거나 DB metadata만 직접 삭제하지 말고 `delete_website_media` action을 사용합니다.
8. 편집 저장 `409`는 version 충돌이므로 `GET /api/pms?view=website`로 최신 값을 읽고 다시 편집합니다.
9. 변경 후 `npm run qa:website`로 visual settings, hero 선택·복원, 공개 HTML, availability, WEB OFF 복원과 이미지 lifecycle을 재검증합니다.

### 4. 폴리오·AR·회계 불일치

1. 예약별 folio entry를 kind 규칙으로 다시 합산합니다.
2. AR invoice는 `SUM(debit-credit)`, 회계 journal은 entry별 `SUM(debit)=SUM(credit)`를 확인합니다.
3. channel settlement는 `gross_sell_amount - channel_cost_amount = hotel_net_amount`를 확인합니다.
4. 확정 line을 update/delete하지 말고 reversal/refund action을 사용합니다.
5. 수수료 계약의 비용·미지급금과 입금가 계약의 판매가·입금가 차이를 혼동하지 않습니다.
6. cashier variance와 business date를 함께 확인합니다.

### 5. 야간 감사 차단

| Blocker | 조치 |
| --- | --- |
| `UNRESOLVED_ARRIVALS` | 도착 예약을 체크인·취소·노쇼 처리 |
| `OPEN_CASHIERS` | 각 cashier의 counted amount 입력 후 마감 |
| failed outbox/interface | 실패 원인 수정 후 재전송 또는 운영 승인 절차 수행 |
| 미전기 객실료 | audit preview 확인; 정상 audit 실행 시 일별 중복 없이 자동 전기 |

### 6. 성능 저하

1. cold start와 warm request를 구분합니다.
2. Vercel 응답의 function region이 `icn1`인지 확인합니다.
3. Snapshot 크기, gzip header, cache invalidation 빈도를 확인합니다.
4. 장기 inventory/accounting/report를 기본 Snapshot에서 요청하고 있지 않은지 확인합니다.
5. query plan과 복합 index 사용을 Supabase SQL editor에서 확인합니다.
6. `npm run benchmark`를 같은 데이터 크기와 동시성으로 다시 실행합니다.

### 감사·관찰 데이터

| 데이터 | 질문 |
| --- | --- |
| `audit_logs` | 누가 어떤 entity를 어떤 before/after로 변경했는가? |
| `reservation_transitions` | 예약 상태가 누가 언제 전이했는가? |
| `reservation_mutations` | 어떤 expected version으로 수정 경쟁이 있었는가? |
| `integration_delivery_attempts` | 외부 전달의 각 시도가 성공/실패했는가? |
| `outbox_events` | 코어 commit 이후 발행 대기·실패·완료 상태는 무엇인가? |
| `report_exports` | 누가 어떤 필터로 몇 행을 내보냈는가? |
| `cashier_sessions` | expected/count/variance와 마감자는 누구인가? |
| `night_audits` | 영업일 blocker와 마감 결과는 무엇인가? |

### 백업과 복구 원칙

- migration은 schema 재현 수단이며 예약·원장 business data의 backup이 아닙니다.
- Supabase의 자동 backup/PITR 활성 여부와 보존 기간은 프로젝트 요금제·Dashboard에서 별도로 확인해야 합니다.
- 운영 전 RPO/RTO를 정하고 restore rehearsal를 수행합니다.
- 위험 migration 전 logical backup 또는 PITR restore point를 확보합니다.
- append-only 원장 문제를 backup restore로 덮기 전에 reversal로 해결 가능한지 먼저 판단합니다.

## 프로덕션 전환 전 필수 작업

현재 URL은 기능 검증용 완성형 확장 버전입니다. 실제 호텔 고객·결제·법정 회계 데이터를 처리하기 전 다음 항목이 남아 있습니다.

### 인증과 조직

- [x] Production demo identity 비활성화
- [x] Supabase Auth login, token 검증, refreshable HttpOnly session 연결
- [x] email/role/property assignment와 capability 기반 서버 권한 적용
- [x] 할당되지 않은 property 접근 차단과 scoped query adapter 적용
- [x] 다중 직원 계정 생성·비활성화·임시 비밀번호·최초 변경 정책 구축
- [x] 페이지별 없음/조회/입력 권한, 별도 export 권한, 역할 변경 audit 구축
- [x] 운영 assignment를 Supabase Auth user ID + email 이중 일치로 고정하고 미연결 레거시 권한 행 차단
- [ ] 호텔별 최소 권한 정기 검토와 퇴사자 계정 회수 SLA 운영

### 개인정보·결제·보안

- [ ] 개인정보 처리방침, 보존·삭제 정책, 접근 기록 정책 확정
- [ ] 민감 필드 암호화/토큰화와 데이터 분류
- [ ] 실제 PG 연동 시 카드번호·CVV를 PMS에 저장하지 않는 hosted/tokenized payment flow 적용
- [ ] Secret rotation, Vercel/Supabase 접근자 MFA, incident response 확정
- [ ] service-role SQL RPC에 대한 정기 침투·권한 검토
- [ ] Toss Product Sans 상업 사용 조건과 사용 권한 확인

### 호텔 운영 설정

- [ ] 호텔별 timezone, currency, business date, 세금·봉사료·거래코드 구성 UI
- [ ] 객실 타입·객실·요금제·회사·채널 master data migration
- [ ] 취소·노쇼·보증·deposit 정책
- [ ] fiscal invoice, VAT, local tourism tax 요구사항
- [ ] 실제 채널 manager/OTA certification과 서명된 webhook
- [ ] 실제 ERP/GL mapping, batch export, 월 마감 대사

### 신뢰성·운영

- [x] 별도 staging Supabase/Vercel 프로젝트와 staging Auth 사용자 provisioning (`tkfcnkxxcsgslqfnoclg`, `aurora-pms-staging`)
- [x] stateful QA의 production URL/ref 차단과 staging health proof 강제
- [ ] 보안 gate 도입 전 production QA에서 생성된 과거 `QA-*` 레코드 보존·정리 정책 승인
- [ ] Supabase backup/PITR와 정기 restore rehearsal
- [ ] Vercel/Supabase monitoring, alert, error tracking, uptime check
- [ ] 대량 데이터·동시 사용자 capacity test와 목표 SLA
- [ ] outbox/background dispatcher를 수동 simulation에서 scheduler/queue worker로 전환
- [ ] migration rollback/corrective migration runbook 승인

### 현재 알려진 경계

- PMS API는 Supabase Auth assignment에서 property를 선택하고 adapter가 transaction마다 `aurora_app` 역할과 `app.property_id`를 설정합니다. RLS가 교차 tenant 읽기·쓰기를 DB에서 거부합니다. 현재 seed와 공개 부킹 사이트가 판매하는 실제 호텔은 `prop-seoul` 한 곳이며, 다중 호텔 UI selector는 아직 제공하지 않습니다.
- 공개 부킹 엔진은 결제사 키가 없어 현장 결제만 지원합니다. 초기 게시값은 `DLX`, `TWN`, `STE` 세 타입이지만 이후 판매 대상은 코드가 아니라 `room_type_website.published`로 관리합니다.
- 채널 전송 버튼은 실제 OTA 인증 endpoint가 아니라 ACK/FAILED를 검증하기 위한 sandbox delivery simulation입니다.
- 회계 모듈은 PMS operational subledger이며 국가별 법정 총계정원장이나 세무 신고 시스템을 대체하지 않습니다.
- in-memory cache는 Vercel instance 간 공유되지 않습니다. DB 무결성에는 영향을 주지 않지만 instance별 cold read 비용이 존재합니다.
- rate limit은 cache와 달리 `api_rate_limits`에 저장되어 Vercel instance 간 공유됩니다. production에서 counter DB를 사용할 수 없으면 login·booking·PMS write는 fail closed 합니다.
- 외부 Toss font CDN 장애 시 fallback 폰트로 표시됩니다.

## 구현 변경 이력

| Commit | 작업 |
| --- | --- |
| 2026-07-17 P2 platform hardening | 배포 schema gate, 닫힌 auth capability, native temporal types, Rate Plan/WEB-DIRECT, 실제 dashboard 비교, 호텔 SEO, CSS·README 모듈화 |
| 2026-07-17 structural debt remediation | migration 단일 원본, tenant RLS context, API registry/Zod 모듈화, 13개 실제 route와 action Context, mutation receipt/TanStack Query, PostgreSQL CI, 20-way last-room concurrency test |
| 2026-07-17 seven-finding security remediation | runtime/seed admin 제거, Host 기반 localhost 인증 제거, 금전 strict 멱등 receipt, 임의 SQL RPC 폐기와 pooler 전환, booking schema readiness, production QA hard gate, DB 분산 rate limit |
| 2026-07-17 isolated staging validation | 별도 Supabase Micro/Vercel 프로젝트, 실제 Auth QA 사용자, fresh migration/seed 교정, public trigger smoke, 나이트 오디트 pool 고착 제거, workflow·booking·CMS E2E 통과 |
| 2026-07-17 admin identity reset | Supabase Auth `pms@allmytour.com` 운영자 생성·확인, PROPERTY_ADMIN 할당, 기존 frontdesk 기본 할당 비활성화, local seed·fallback·QA·migration 동기화 |
| 2026-07-17 source comment audit | 전체 유지보수 소스 주석 재감사, PMS API·직접 예약·DB adapter·재고·회계·채널 계약·인증·migration·workflow QA의 설계 이유와 불변조건 보강, 대형 파일 주석 품질 자동 gate 및 문서화 기준 추가 |
| 2026-07-17 search & overlay audit | 13개 PMS 화면 헤드리스 재검증, 공용 목록 검색·빈 상태·결과 건수, 리포트 초기화, 중첩 dialog 포커스 복원, sticky action bar, 객실 modal 높이 충돌 제거, 모바일 390px QA, 개발 CSP 보정 |
| 2026-07-17 website CMS release | 호텔/객실 소개 CMS, Supabase Storage 이미지, 객실 게시·정렬·편의시설, 재고 WEB OFF, 날짜 검색 보정, 모바일 UI, CMS/Storage E2E와 전체 코드 주석 감사 |
| 2026-07-17 release | Supabase Auth/RBAC/property scope, 74 FK, 회계 경쟁 guard, 500객실 원자 batch, core 성능, 보안·health, 호텔 홈페이지·직접 예약 엔진, 확장 QA 문서 |
| `aac1007` | Toss 공식 CDN stylesheet 연결, 모든 요소의 Product Sans 강제 통일, font delivery 회귀 테스트 |
| `c9989a9` | Vercel Node Functions를 Supabase에 가까운 `bom1` 리전으로 이동 |
| `56d7202` | 730일 재고 캘린더, 채널 수수료/입금가 계약, 정산, 호텔 회계·손익, 신규 리포트, room modal UX |
| `af50684` | 표준 Next.js 16 Vercel Production 배포와 환경 설정 |
| `377816c` | 전체 PMS workflow QA, Aurora Flow UI, README/운영 문서 1차 확장 |

릴리스 변경은 `main` 브랜치에 커밋하고 GitHub origin으로 push한 뒤 연결된 Vercel Production 프로젝트에 배포합니다. 배포 전후에는 같은 Supabase smoke, workflow, health, auth, booking 검증을 반복합니다.

## 라이선스 및 브랜드 고지

Aurora PMS는 독립 프로젝트입니다. Toss, Toss Design System, OPERA PMS 또는 기타 언급된 제품과 제휴하거나 그 공식 제품임을 의미하지 않습니다. 공개된 UX 원칙과 업계 운영 패턴을 참고했으며, 타사 로고·전용 컴포넌트 코드·비공개 자산은 포함하지 않습니다. `Toss Product Sans` 파일은 저장소나 배포 번들에 복제하지 않고 Toss 공식 CDN 스타일시트를 런타임에 참조합니다. 실제 상업 운영 전에는 해당 외부 폰트의 최신 사용 조건과 사용 권한을 별도로 확인해야 합니다.
