# Talos PMS 보안과 데이터 계약

## 권한과 보안

### 역할

| 역할 | 핵심 권한 |
| --- | --- |
| `PROPERTY_ADMIN` | 전체 운영, 재고, 그룹, 정산, 회계, 연동, 리포트, 마스터 |
| `NIGHT_AUDITOR` | 폴리오, AR, 캐셔, 야간 마감, 리포트 |
| `FRONT_DESK` | 예약, 체크인/아웃, 폴리오, 캐셔, 그룹 픽업 |
| `CASHIER` | 폴리오, AR, 캐셔, 리포트 |
| `HOUSEKEEPING` | 객실 조회, 청소·점검 상태 변경 |
| `REVENUE_MANAGER` | 재고·요금, 그룹, 채널, 리포트 |
| `SALES_MANAGER` | 예약, 그룹·블록·픽업, 리포트 |
| `ACCOUNTANT` | 폴리오, AR, 호텔 회계·손익, 채널 정산, 리포트 |
| `VIEWER` | 읽기 전용 |

### Capability

`READ`, `RESERVATION_WRITE`, `STAY_WRITE`, `FOLIO_WRITE`, `AR_WRITE`, `HOUSEKEEPING_WRITE`, `CASHIER_WRITE`, `EOD_RUN`, `INVENTORY_WRITE`, `GROUP_WRITE`, `GROUP_PICKUP`, `INTEGRATION_WRITE`, `ACCOUNTING_WRITE`, `REPORT_EXPORT`, `ADMIN`

### 보안 계층

1. Vercel Production HTTPS와 암호화 환경 변수
2. Supabase Auth password login과 ES256/RS256 access token의 JWKS 서명·issuer·audience·만료 검증; legacy HS256 또는 JWKS 장애 시 `/auth/v1/user` 검증 fallback
3. 만료 access token은 server-side refresh token 교환으로 갱신
4. access/refresh token은 JavaScript가 읽을 수 없는 `HttpOnly`, Production `Secure`, `SameSite=Lax` cookie에만 저장
5. `role_assignments`의 활성 email/property/role을 서버에서 조회하고 capability를 매 요청에 적용
6. 사용자가 선택한 `x-aurora-property-id`는 실제 assignment에 포함된 경우에만 허용
7. scoped database adapter가 각 transaction에서 `SET LOCAL ROLE aurora_app`과 `app.property_id`를 설정하고 RLS가 property 범위를 강제
8. 모든 PMS 쓰기 요청의 same-origin, action capability, 입력·상태 전이와 `Idempotency-Key` 검증
9. 로그인·공개 부킹·`POST /api/pms`의 HMAC 주소/사용자 기반 DB 원자 rate limit, same-origin write, 16KB payload limit, server-side 가격 재계산
10. Supabase RLS 활성화, `anon`/`authenticated` table 권한 제거, 임의 SQL `SECURITY DEFINER` RPC 미존재
11. CSP, HSTS, frame deny, nosniff, strict referrer, permissions policy, COOP 보안 헤더
12. 미분류 서버 오류는 UUID 오류 ID만 응답하고 원인은 server log에 남기는 오류 마스킹
13. 감사 로그, reservation mutation/transition, immutable 원장, transactional outbox
14. 카드 원문·CVV 미수집·미저장; 카드 참조는 모든 비숫자 구분자를 제외한 숫자가 12자리 이상이면 앱과 DB에서 거부
15. 데이터 임포트는 kind별 단일 capability 정책과 검증된 Supabase identity·MFA 추가 인증을 공통 강제
16. 외부 플랫폼·임포트 API의 미분류 예외는 UUID 오류 ID만 공개하고 SQL·driver 원문은 서버 로그로 제한
17. CMS 이미지 URL은 quoted CSS serializer로 괄호·따옴표·제어문자를 percent-encode한 뒤에만 `background-image`에 사용
18. 채널 연결·매핑을 포함한 모든 PMS mutation은 도메인 변경과 멱등 영수증을 같은 transaction에서 commit

Demo fallback은 Host/localhost 여부를 전혀 보지 않습니다. `NODE_ENV !== production`, `PMS_ALLOW_DEMO_AUTH=true`, 32자 이상 `PMS_DEMO_AUTH_TOKEN`, 같은 값의 `x-aurora-demo-token`, `PMS_DEMO_USER_EMAIL`, 그리고 해당 이메일의 수동 `role_assignments`가 모두 있어야만 성립합니다. 런타임 초기화와 seed는 어떤 관리자 역할도 생성하지 않습니다.

