# HotelStory 1:1 벤치마크와 Talos 이식 계약

이 문서는 HotelStory 실서비스 화면을 읽기 전용으로 확인한 결과와 첨부 업무지시 A–N을 Talos의 구현·검증 항목으로 고정한다. 화면이 비슷해 보이는 것만으로 완료 처리하지 않는다. 각 항목은 **DB migration + server behavior + operator UI + PostgreSQL test + 문서**가 함께 충족되어야 완료다.

## 비교 기준

| HotelStory 실화면 | 확인한 동작·필드 | Talos 이식 단위 | 상태 |
| --- | --- | --- | --- |
| 메인 대시보드 | 상품별 잔여 객실·현재가·변경가, 상품/채널/일자 리포트, 채널 입금가, 전년 대비 BOOK/REV | 상품 KPI와 실데이터 대시보드·리포트 딥링크 | 완료 — PR 1·5·6 |
| 신규 예약 목록 | Calendar/List, 입·퇴실일, 박수, 객실 수, 객실종류·조식·기준/최대인원·총액·예약 | 상품 중심 예약 생성 | 완료 — PR 2 |
| 신규 예약 달력 | 월 이동, 판매상품 선택, 일자별 가격·잔여/전체 객실 | 상품/인원 가격과 달력 예약 | 완료 — PR 2 |
| 예약 관리 | 2개 날짜조건, 채널/고객 검색, 상태·결제·페이지 크기, Excel import/export, 상세·바우처 | 검색 가능한 예약 원장과 상세 | 완료 — PR 3·4·7 |
| 예약 바우처 | KR/EN, 금액 표시/숨김, 제목·수신자, 다운로드·Excel·인쇄·메일 | 확인서 문서·전송 queue | 완료 — PR 4 |
| 채널 설정 | 사용 가능/선택 catalog, 통합/수동 구분, 외부 ID, 설정·수정·활성/중지·삭제·순서·로그 | 채널 catalog와 연결 lifecycle | 완료 — PR 5 |
| 신규 블록·요금 | 객실 × 상품 × 채널 × 날짜의 대량 stop-sell/재고/요금 | 대량 matrix editor | 완료 — PR 5 |
| 연회 예약 | 장소 선택, 월 달력, 예약 등록 | banquet master/reservation | 완료 — PR 7 |
| 오늘 체크인/체크아웃 | 전용 목록, 완료 제외, 동일 복합필터, 예약 상세 딥링크 | URL 기반 전용 업무 큐 | 완료 — PR 7 |
| 오늘 객실점유 | 상품 선택, 18일 점유 timeline | 상품/객실 점유 timeline | 완료 — PR 7 |
| 상품·채널 리포트 | 일·객실매출·결제·연간·YoY·채널 입금·후불; 0–6/6–12/12–18/18–24 booking curve, ADR·lead time | 리포트 확장 | 완료 — PR 6 |
| 회원 관리 | 이름/전화/ID/회사/코드/가입일 검색, 활성·등급·관리자 유형 | 호텔·홈페이지 회원 master | 완료 — PR 7 |
| 숙소 관리 | 숙소·객실·오늘·요금·블록·서비스·이미지·편의시설·성수기·인원요금 탭 | 판매 catalog | 상품·인원·운영 카탈로그 완료 — PR 1·5 |

## 첨부 지시 A–N 추적

