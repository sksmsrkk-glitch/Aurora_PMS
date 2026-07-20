# Talos PMS API·성능·UI

## API 상세 개발 명세

### 인증·권한 해석 순서

1. `Authorization: Bearer` 또는 `aurora-pms-access` cookie의 access token header를 읽습니다. ES256/RS256이면 Supabase JWKS로 서명·`iss`·`aud=authenticated`·`exp`를 서버에서 검증하고, legacy HS256 또는 JWKS 장애일 때만 `/auth/v1/user`로 검증합니다.
2. access token이 만료됐고 bearer 요청이 아니라면 HttpOnly refresh cookie로 새 session을 발급하고 두 cookie를 rotation합니다.
3. Production에서는 검증된 Supabase identity가 없으면 `401`입니다.
4. localhost·127.0.0.1·Host header는 인증 근거로 사용하지 않습니다.
5. Production이 아닌 환경에서만 `PMS_ALLOW_DEMO_AUTH=true`, `PMS_DEMO_USER_EMAIL`, 32자 이상 `PMS_DEMO_AUTH_TOKEN`, 일치하는 `x-aurora-demo-token`이 함께 있을 때 explicit demo identity 검증을 시도합니다.
6. `role_assignments`에서 해당 email의 활성 property/role을 조회합니다. `x-aurora-property-id`가 있으면 assignment에 포함된 property인지 확인합니다.
7. access token identity는 30초, 역할/property/페이지 권한 assignment는 최대 5초 cache하며 키는 token hash 또는 `email + requested property`로 격리합니다. 권한 변경을 처리한 인스턴스는 대상 사용자 cache를 즉시 제거하고, 다른 Vercel instance도 5초 안에 새 assignment를 조회합니다. 같은 instance의 동시 검증은 하나의 in-flight Promise로 병합합니다.
8. action에 연결된 capability가 없거나 사용자에게 capability가 없으면 `403`입니다.
9. 검증된 property ID만 scoped database adapter에 전달되며 `[A-Za-z0-9_-]{1,64}` 형식을 벗어나면 실행하지 않습니다.

### GET query parameter

| View | 필수/선택 parameter | 반환 |
| --- | --- | --- |
| `core` | 없음 | 초기 shell용 property, principal, 핵심 metrics·controls·reservations·rooms·14일 inventory |
| 기본 | 없음 | `property`, `principal`, `metrics`, `controls`, `reservations`, `rooms`, `inventory`, `groups`, `finance`, `integrations` |
| `inventory` | `from`, `to` (`YYYY-MM-DD`, 최대 730일) | dates, room types, physical/reserved/held/available, inventory controls, mappings, contracts, channel rate overrides |
| `accounting` | `from`, `to` (최대 367일) | accounts, journals, lines, settlements, contracts, eligible reservations, P/L summary |
| `website` | 없음 | 홈페이지 설정, 전체 객실 타입별 CMS 게시 상태·설명·편의시설, 미디어 metadata |
| `report` | `report`, `from`, `to`, `q`, `status`, `source`, `roomTypeId`, `page`, `pageSize` | catalog, definition, filters, columns, rows, summary, pagination, export policy |

### Command 공통 규칙

- Content type은 `application/json`입니다.
- 현재 UI 호환을 위해 action payload의 많은 값은 문자열로 전송하며 서버가 숫자·boolean·JSON 배열을 명시적으로 파싱합니다.
- 모든 PMS 변경 명령은 고유한 `Idempotency-Key`를 반드시 보냅니다. 형식은 영문·숫자와 `:._-`, 최대 200자입니다.
- 중복 키가 확인되면 같은 업무를 다시 실행하지 않고 `X-Idempotent-Replay: true`, `mutation.replayed=true`인 동일 형태 receipt를 반환합니다.
- DB commit이 끝나면 server read cache를 비우고 receipt의 `invalidates`로 client query key를 stale 처리합니다.
- 상태 충돌은 정상적인 업무 결과이므로 `409`로 처리하고 UI가 관련 projection을 다시 읽도록 합니다.