`SUPABASE_SECRET_KEY`, `DATABASE_URL`, `DIRECT_URL`은 Git에 커밋하지 않습니다. 로컬 `.env.local` 또는 배포 플랫폼의 암호화 환경 변수에만 저장합니다.

## 데이터 모델

운영 스키마 선언 수는 [자동 생성 프로젝트 지표](generated/project-metrics.md)가 집계합니다. 아래 도메인 카탈로그의 관계는 migration과 배포 계약에서 validated 상태를 검증합니다.

| 도메인 | 테이블 |
| --- | --- |
| 프로퍼티·권한 | `properties`, `role_assignments` |
| 객실·재고·판매상품 | `room_types`, `rooms`, `inventory_controls`, `housekeeping_tasks`, `rate_plans`, `rate_plan_room_types`, `rate_plan_calendar`, `rate_plan_occupancy` |
| 예약·투숙 | `guests`, `reservations`, `reservation_nights`, `reservation_type_nights`, `reservation_transitions`, `reservation_mutations`, `room_moves` |
| 그룹·세일즈 | `account_profiles`, `business_blocks`, `block_inventory`, `rooming_list_entries`, `block_pickup_nights` |
| 폴리오 | `folio_windows`, `folio_entries`, `folio_entry_details`, `folio_routing_rules`, `transaction_codes` |
| AR·캐셔·EOD | `ar_accounts`, `ar_invoices`, `ar_ledger_entries`, `cashier_sessions`, `night_audits` |
| 채널·전달 | `channel_connections`, `channel_mappings`, `channel_contracts`, `channel_rate_overrides`, `channel_settlements`, `ari_updates`, `channel_reservation_links`, `inbound_channel_messages`, `integration_delivery_attempts`, `outbox_events` |
| 회계·손익 | `accounting_accounts`, `accounting_journal_entries`, `accounting_journal_lines` |
| 직접 예약 | `booking_requests`, `reservation_rate_nights` |
| 홈페이지 CMS | `website_settings`, `room_type_website`, `website_media` |
| 감사·운영 | `audit_logs`, `idempotency_keys`, `api_rate_limits`, `report_exports`, `pms_schema_migrations` |

### 주요 불변식

- 프로퍼티별 객실번호 유일
- 프로퍼티별 객실 타입 코드 유일
- 객실별 날짜 예약 유일
- 예약별 타입·날짜 유일
- 연결별 Message ID 유일
- 연결별 외부 예약 ID 유일
- 예약별 폴리오 창 번호 유일
- 예약·거래 코드별 활성 라우팅 유일
- 영업일별 야간 감사 유일
- 폴리오와 AR 원장 핵심 열 수정·삭제 금지
- 회계 journal line 수정·삭제 금지, header는 반대 상태 전이만 허용
- 회계 전표 차변·대변 합계 일치
- 채널·예약별 정산 유일성과 `판매가 - 채널 비용 = 호텔 입금가`
- 채널 입금가는 채널 판매가 이하
- 블록 current 수량은 picked-up 수량 아래로 감소 금지
- 활성 재고를 초과하는 예약·블록 생성 금지
- 같은 원전표의 반대 회계 전표는 한 번만 생성
- 같은 정산 source의 회계 전표는 한 번만 생성
- 직접 예약 요청 key와 연결된 예약은 프로퍼티별 유일
- 예약·투숙일별 판매가 snapshot은 수정·삭제 금지
- 홈페이지 설정과 객실 콘텐츠는 property/type별 하나이며 version으로 동시 편집 충돌 차단
- `ROOM_TYPE` 이미지는 유효한 property·객실 타입에만 연결하고 `HOTEL` 이미지는 타입 ID를 갖지 않음
- 홈페이지 게시 타입과 일자별 `website_closed=false` 조건을 모두 만족해야 직접 예약 offer에 포함

## 마이그레이션 카탈로그

마이그레이션은 파일명 순서대로 한 번만 적용되며 `pms_schema_migrations`에 기록됩니다. 적용 기록 테이블 자체도 RLS와 revoke로 보호합니다.