| ID | 요구사항 | 서버·데이터 완료 기준 | UI 완료 기준 | 행동 검증 |
| --- | --- | --- | --- | --- |
| A | 상품형 Rate Plan | 부모 상품 상속, 식사·패키지·판매기간·포함사항, 예약 스냅샷 | `재고 & 요금`의 판매상품 card/editor | 부모요금 변경 반영, 과거 예약 snapshot 불변 |
| B | Calendar/List 신규 예약 | 상품·인원별 가용성과 원자 예약 | List/Calendar 전환, 객실종류·조식·기준/최대·총액 | 마지막 1실 병렬 예약 1건만 성공 |
| C | 예약 상세 | 예약자와 투숙자 분리, 예약 옵션·상태·금액 | 한 화면 섹션형 detail | 완료 — 권한·낙관적 잠금·감사 로그 |
| D | 확인서 | KR/EN, 금액 visibility, 문서 payload, worker delivery | PDF/Excel/인쇄/메일 dialog | 같은 요청 중복 발송 방지 |
| E | 채널 catalog | catalog/connection/mapping lifecycle | 검색·좌우 선택·통합/수동·정렬 | 완료 — tenant RLS, 비활성 ARI 차단, 외부 ID 유일성 |
| F | block/rate matrix | 날짜별 객실·상품·채널 restriction/upsert | sticky 4축 matrix, bulk apply | 완료 — 31일 fixed query, 5,000셀 원자 bulk |
| G | 연회 | 장소·연회예약·상태·금액 | 월 달력·등록 modal | 완료 — 병렬 중복 장소 시간은 1건만 성공 |
| H | 인원 요금 | 기준/최대 인원, 인원별 numeric supplement | 상품 editor 가격 grid | 유효 인원만 산출·저장 |
| I | 운영 catalog | 성수기·휴일·편의시설·서비스·이미지 | 숙소 설정 tabs | 완료 — FK/RLS/native types |
| J | 리포트 | lead time·booking curve·정산/입금·후불·YoY | catalog/filter/export | 완료 — DB 대조·마스킹·export 감사·동시 입금 차단 |
| K | 오늘 업무 URL | check-in/out/occupancy bounded projection | 독립 route·복합 filter·예약 deep link | 완료 — 18일 고정 timeline·URL 새로고침 보존 |
| L | 예약 import/export | content hash·dry-run·원자 commit·replay·rollback | Excel용 CSV template/upload/result/history | 완료 — 내장 고객 생성·중복 파일 반영 차단 |
| M | 회원 | 호텔/웹 profile·등급·회사·활성·scrypt 비밀번호 | 통합검색·필터·등록/수정/비밀번호 | 완료 — PII 마스킹·FORCE RLS·평문 비저장 |
| N | 예약 inline log | 예약·rooming/block entity audit projection | 상세 4탭 timeline | 완료 — before/after·actor·time |

## PR 1 — 판매 상품과 인원 요금

`202607210020_rate_product_catalog.sql`이 기존 `rate_plans`를 상품 master로 확장한다.

- 식사 조건: 객실 전용, 조식, 석식, 조·석식, 24시간 풀패키지
- 패키지 조건: 일반, 홈쇼핑, 선착순 업그레이드
- 판매 가능 시각과 투숙 유효일을 분리
- 부모 상품의 일자 요금을 `OFFSET` 또는 `PERCENT`로 상속
- 기준 1–20명, 최대 인원, 인원별 `numeric(14,2)` 추가요금
- 예약의 `rate_plan_id`, 상품 JSONB snapshot, 성인/소아 occupancy snapshot
- 상품 부모 cycle 차단과 호텔 일치 FK
- `rate_plan_occupancy` FORCE RLS, `aurora_property_isolation`, `aurora_app` 전용 권한

운영 화면은 상품 code보다 사람이 구별할 수 있는 이름·식사·인원·포함사항을 먼저 보여주고, editor를 기본정보 → 판매/숙박조건 → 가격/인원의 3개 섹션으로 나눈다.

## PR 2 — Calendar/List 신규 예약

프런트의 `새 예약`은 HotelStory와 동일하게 조회 방법을 먼저 **목록으로 찾기 / 달력으로 찾기**로 나눈다. 두 화면은 별도 계산식을 두지 않고 `loadReservationFacts()`의 동일한 물리 객실, 판매 한도, 확정 예약, deduct block, 상품-객실 관계, 상품 일자 요금과 인원 요금을 사용한다.