### Action 입력 계약 요약

| Action | 주요 payload | 핵심 서버 검증 |
| --- | --- | --- |
| `create_reservation` | 고객명, 연락처, `roomTypeId`, 선택 `roomId`, arrival/departure, 인원, source/ratePlan/nightlyRate | 날짜, 타입 활성, CTA/CTD/MLOS, 타입 capacity, 객실 중복 |
| `edit_reservation` | `reservationId`, `expectedVersion`, 일정·타입·인원·요금 | `DUE_IN`, group pickup 제외, optimistic version, 새 일정 재고 |
| `assign_room` | `reservationId`, `roomId`, `expectedVersion` | 예약 타입 일치, OOS 제외, 객실 night 유일성 |
| `move_room` | `reservationId`, `roomId`, `expectedVersion`, `reason` | `IN_HOUSE`, 공실·청소/점검 완료, 남은 숙박일, 기존 객실 Dirty |
| `check_in` / `check_out` | `reservationId` | 상태 전이, 체크인 객실 준비, 체크아웃 folio 잔액 0 |
| `cancel_reservation` / `mark_no_show` | `reservationId`, `reason` | `DUE_IN`, 타입/객실 nights와 group pickup 복원 |
| `update_inventory_control` | `roomTypeId`, `stayDate`, sellLimit, closed, `websiteClosed`, minStay, CTA/CTD, priceOverride | 물리 객실·확정 예약 이하 sell limit 금지, 공식 홈페이지 판매 독립 제어 |
| `bulk_update_inventory_controls` | `from`, `to`, `roomTypeIds`, `weekdays`, 재고 필드, `websiteClosed`, 선택 mapping/channel sell/net | 730일, 5,000셀, 타입 유효, 홈페이지 노출 유지/허용/중지, 입금가≤판매가, 계약 존재 |
| `update_website_settings` | 버전, 공개 여부, 호텔/브랜드/Hero/섹션/연락처/체크인·아웃, hero media/layout/overlay/height/CTA, accent, navigation JSON | `ADMIN`, 필수 길이·이메일·시간, 고정 섹션 allowlist·유일성·최소 1개 노출, 안전한 CTA target·hex color, optimistic version |
| `update_room_type_website` | `roomTypeId`, 버전, 공개, 순서, 마케팅명, 짧은/상세 소개, amenities JSON | 활성 타입, 최대 20개 편의시설, optimistic version |
| `upload_website_media` | 선택적 client UUID, scope, 선택 `roomTypeId`, role, alt, order, filename, image data URL | `ADMIN`, JPEG/PNG/WebP, decode 후 3MB·base64 transport 4.2MB, scope/type 관계, server-only Storage write |
| `delete_website_media` | `mediaId` | property scope, Storage object와 metadata 삭제, 선택된 hero pointer 원자 해제, 감사 로그 |
| `create_business_block` | 프로필, block code/name, 일정, status, deduct flag, cutoff | 일정·코드·프로필 검증 |
| `update_block_inventory` | `blockId`, 타입·날짜별 original/current/rate | picked-up 이하 감소 금지, 하우스 capacity |
| `add_rooming_entry` / `pickup_rooming_entry` | block, 고객, 일정, 타입, 요금 | block 일정·할당, 중복 pickup, 예약 재고 원자 전환 |
| `cutoff_block` | `blockId` | 미픽업 hold만 반환하고 pickup 수량 보존 |
| `post_charge` / `post_payment` | 예약, window, 거래코드/수단, amount | open cashier, open window, 양수 금액, routing |
| `split_folio_entry` | source entry, target window, amount | 원전표 잔액 안에서 reversal+재전기 |
| `reverse_folio_entry` / `refund_payment` | entry, amount/reason | append-only 반대 기록, 중복·초과 정정 금지 |
| `transfer_to_ar` | folio window, account profile | direct-bill 승인, 양수 잔액, credit limit, invoice+folio 원자 처리 |
| `post_ar_payment` | `invoiceId`, amount, method | open cashier, invoice 잔액 이하, 완납 상태 전환 |
| `create_channel_connection` | provider, name, external property ID | provider/property 유일성 |
| `create_channel_mapping` | connection, external room/rate IDs, internal type/rate plan | 활성 connection, 외부 mapping 유일성 |
| `upsert_channel_contract` | connection, `COMMISSION`/`NET_RATE`, percent, cycle, terms, validity | 0~100%, 유효 기간, open settlement 계약 변경 guard |
| `queue_ari_delta` | `mappingId`, start/end date | 활성 mapping, 날짜별 revision 증가, inventory payload 구성 |
| `dispatch_ari_update` | `ariId`, success/failure simulation | immutable delivery attempt 추가, 상태·attempt 증가 |
| `ingest_channel_message` | connection/message/external reservation IDs, revision, NEW/MODIFY/CANCEL payload | message 멱등, revision 증가, mapping, 예약 상태·재고 |
| `replay_channel_message` | 실패 inbound message ID | 원 payload 보존, 같은 검증 경로 재실행 |
| `dispatch_outbox_event` | event ID, success/failure simulation | PENDING/FAILED만 재시도, attempt와 오류 보존 |
| `post_accounting_entry` | date, REVENUE/EXPENSE/ADJUSTMENT, debit/credit account, amount, description, vendor, department | 서로 다른 활성 계정, 양수 금액, 차대 균형 |
| `reverse_accounting_entry` | `entryId`, `reason` | POSTED 원전표, line debit/credit 반전, 원전표 REVERSED |
| `accrue_channel_settlement` | `connectionId`, `reservationId` | 활성 계약, 예약별 유일성, 투숙일 rate coverage, 정산 공식 |
| `mark_channel_settlement_paid` | `settlementId` | ACCRUED 상태, 현금·미수금·미지급금 전표 |
| `open_cashier` / `close_cashier` | opening amount / counted amount | 사용자별 단일 open session, expected/variance 계산 |
| `run_night_audit` | 없음 | 미처리 도착·open cashier·failed outbox blocker 0, 일별 중복 전기 차단 |
| `export_report` | report filters, `CSV`/`XLSX` | `REPORT_EXPORT`, 최대 25,000행, export/audit 기록 |

