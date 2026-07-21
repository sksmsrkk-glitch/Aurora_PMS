# HotelStory 1:1 벤치마크와 Talos 이식 계약

이 문서는 HotelStory 실서비스 화면을 읽기 전용으로 확인한 결과와 첨부 업무지시 A–N을 Talos의 구현·검증 항목으로 고정한다. 화면이 비슷해 보이는 것만으로 완료 처리하지 않는다. 각 항목은 **DB migration + server behavior + operator UI + PostgreSQL test + 문서**가 함께 충족되어야 완료다.

## 비교 기준

| HotelStory 실화면 | 확인한 동작·필드 | Talos 이식 단위 | 상태 |
| --- | --- | --- | --- |
| 메인 대시보드 | 상품별 잔여 객실·현재가·변경가, 상품/채널/일자 리포트, 채널 입금가, 전년 대비 BOOK/REV | 상품 KPI와 실데이터 대시보드 | 진행 예정 |
| 신규 예약 목록 | Calendar/List, 입·퇴실일, 박수, 객실 수, 객실종류·조식·기준/최대인원·총액·예약 | 상품 중심 예약 생성 | 완료 — PR 2 |
| 신규 예약 달력 | 월 이동, 판매상품 선택, 일자별 가격·잔여/전체 객실 | 상품/인원 가격과 달력 예약 | 완료 — PR 2 |
| 예약 관리 | 2개 날짜조건, 채널/고객 검색, 상태·결제·페이지 크기, Excel import/export, 상세·바우처 | 검색 가능한 예약 원장과 상세 | PR 3·7 |
| 예약 바우처 | KR/EN, 금액 표시/숨김, 제목·수신자, 다운로드·Excel·인쇄·메일 | 확인서 문서·전송 queue | PR 4 |
| 채널 설정 | 사용 가능/선택 catalog, 통합/수동 구분, 외부 ID, 설정·수정·활성/중지·삭제·순서·로그 | 채널 catalog와 연결 lifecycle | PR 5 |
| 신규 블록·요금 | 객실 × 상품 × 채널 × 날짜의 대량 stop-sell/재고/요금 | 대량 matrix editor | PR 5 |
| 연회 예약 | 장소 선택, 월 달력, 예약 등록 | banquet master/reservation | PR 7 |
| 오늘 체크인/체크아웃 | 전용 목록, 완료 제외, 동일 복합필터, Excel | URL 기반 전용 업무 큐 | PR 7 |
| 오늘 객실점유 | 상품 선택, 18일 점유 timeline | 상품/객실 점유 timeline | PR 7 |
| 상품·채널 리포트 | 일·객실매출·결제·연간·YoY·채널 입금·후불; 0–6/6–12/12–18/18–24 booking curve, ADR·lead time | 리포트 확장 | PR 6 |
| 회원 관리 | 이름/전화/ID/회사/코드/가입일 검색, 활성·등급·관리자 유형 | 호텔 고객 회원 master | PR 7 |
| 숙소 관리 | 숙소·객실·오늘·요금·블록·서비스·이미지·편의시설·성수기·인원요금 탭 | 판매 catalog | PR 1·5 |

## 첨부 지시 A–N 추적

| ID | 요구사항 | 서버·데이터 완료 기준 | UI 완료 기준 | 행동 검증 |
| --- | --- | --- | --- | --- |
| A | 상품형 Rate Plan | 부모 상품 상속, 식사·패키지·판매기간·포함사항, 예약 스냅샷 | `재고 & 요금`의 판매상품 card/editor | 부모요금 변경 반영, 과거 예약 snapshot 불변 |
| B | Calendar/List 신규 예약 | 상품·인원별 가용성과 원자 예약 | List/Calendar 전환, 객실종류·조식·기준/최대·총액 | 마지막 1실 병렬 예약 1건만 성공 |
| C | 예약 상세 | 예약자와 투숙자 분리, 예약 옵션·상태·금액 | 한 화면 섹션형 detail | 권한·낙관적 잠금·감사 로그 |
| D | 확인서 | KR/EN, 금액 visibility, 문서 payload, worker delivery | PDF/Excel/인쇄/메일 dialog | 같은 요청 중복 발송 방지 |
| E | 채널 catalog | catalog/connection/mapping lifecycle | 검색·좌우 선택·통합/수동·정렬 | tenant RLS, 외부 ID 유일성 |
| F | block/rate matrix | 날짜별 객실·상품·채널 restriction/upsert | sticky 4축 matrix, bulk apply | 365일 fixed query/bulk count |
| G | 연회 | 장소·연회예약·상태·금액 | 월 달력·등록 drawer | 중복 장소 시간 차단 |
| H | 인원 요금 | 기준/최대 인원, 인원별 numeric supplement | 상품 editor 가격 grid | 유효 인원만 산출·저장 |
| I | 운영 catalog | 성수기·휴일·편의시설·서비스·이미지 | 숙소 설정 tabs | FK/RLS/native types |
| J | 리포트 | lead time·booking curve·정산/입금·후불·YoY | catalog/filter/export | 마스킹·export 감사·실계산 |
| K | 오늘 업무 URL | check-in/out/occupancy projection | 독립 route·filter·deep link | 새로고침 상태 보존 |
| L | 예약 import/export | dry-run·검증·원자 commit·rollback | template/upload/result | 교차호텔 참조 차단 |
| M | 회원 | 고객 profile·등급·회사·승인 | 검색·상태·page size | 개인정보 권한·RLS |
| N | 예약 inline log | 예약 entity audit projection | 상세 timeline | before/after·actor·time |

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

## 공통 완료 판정

1. 과거 migration 파일은 수정하지 않고 번호가 증가하는 신규 migration만 사용한다.
2. 모든 신규 tenant table은 `property_id`, FORCE RLS, `aurora_property_isolation`, `aurora_app` grant, `anon`/`authenticated` revoke를 가진다.
3. 날짜·시각·boolean·JSON·금액은 각각 native `date/timestamptz/time`, `boolean`, `jsonb`, `numeric`을 사용한다.
4. 예약·재고·금전·외부전송 mutation은 idempotency와 PostgreSQL 동시성/불변식으로 방어한다.
5. 화면의 버튼과 검색은 더미 데이터로 실제 동작을 검증하며 빈 상태·오류·모바일 상태도 확인한다.
6. PostgreSQL migration upgrade와 integration suite를 통과하기 전 완료 표시하지 않는다.
7. 구현 후 자동 지표를 재생성하고 이 표의 상태와 실제 코드 상태를 함께 갱신한다.