- 목록: 입실일·퇴실일·성인·아동을 조회하고 `객실종류 / 조식여부 / 기준인원 / 최대인원 / 총 금액 / 예약` 열을 표시한다.
- 목록의 빈 결과는 HotelStory의 운영 문구인 `예약가능한 객실이 없습니다.`와 재조회 안내를 표시한다.
- 달력: 이전/다음 달, 판매 상품, 성인·아동을 선택하고 일자별 객실 타입 가격과 `잔여/전체 객실`을 표시한다.
- 판매 중지, CTA/CTD, MLOS, 숙박 유효일, 상품 판매 시각, 객실/상품 최대 인원, 인원별 추가요금은 서버 projection에서 적용한다.
- 달력에서 날짜를 선택하면 판매 상품을 유지한 채 1박 목록으로 이동하며, 이후 퇴실일을 바꿔 다박 예약으로 확정할 수 있다.
- 월간 달력은 객실·날짜마다 API나 DB를 다시 호출하지 않는다. 월 범위 사실 집합을 고정된 9개 tenant-scoped 쿼리로 읽고 메모리에서 cell projection을 만든다.
- 예약 확정은 UI의 `arrival/departure`를 command 계약의 `arrivalDate/departureDate`로 명시 변환한다. 서버는 확정 직전 상품 판매기간·숙박기간·최대인원·모든 숙박일의 실효 요금과 가용 재고를 다시 검증한다.
- PostgreSQL 통합 테스트는 같은 상품에 대해 목록·달력의 3인 인원요금이 일치하는지 검증한다. 기존 마지막 1실 병렬 예약 테스트가 동시 요청 중 1건만 성공하는 재고 불변식을 계속 보증한다.

## PR 3 — 예약 상세, 예약자/투숙자와 인라인 로그

`202607210021_reservation_operational_detail.sql`은 예약의 운영 정보를 자유 메모가 아닌 typed column과 JSONB snapshot으로 승격한다. 과거 예약은 기존 투숙자 연락처를 예약자로 backfill하고 각 변경을 migration audit로 남긴다.

- 예약자: 이름·전화·이메일. 기존 `guests`는 실제 투숙자이며 두 인물은 서로 달라도 정상 저장된다.
- 상품/결제: 채널 상품명, H 객실/상품 코드, 식사, 결제구분, 서비스 요금 포함 여부를 표시한다.
- 요청/메모: 고객요청, 호텔 응답, 관리자메모, 호텔메모를 분리하고 각각 2,000자로 제한한다.
- 예약 확인: 확인/미확인, 얼리체크인과 레이트체크아웃의 native `time`, 성인/소인 인원을 저장한다.
- 카드정보: 원문 PAN은 받지 않는다. 최대 160자의 PG token 또는 마스킹 참조만 허용하며 12자리 이상 연속 숫자는 DB CHECK와 command에서 모두 거부한다.
- 취소 규정: 상품의 구조화된 취소 조건을 예약 상품 JSONB snapshot에 고정한다. 이후 상품 정책을 바꾸어도 기존 예약 화면은 예약 시점 규정을 표시한다.
- 연계/복사: 예약번호로 동반·연박·그룹 예약을 연결하며, 예약 복사는 고객/상품을 복사한 뒤 새 일정의 재고와 판매 조건을 다시 검증해 새 예약으로 확정한다.
- 로그: 연동/수정/요금/블럭 4탭으로 actor, 시각, before/after를 표시한다. 요금 탭은 immutable `reservation_rate_nights`도 함께 표시한다.
- 저장은 `expectedVersion`과 `reservation_mutations(property_id,reservation_id,expected_version)` unique guard를 사용한다. 같은 버전을 동시에 저장한 두 요청 중 하나만 commit되며 모든 변경은 감사·Outbox·멱등 영수증과 원자 처리된다.

PostgreSQL 통합 테스트는 예약자와 투숙자 불일치, 요청/응답·시간 옵션, 취소조건 snapshot, 연계예약, before/after 로그, PCI 원문 거부와 RLS를 운영 스키마에서 검증한다.

## PR 4 — 국문·영문 예약 바우처와 전달 queue

`202607210022_reservation_voucher_delivery.sql`은 사용자가 화면에서 본 확인서와 메일로 보낸 확인서가 달라지지 않도록 전송 시점 문서를 JSONB snapshot으로 보존한다.