### 장기 재고 벌크 예시

```json
{
  "action": "bulk_update_inventory_controls",
  "from": "2026-08-01",
  "to": "2026-10-31",
  "roomTypeIds": "[\"room-type-deluxe\",\"room-type-suite\"]",
  "weekdays": "[1,2,3,4,5]",
  "sellLimit": "12",
  "priceOverride": "185000",
  "minStay": "2",
  "closed": "false",
  "cta": "false",
  "ctd": "false",
  "mappingId": "channel-mapping-id",
  "channelSellRate": "195000",
  "channelNetRate": "158000"
}
```

### 채널 계약과 정산 예시

```json
{
  "action": "upsert_channel_contract",
  "connectionId": "channel-connection-id",
  "contractType": "COMMISSION",
  "commissionPercent": "12.5",
  "settlementCycle": "PER_STAY",
  "paymentTermsDays": "30",
  "validFrom": "2026-07-16",
  "validTo": ""
}
```

```json
{
  "action": "accrue_channel_settlement",
  "connectionId": "channel-connection-id",
  "reservationId": "reservation-id"
}
```

### 회계 전표 예시

```json
{
  "action": "post_accounting_entry",
  "businessDate": "2026-07-16",
  "entryType": "EXPENSE",
  "debitAccountId": "hotel-operating-expense-account-id",
  "creditAccountId": "cash-account-id",
  "amount": "25000",
  "description": "세탁 외주 비용",
  "vendor": "Sample Linen",
  "department": "HOUSEKEEPING"
}
```

### Snapshot 응답 축약 구조