| Migration | 책임 | 주요 산출물 |
| --- | --- | --- |
| `202607160001_aurora_pms.sql` | PMS 코어 스키마 | 예약, 객실, 재고, 그룹, 폴리오, AR, 채널, 감사, 리포트 39개 테이블과 기본 인덱스·트리거 |
| `202607160002_pms_data_api.sql` | 과거 HTTPS SQL adapter | 과거 RPC 생성 이력; 현재는 `202607170009`에서 전부 삭제됨 |
| `202607160003_lock_migration_history.sql` | migration 기록 보호 | `pms_schema_migrations` RLS, `anon`/`authenticated` revoke |
| `202607160004_channel_revenue_accounting.sql` | 채널 수익·호텔 회계 | 계약, 날짜별 채널 요금, 정산, 계정과목, journal header/line 6개 테이블과 불변 원장 트리거 |
| `202607160005_settlement_contract_snapshot.sql` | 역사적 정산 조건 고정 | `contract_type`, `commission_percent` snapshot과 열린 정산이 있는 계약 변경 guard |
| `202607170001_relational_integrity.sql` | 관계 무결성·회계 경쟁 보호 | property/id composite key, 70개 validated FK, 반대전표·source journal unique index |
| `202607170002_large_atomic_batch.sql` | 과거 RPC batch 확장 | 과거 600 statement 상한 이력; 현재 원자 batch는 PostgreSQL transaction이 담당 |
| `202607170003_booking_engine.sql` | PMS 직접 예약 | `booking_requests`, immutable `reservation_rate_nights`, 4개 validated FK, RLS/revoke |
| `202607170004_website_cms.sql` | 호텔 홈페이지 CMS | `website_settings`, `room_type_website`, `website_media`, `website_closed`, Storage `hotel-media` bucket, 5개 FK, RLS/revoke와 초기 콘텐츠 |
| `202607170005_website_seed_visibility.sql` | 공개 객실 초기화 | 운영 3개 타입만 초기 게시하고 신규·QA 타입은 관리자 검토 후 게시하도록 분리 |
| `202607170006_default_admin_identity.sql` | 과거 관리자 migration 호환 마커 | 기존 적용 ID는 유지하되 fresh install에서도 역할을 생성하지 않음; 현재 역할은 operator가 별도 provisioning |
| `202607170007_remove_seed_admin.sql` | 관리자 backdoor 제거 | 역사적 seed ID만 삭제; 이후 runtime·seed 자동 관리자 생성 금지 |
| `202607170008_distributed_rate_limits.sql` | serverless 공유 rate limit | `api_rate_limits` 원자 counter, expiry index, RLS/revoke |
| `202607170009_remove_arbitrary_sql_rpc.sql` | 임의 SQL RPC 폐기 | service role 포함 전 권한 revoke 후 `pms_execute`, `pms_batch`, helper function 삭제 |
| `202607170010_tenant_context_rls.sql` | DB 강제 테넌트 격리 | `aurora_app` NOBYPASSRLS 역할, transaction-local `app.property_id`, 49개 tenant table RLS policy, property별 idempotency composite PK |
| `202607170011_native_temporal_types.sql` | 날짜·시각 native type | 28+ date, 66+ timestamptz, time 컬럼 전환, date 기반 inventory lock·pickup trigger |
| `202607170012_rate_plan_domain.sql` | 정규화 Rate Plan | 요금제·객실 매핑·일자별 요금 3개 테이블, 예약·채널 rate code FK, 3개 RLS policy와 직판 기본값 |
| `202607170013_native_flags_json_constraints.sql` | native flag·payload·예약 제약 | 24개 flag boolean, 12개 JSONB payload, JSON shape와 양수 숙박일·인원·요금·상태 제약 |
| `202607170014_website_visual_editor.sql` | 홈페이지 비주얼 편집 | hero media/layout/overlay/height/CTA, theme accent, 고정 3섹션 navigation JSONB와 DB CHECK |
| `202607180015_staff_access_control.sql` | 호텔별 직원 계정·세부 권한 | Auth UUID 연계, 14개 workspace 권한, export·비밀번호·version·감사 |
| `202607190016_multihotel_saas_control_plane.sql` | 멀티호텔 SaaS | 조직·도메인·구독·entitlement·JIT support·이관·worker·백업·incident·usage와 14개 추가 RLS policy |
| `202607200017_worker_delivery_recovery.sql` | 외부 전달 복구 | worker attempt cycle, 자동 복구 상한·회수 시각, stale/dead partial index와 불변 시도 원장 unique key |
| `202607200018_exhausted_worker_retry_recovery.sql` | 고갈 RETRY 복구 | DEAD 소스 재큐잉으로 생긴 `RETRY + attempts=max`를 동일한 제한형 복구 scan에 포함 |
| `202607200019_worker_enqueue_revival_guards.sql` | enqueue 상태 전이 보호 | DEAD 재큐잉은 attempts·last_error를 초기화하고 attempt cycle을 증가, RUNNING 재큐잉은 lease·상태·시도 횟수를 보존 |
| `202607210020_rate_product_catalog.sql` | HotelStory 판매 상품 | 부모 상품 상속, 식사·패키지·판매기간, 인원별 추가요금과 예약 상품 snapshot |
| `202607210021_reservation_operational_detail.sql` | 예약 운영 상세 | 예약자/투숙자, 요청·메모·시간 옵션, PCI-safe reference, 취소정책 snapshot과 인라인 로그 |
| `202607210022_reservation_voucher_delivery.sql` | 예약 바우처 | immutable KR/EN 문서 payload와 멱등 `VOUCHER_EMAIL` worker delivery |
| `202607210023_channel_rateblock_operational_catalogs.sql` | 채널·블럭요금·운영 카탈로그 | 7개 FORCE RLS tenant table, 채널 상품/마감, 4축 요금제약과 객실 초과 할당 trigger |
| `202607210024_hotelstory_reporting_deposits.sql` | HotelStory 리포트 입금 원장 | 채널 입금 projection, append-only RECEIPT/RESTORE, 회계 FK, 동시 입금 row-lock guard와 FORCE RLS |
| `202607210025_hotelstory_final_operations.sql` | HotelStory 최종 운영 묶음 | 연회장·연회예약·호텔/웹 회원, native date/time/jsonb/numeric, 시간 중복 advisory trigger, 3개 FORCE RLS policy |