- 바우처 projection은 호텔 연락처, 예약번호, 예약자·투숙자, 일정, 객실·상품, 인원, 일자별 요금과 취소조건만 bounded query로 읽는다. 원문 Card Info와 관리자/호텔 내부 메모는 구조적으로 선택하지 않는다.
- 국문/영문 라벨과 금액 표시/숨김은 서버의 한 payload 정책을 HTML·PDF·XLSX가 공유한다. PDF는 Noto Sans KR 글꼴 subset을 임베딩하여 실행 환경에 한글 글꼴이 없어도 문자가 깨지지 않는다.
- `RESERVATION_WRITE` 사용자는 메일을 queue할 수 있고, 문서 다운로드는 별도 export 권한을 다시 확인한다. preview·인쇄·파일 버튼·메일 입력의 로딩과 오류 상태는 dialog 안에서 구분한다.
- 메일 mutation은 delivery snapshot, `VOUCHER_EMAIL` worker job, audit, 전역 멱등 영수증을 하나의 transaction으로 저장한다. 같은 `Idempotency-Key`의 동시 요청은 한 delivery와 한 worker job으로 수렴한다.
- worker는 provider에 delivery ID를 `Idempotency-Key`로 보내며, 성공 전에는 retry 가능한 상태를 유지한다. 설정되지 않은 provider는 성공으로 위장하지 않고 durable retry/DEAD 흐름으로 보낸다.
- delivery table은 FORCE RLS를 사용하고 문서·수신자 같은 증빙 필드는 update trigger로 불변이다. worker가 바꿀 수 있는 필드는 상태, 시도 횟수, provider receipt, 오류와 완료 시각뿐이다.

PostgreSQL 통합 테스트는 동시 멱등 수렴, 교차 호텔 차단, native boolean/JSONB, immutable payload trigger, 금액 숨김과 민감정보 제외를 검증한다. 단위 테스트는 실제 PDF header·임베딩 한글 문서·XLSX workbook과 금액 숨김 결과를 생성해 확인한다.

## PR 5 — 판매채널 설정, 블럭요금과 숙소 운영 카탈로그

`202607210023_channel_rateblock_operational_catalogs.sql`은 HotelStory의 화면 용어를 기술 연결 테이블에 직접 덧씌우지 않고, 호텔 운영자가 다루는 catalog와 외부 adapter 연결을 분리한다.

- 판매채널 설정은 `채널 설정 가능 목록 ↔ 채널 설정 목록` 2열이며 검색, 드래그/버튼 등록, 연동·자체 배지, 수정, 사용/중지, 삭제, 위·아래/드래그 순서와 명시적 순서 저장을 제공한다.
- 기본 카탈로그는 국내외 OTA, 메타, 직판, 전화·워크인·기업/B2B를 포함하고 호텔은 별도관리 채널을 추가할 수 있다. 외부 호텔 ID, 기존/신규 연결, 서플라이어명·코드·JSON 설정, 별도관리와 D-n 마감을 함께 편집한다.
- 설정 비활성은 `channel_connections` 상태와 원자 변경되며 수동 ARI 생성, 블럭요금 projection, sandbox dispatch와 실제 worker 전달 모두 즉시 차단한다. 저장 순서는 채널 허브, 대시보드 채널 구성과 채널 정산 리포트의 정렬 키가 된다.
- 상품마감은 채널 기본 D-n 위에 채널×판매상품별 D-n와 native `time` 마감 시각을 둔다.
- 블럭요금은 Today/1W/2W/4W/Month와 임의 최대 31일, 채널·객실 필터를 제공한다. 행은 객실>상품, 열은 날짜이며 셀은 할당/실잔여, 판매가/입금가, Closed/MLOS/CTA/CTD를 함께 표시한다.
- 일괄 편집은 요일을 선택하고 최대 5,000셀을 저장한다. 물리 객실·확정 예약·deduct block·ARI revision은 고정 batch query로 읽고, override·ARI update·Outbox는 chunked multi-row statement와 멱등 영수증을 한 transaction에 저장한다.
- `talos_channel_rate_block_guard`가 mapping/상품/객실 일치와 실제 운영 객실을 넘는 할당을 DB에서 거부한다. commission 계약은 판매가를, net-rate 계약은 판매가 이하의 호텔 입금가를 요구한다.
- 숙소 운영 master는 성수기, 휴일, 편의시설, 서비스, 이미지를 탭으로 제공한다. 날짜·시각·불리언·금액·설정은 native `date/time/boolean/numeric/jsonb`이며 7개 신규 table 모두 property FK, FORCE RLS, `aurora_property_isolation`, app grant/revoke를 갖는다.