```json
{
  "property": { "id": "prop-seoul", "business_date": "2026-07-16" },
  "principal": { "email": "...", "role": "PROPERTY_ADMIN", "capabilities": [] },
  "metrics": { "arrivals": 0, "inHouse": 0, "occupancy": 0, "roomRevenue": 0 },
  "controls": { "blockers": [], "openCashier": null, "audit": null },
  "reservations": [],
  "rooms": [],
  "inventory": { "dates": [], "types": [] },
  "groups": { "accounts": [], "blocks": [], "inventory": [], "rooming": [] },
  "finance": { "windows": [], "entries": [], "arAccounts": [], "arInvoices": [], "trialBalance": {} },
  "integrations": { "connections": [], "contracts": [], "mappings": [], "ari": [], "inbound": [], "attempts": [], "outbox": [] }
}
```

## 성능과 확장성

### 현재 최적화

- 준비된 SQL과 bind parameter 사용
- POST는 30개 query snapshot을 생성하지 않고 mutation receipt만 반환; TanStack Query가 `core/full/domain` key를 선택적으로 무효화
- 로그인 직후에는 heavy group/finance/channel 데이터를 제외한 `view=core`를 먼저 로드하고 필요한 모듈 진입 시 full snapshot 지연 로드
- Core/full Snapshot을 property·사용자별 3초 short cache로 분리
- 동일 사용자 동시 Snapshot 요청 Promise 병합 및 직렬화 결과 재사용
- `Accept-Encoding: gzip` 클라이언트에는 core/full JSON 직렬화와 gzip 결과를 각각 재사용
- Supabase asymmetric JWT의 JWKS local verification, access token identity 30초·역할/property/페이지 권한 최대 5초 cache, 동일 검증 in-flight Promise 병합
- Vercel cold instance는 필수 table과 property를 읽기 전용으로 probe하며 schema 또는 역할을 runtime에서 변경하지 않음
- Report 사용자·필터별 5초 short cache
- 쓰기 성공 시 snapshot/report cache 무효화
- 예약, 날짜, 객실 타입, 상태, 채널, 원장 중심 복합 인덱스
- Supavisor transaction pooler와 `prepare:false`를 통한 serverless Functions 친화적 연결
- Vercel Functions를 한국 사용자의 가까운 Seoul `icn1`에 배치하고 Fluid Compute로 동일 instance의 동시 요청·cache를 공유
- `postgres.begin` transaction으로 모든 command statement를 원자 실행
- 최대 200개 report cache entry 유지 및 만료 청소
- Outbox와 외부 전달 분리
- 장기 캘린더를 기본 Snapshot과 분리해 선택한 기간만 지연 조회
- 날짜 범위·객실 타입·채널 매핑 복합 인덱스
- ARI queue는 범위 전체의 물리 재고·제어·예약·블록 hold·revision을 5개 집합 조회로 읽고, 날짜 수와 무관하게 ARI/outbox를 2개 multi-row insert로 기록
- 금액·숫자·business date·JSONB 배열 표시는 `lib/format.ts`에서 공유해 서버와 화면의 변환 규칙을 일치
- 500객실 생성은 500 room insert + 감사 + 멱등키, 총 502 statement를 하나의 PostgreSQL transaction으로 실행
- 장기 재고 5,000셀은 bounded 하위 batch로 처리하며 각 셀은 유일키·검증 trigger로 보호
- 금전 command의 unique idempotency receipt는 도메인 전기와 같은 transaction에 strict insert되어 동시 retry의 loser 전체를 rollback
- 로그인 8회/분, 공개 조회 60회/분, 공개 예약 10회/분, 인증 PMS write 120회/분을 `api_rate_limits` UPSERT로 모든 instance가 공유

`npm run benchmark`는 요청 수·동시성·path를 환경 변수로 바꿀 수 있고 p95 250ms 미만과 오류 0건을 release gate로 사용합니다. Supabase Auth가 필요한 환경은 `PMS_TEST_EMAIL`과 `PMS_TEST_PASSWORD`를 함께 전달하면 먼저 로그인한 뒤 HttpOnly session cookie로 측정합니다. 2026-07-17 core snapshot 로컬 production 측정은 warm-up 10회 후 100요청/동시성 10에서 실패 0건, 530.60 req/s, p50 18.48ms, p95 21.68ms, p99 24.74ms였습니다. 같은 날 Vercel Seoul `icn1` 프로덕션은 warm-up 20회 후 200요청/동시성 10에서 실패 0건, 252.04 req/s, p50 36.13ms, p95 53.20ms, p99 96.01ms로 게이트를 통과했습니다. 쓰기 직후에는 core/full/report cache를 모두 비우므로 작업 결과가 오래된 Snapshot에 가려지지 않습니다.