### 핵심 PostgreSQL 함수와 트리거

| 이름 | 역할 |
| --- | --- |
| `pms_lock_inventory` | 프로퍼티·객실타입·투숙일 단위 advisory lock 획득 |
| `pms_reservation_capacity_guard` | 예약 타입박 insert 시 예약+deduct block 사용량이 판매 재고를 넘는지 확인 |
| `pms_block_inventory_guard` | block original/current/picked-up 수량과 하우스 capacity 검증 |
| `pms_block_pickup_guard` | rooming entry 픽업 가능 수량과 날짜 검증 |
| `pms_block_pickup_apply` | pickup insert/delete에 따라 block `picked_up`을 증감 |
| `pms_inventory_control_guard` | sell limit을 기존 확정 예약 아래로 내리는 변경 차단 |
| `pms_immutable_guard` | 폴리오·AR·전달 시도·회계 line의 update/delete 거부 |
| `pms_accounting_line_guard` | debit/credit 한쪽만 양수인지, 활성 계정인지 검증 |
| `aurora_enforce_room_limit` | subscription row lock으로 병렬 객실 생성의 plan 한도 초과 거부 |
| `aurora_enforce_user_limit` | subscription row lock으로 병렬 활성 사용자 한도 초과 거부 |
| `aurora_enqueue_outbox_job` / `aurora_enqueue_ari_job` | 코어 commit과 같은 transaction에서 durable worker job 생성 |
| `pms_accounting_header_guard` | journal header는 `POSTED → REVERSED` 이외 변경을 거부 |
| `pms_channel_settlement_contract_snapshot` | 정산 insert 시 계약 유형·수수료율을 복사 |
| `pms_channel_contract_open_settlement_guard` | `ACCRUED` 정산이 있으면 계약 유형·수수료율 변경 차단 |
| `pms_channel_deposit_event_guard` | 현재 settlement/payment journal과 입금·복구 사건을 행 잠금 아래 대조해 동시 중복 회계 처리 차단 |
| `pms_booking_rate_immutable_guard` | 예약 당시 투숙일별 판매가 snapshot의 update/delete 거부 |

### 마이그레이션 작성 규칙

1. 이미 배포된 migration 파일은 수정하지 않고 새 번호의 additive migration을 추가합니다.
2. 테이블 생성과 함께 조회 패턴에 필요한 index, RLS, revoke, trigger를 같은 migration에서 정의합니다.
3. destructive DDL은 사전 backup, staging 검증, 명시적 운영 승인 없이 실행하지 않습니다.
4. 새 테이블은 `property_id`를 포함하고 `202607170010`의 tenant table policy 목록과 grants에 추가합니다.
5. 원장·감사 테이블에는 delete cascade를 사용하지 않습니다.
6. migration 후 `npm run db:supabase:smoke`로 table/trigger/RLS, pooled runtime 연결, 임의 SQL RPC 0개를 다시 검증합니다.

### 검색 개인정보와 cursor 경계