PostgreSQL 행동 테스트는 API를 통해 카탈로그·연결·상품마감을 만든 뒤 2일 블럭요금을 저장하고, 정확히 2개 override·ARI·Outbox 생성, 같은 idempotency key 재실행 무효, 객실 초과 할당 전체 rollback, 비활성 채널 ARI 차단, 교차 호텔 projection 0건, 운영 카탈로그 CRUD와 7개 FORCE RLS를 검증한다.

## PR 6 — 리드타임·예약곡선·입금·후불·YoY 리포트

기존 리포트 센터를 11종에서 15종으로 확장하고 예약 상세 리포트 자체도 보강했다. 모든 집계는 브라우저 행을 더하지 않고 tenant-scoped 서버 SQL에서 계산되며 generic CSV/XLSX projection이 같은 열과 필터를 재사용한다.

- 예약 상세는 예약 생성 `timestamptz`를 property timezone의 현지 예약일·시간으로 변환한다. `입실일 - 예약일` 리드타임과 `00–06 / 06–12 / 12–18 / 18–24` 시간대가 각 예약 행에 표시된다.
- 시간대별 예약곡선은 예약일별 4개 BOOK bucket, 전체/유효/취소 BOOK, REV, 평균 리드타임을 서버에서 집계한다. 검색·상태·채널·객실 타입 필터를 그대로 적용한다.
- 전년 대비 예약현황은 선택한 입실 월마다 현재/전년 BOOK·REV와 YoY를 계산한다. 일자별 예약 요금 snapshot이 있으면 그 합계를, 없으면 확정 당시 nightly rate×숙박수를 사용한다.
- 채널 입금관리는 입금 예정일, 채널·연동 유형·예약·결제 유형, 판매가·비용·호텔 입금가, 상태, 입금일·메모·회계 전표를 제공한다. `미입금만 보기`와 `수기·현장결제 제외`는 서버 필터다.
- 입금처리는 채널 미수/현금 분개, PAID projection, RECEIPT 사건, 감사 로그와 멱등 영수증을 한 transaction에 저장한다. 입금복구는 원 지급 전표를 REVERSED로 바꾸고 반대전표·RESTORE 사건을 추가한 뒤 ACCRUED로 되돌린다.
- `pms_channel_deposit_event_guard`가 settlement row를 잠그고 사건과 현재 payment journal이 정확히 일치하는지 확인한다. 같은 멱등키 재시도는 replay되고, 서로 다른 키의 동시 입금은 정확히 한 건만 성공한다.
- 후불 정산관리는 거래처·청구서·예약, 청구/수납/미수, 상태, 최종 수납일과 조회 종료일 기준 연체일을 제공한다.

`202607210024_hotelstory_reporting_deposits.sql`은 입금 projection 필드와 append-only `channel_deposit_events`를 추가한다. 신규 테이블은 native `date/numeric/timestamptz`, property 복합 FK, FORCE RLS, tenant policy, app 최소 권한, update/delete 거부 trigger를 갖는다. PostgreSQL 통합 테스트는 03:30 KST 예약의 정확한 27일 리드타임과 00–06 bucket, 현재 200,000원/전년 160,000원의 REV YoY 25%, 입금→복구 전표/사건, replay, 교차 호텔 비노출과 동시 요청 단일 성공을 실제 migration에서 대조한다.

## PR 7 — 연회·당일 운영·예약 가져오기·호텔 회원