500객실 실제 경쟁 검증은 동일 객실번호 500개를 두 요청이 동시에 생성하도록 실행했습니다. 결과는 한 요청 `200`, 경쟁 요청 `409`, 최종 생성 수 정확히 500, winner key 재실행 `X-Idempotent-Replay: true`였으며 500개 미만의 부분 commit은 없었습니다. 검증 데이터는 확인 직후 transaction으로 정리했습니다.

### 생성 한도

| 항목 | 제한 |
| --- | --- |
| 객실 타입 총수 | 데이터베이스 고정 상한 없음 |
| 실물 객실 총수 | 데이터베이스 고정 상한 없음 |
| 한 번의 대량 객실 생성 | 1~500실 |
| 객실 타입 기준 인원 | 1~20명 |
| 객실 타입 코드 | 영문·숫자·`_`·`-`, 2~12자 |
| 객실번호 | 최대 16자 |
| 층 | -10~250 |
| 객실 특성 | 최대 20개 token |
| 재고 캘린더 조회·제어 horizon | 한 요청 최대 730일 |
| 재고 벌크 변경 | 한 번에 최대 5,000 타입·일자 셀 |
| 회계·리포트 조회 | 한 요청 최대 367일 |

실제 운영 규모는 Supabase compute, connection/pooling 정책, 리포트 기간과 동시 사용자 수에 따라 capacity test로 결정해야 합니다. 객실 수 자체보다 날짜별 예약 객실박과 리포트 조회량이 주요 용량 지표입니다.

## Talos Flow UI

Talos Flow UI는 Toss Design System을 복제하지 않고, 공개된 Toss UX 원칙을 호텔 B2B 업무 화면에 맞게 해석한 디자인 레이어입니다. Talos는 Toss와 제휴하거나 Toss의 공식 제품이 아닙니다.

### 적용 원칙

- Toss Blue 계열의 명확한 primary action
- `#191F28` 중심의 높은 텍스트 가독성
- `#F2F4F6`, `#E5E8EB` 기반의 가벼운 레이어
- Toss 공식 CDN의 `Toss Product Sans` Regular/Bold 웹폰트 로드와 시스템 fallback
- fill/weak 버튼으로 주요·보조 행동 구분
- 12~24px 라운드와 최소한의 그림자
- 로딩·비활성·선택·오류 상태의 시각적 일관성
- `Cmd/Ctrl + K`, `Escape`, `aria-current`, `aria-pressed`, `focus-visible`
- `prefers-reduced-motion` 존중
- 모바일 하단 가로 스크롤 업무 내비게이션
- 가치와 결과를 먼저 설명하는 한국어 마이크로카피

### 참고한 공개 자료