- 검색 cursor는 HMAC-SHA256 v2 서명을 사용하고 normalized query와 property는 24자리 SHA-256 fingerprint로만 포함합니다. 다른 검색어·도메인·호텔에서 재사용하거나 payload를 바꾸면 무효입니다.
- 운영에서 `SEARCH_CURSOR_SECRET` 또는 `AUTH_SECRET`이 32자 미만이면 cursor 발급을 거부합니다. 로컬 전용 fallback key는 production에서 사용할 수 없습니다.
- `pms_search_quality_daily`에는 원문, 원문 hash, 사용자 ID, entity ID가 없습니다. query 길이·문자군·교정·결과·지연의 coarse bucket과 횟수만 tenant RLS 아래 원자 집계합니다.
- 검색 품질 리포트도 위 일별 집계만 반환합니다. 별칭 개선을 위해 고객 검색어 원문을 새 로그에 추가하지 않습니다.

## API 계약

### Snapshot

```http
GET /api/pms
```

응답은 현재 사용자의 권한을 반영한 `property`, `reservations`, `rooms`, `metrics`, `controls`, `inventory`, `groups`, `finance`, `integrations`를 포함합니다.

장기 캘린더와 회계처럼 기간에 따라 응답량이 크게 달라지는 화면은 전용 조회를 사용합니다.

```http
GET /api/pms?view=inventory&from=2026-07-16&to=2027-07-15
GET /api/pms?view=accounting&from=2026-07-01&to=2026-07-31
GET /api/pms?view=report&report=channel_settlements&from=2026-07-01&to=2026-07-31
GET /api/pms?view=report&report=channel_deposits&from=2026-07-01&to=2026-07-31&status=ACCRUED&scope=EXCLUDE_ONSITE
```

### Command

```http
POST /api/pms
Content-Type: application/json
Idempotency-Key: <unique-key>

{
  "action": "create_reservation",
  "firstName": "Talos",
  "lastName": "Guest"
}
```

성공하면 전체 snapshot 대신 아래와 같은 작은 mutation receipt를 반환합니다. `entity`는 payload에서 식별 가능한 변경 대상을 가리키며, 생성처럼 서버에서 ID를 만든 작업은 `null`일 수 있습니다. 리포트 export는 조회 결과 자체가 산출물이므로 예외적으로 리포트 데이터와 `exportId`를 반환합니다.

```json
{
  "ok": true,
  "mutation": {
    "id": "retry-001",
    "action": "edit_reservation",
    "domain": "reservation",
    "replayed": false,
    "entity": { "type": "reservation", "id": "reservation-42" }
  },
  "invalidates": ["core", "full", "reservations", "inventory"]
}
```

### 쓰기 Action

| 도메인 | Action |
| --- | --- |
| 예약 | `create_reservation`, `edit_reservation`, `assign_room`, `move_room`, `cancel_reservation`, `mark_no_show`, `check_in`, `check_out` |
| 객실·재고 | `create_room_type`, `update_room_type`, `create_room`, `bulk_create_rooms`, `update_room`, `update_inventory_control`, `bulk_update_inventory_controls`, `housekeeping` |
| 그룹 | `create_account_profile`, `create_business_block`, `update_block_inventory`, `add_rooming_entry`, `pickup_rooming_entry`, `cutoff_block` |
| 폴리오 | `post_charge`, `post_payment`, `create_folio_window`, `create_routing_rule`, `split_folio_entry`, `reverse_folio_entry`, `refund_payment` |
| AR | `transfer_to_ar`, `post_ar_payment` |
| 채널 | `create_channel_connection`, `create_channel_mapping`, `upsert_channel_contract`, `queue_ari_delta`, `dispatch_ari_update`, `ingest_channel_message`, `replay_channel_message`, `dispatch_outbox_event` |
| 회계·정산 | `post_accounting_entry`, `reverse_accounting_entry`, `accrue_channel_settlement`, `mark_channel_settlement_paid`, `restore_channel_settlement_payment` |
| 홈페이지 CMS | `update_website_settings`, `update_room_type_website`, `upload_website_media`, `delete_website_media` |
| 영업일 | `open_cashier`, `close_cashier`, `run_night_audit` |
| 리포트 | `export_report` |

### 대표 상태 코드

| 코드 | 의미 |
| --- | --- |
| `200` | 처리 완료 또는 멱등 replay |
| `400` | 입력 형식·범위·지원 Action 오류 |
| `401` | 로그인 사용자 정보 없음 |
| `403` | 역할에 필요한 capability 없음 |
| `409` | 재고, 상태 전이, version, 캐셔, 원장 조건 충돌 |
| `413` | 리포트 export 최대 행 또는 벌크 재고 5,000셀 초과 |