`202607210025_hotelstory_final_operations.sql`은 PR 7의 운영 master를 추가한다. `banquet_venues`, `banquet_reservations`, `hotel_members`는 property 복합키, FORCE RLS, 동일 tenant policy, `aurora_app` 최소 권한과 공개 role revoke를 사용한다. 날짜는 `date`, 연회 시각은 `time`, 생성·변경 시각은 `timestamptz`, 시설·개인정보 설정은 `jsonb`, 요금은 `numeric(14,2)`다.

- `/groups/banquet`: 연회장 master, 월 이동, 연회장·상태·행사/담당자 검색, 날짜 클릭 등록, 행사 클릭 편집을 제공한다. 활성 가예약/확정 예약은 `pms_banquet_overlap_guard()`가 venue/day advisory transaction lock을 잡고 시간 교집합을 확인한다. 다른 멱등키로 동시에 들어온 동일 시간 요청도 정확히 하나만 commit된다. 생성·수정·상태 변경은 before/after 감사와 멱등 영수증을 같은 transaction에 저장한다.
- `/frontdesk/checkin`, `/frontdesk/checkout`: 기준일·예약/고객/전화/객실 검색, 채널·객실타입·판매상품 필터, 예약 상세 딥링크와 권한 기반 체크인/체크아웃을 제공한다. 체크아웃은 원장 잔액이 0원일 때만 가능하고 체크인은 배정 객실이 준비된 기존 command 불변식을 그대로 사용한다.
- `/frontdesk/occupancy`: 기준일부터 정확히 18일의 객실 행×날짜 열 timeline을 제공한다. 판매상품·채널·객실타입 필터는 서버 projection에 적용하며 예약 cell에서 기존 예약 상세로 이동한다.
- `/frontdesk/imports`: Excel에서 UTF-8 CSV로 저장할 수 있는 예약 양식을 내려받고 최대 2,000행을 dry-run한다. 필수 헤더, 날짜 범위, 객실타입, 활성 Rate Plan, 확인번호, 고객 참조를 검증하고 오류가 0건인 job만 원자 commit한다. 고객 외부 ID가 아직 없으면 행의 고객 이름·이메일·전화로 guest와 mapping을 같은 commit에 생성한다. 파일 SHA-256과 `(property,kind,content_hash,mode)` unique 계약으로 같은 파일 commit 재시도는 기존 job receipt를 반환하며, 이관 후 바뀌지 않은 예약만 안전 rollback한다.
- `/users/members`: 회원코드·로그인 ID·이름·전화·이메일·회사·등급·회원구분·관리유형·가입일·활성 상태를 등록/검색/수정한다. 홈페이지 회원 비밀번호는 12자·문자군 3종 정책을 적용해 random salt와 scrypt parameters를 포함한 해시만 저장한다. 지원 조회는 전화·이메일·ID·회사·이름을 마스킹한다.

PostgreSQL 행동 테스트는 신규 3개 테이블의 native type/FORCE RLS, 동일 연회장·시간대 병렬 요청의 단일 성공, 월 projection, scrypt 평문 비저장, 지원 PII 마스킹, 18일 bounded timeline, 예약 CSV의 내장 고객 생성·commit replay·rollback을 실제 migration에서 검증한다.

## 공통 완료 판정

1. 과거 migration 파일은 수정하지 않고 번호가 증가하는 신규 migration만 사용한다.
2. 모든 신규 tenant table은 `property_id`, FORCE RLS, `aurora_property_isolation`, `aurora_app` grant, `anon`/`authenticated` revoke를 가진다.
3. 날짜·시각·boolean·JSON·금액은 각각 native `date/timestamptz/time`, `boolean`, `jsonb`, `numeric`을 사용한다.
4. 예약·재고·금전·외부전송 mutation은 idempotency와 PostgreSQL 동시성/불변식으로 방어한다.
5. 화면의 버튼과 검색은 더미 데이터로 실제 동작을 검증하며 빈 상태·오류·모바일 상태도 확인한다.
6. PostgreSQL migration upgrade와 integration suite를 통과하기 전 완료 표시하지 않는다.
7. 구현 후 자동 지표를 재생성하고 이 표의 상태와 실제 코드 상태를 함께 갱신한다.