- [Toss Design System Button](https://tossmini-docs.toss.im/tds-mobile/components/button/)
- [Toss Design System Colors](https://tossmini-docs.toss.im/tds-mobile/foundation/colors/)
- [토스 디자이너가 제품에만 집중할 수 있는 방법](https://toss.tech/article/toss-design-system)
- [토스 디자인 원칙: Value first, Cost later](https://toss.tech/article/value-first-cost-later)
- [토스 디자인 원칙: Easy to answer](https://toss.tech/article/insurance-claim-process)
- [Supabase JSON Web Token 검증](https://supabase.com/docs/guides/auth/jwts): 프로젝트 JWKS endpoint, asymmetric token 서명 검증, issuer와 표준 claim
- [Supabase JWT Signing Keys](https://supabase.com/docs/guides/auth/signing-keys): ES256 공개키, Edge 10분 cache와 key rotation 주의사항

### PMS·회계 벤치마크 근거

- [Oracle OPERA Cloud Commission Codes](https://docs.oracle.com/en/industries/hospitality/opera-cloud/25.3/ocsuh/c_configuration_codes_commission_codes.htm): checkout 이후 적격 매출 기반 비율/정액 수수료 계산 모델
- [Oracle OPERA Cloud Process Commission Payments](https://docs.oracle.com/en/industries/hospitality/opera-cloud/23.5/ocsuh/t_commissions_processing_commission_payments.htm): 수수료 hold, 지급과 처리 상태
- [Oracle OPERA Cloud Channel Negotiated Rates](https://docs.oracle.com/en/industries/hospitality/opera-cloud/25.5/ocsuh/t_managing_profile_channel_negotiated_rates.htm): 채널별 rate code와 유효 기간
- [Oracle OPERA Cloud Channel Rate Mapping](https://docs.oracle.com/en/industries/hospitality/opera-cloud/25.1/ocsuh/t_admin_financial_configuring_channel_rate_mapping.htm): 내부 요금과 채널 요금 매핑 분리
- [Oracle OPERA Cloud Transaction Codes](https://docs.oracle.com/en/industries/hospitality/opera-cloud/25.2/ocsuh/c_admin_financial_cashiering_about_transaction_codes.htm): 매출·비매출·세금·결제 분류와 ledger 연결
- [Oracle OPERA Cloud End of Day Reports](https://docs.oracle.com/en/industries/hospitality/opera-cloud/25.4/ocsuh/c_reports_end_of_day.htm): guest/AR/deposit/package ledger와 trial balance
- [Oracle OPERA Cloud Financial Reports](https://docs.oracle.com/en/industries/hospitality/opera-cloud/24.1/ocsuh/c_reports_financials.htm): journal, transaction summary, net/VAT/gross 보고
- [Mews Accounting Report](https://help.mews.com/s/article/accounting-report): 기간별 불변 원장, 매출·결제·예치금, net/VAT/gross
- [Mews Accounting Categories](https://help.mews.com/s/article/create-an-accounting-category?Language=en_US&language=en_US): ledger account code, cost center, external code 구조
- [Cloudbeds Custom Accounting Codes](https://myfrontdesk.cloudbeds.com/hc/en-us/articles/36722395474843-Custom-accounting-codes-overview): PMS transaction과 GL grouping/export

Talos의 `COMMISSION`/`NET_RATE` 이중 계약은 위 상용 PMS의 채널 rate mapping과 수수료 원장 원칙을 바탕으로, 국내 호텔 실무의 판매가·입금가 대사를 하나의 정산 모델로 확장한 것입니다. 회계 원장은 상용 PMS의 append-only journal과 trial balance 개념을 구현하되, 운영 ERP로 전송할 수 있도록 계정 코드·부서·외부 코드를 분리했습니다.
- [Toss Product Sans 소개](https://toss.im/simplicity-21/sessions/3-3)
### 직원·권한 API

`GET /api/pms?view=users`는 현재 property의 직원 assignment만 반환하며 `users=READ|WRITE`가 필요합니다. 비밀번호와 `auth_user_id` 원문은 반환하지 않고 Auth 연결 여부만 `auth_ready`로 제공합니다. `create_staff_user`, `update_staff_access`, `set_staff_active`, `reset_staff_password`는 모두 `USER_ADMIN` capability와 Idempotency-Key를 요구합니다. `POST /api/auth/change-password`는 로그인 세션, same-origin, 분산 rate limit, 비밀번호 강도를 검증한 뒤 Supabase Auth 비밀번호와 assignment의 최초 변경 상태를 갱신합니다.

모든 bounded GET projection은 대응 workspace 조회 권한을 다시 확인합니다. `core`는 shell 구동에 필요하지만 예약·객실·재고·지표·마감 controls를 현재 사용자의 페이지 조합에 맞춰 비우므로, 좁은 권한 계정이 배경 응답으로 다른 업무 데이터를 수신하지 않습니다.
