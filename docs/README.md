# Aurora Hotel PMS

Aurora는 예약, 장기 객실 재고·요금, 프런트 데스크, 하우스키핑, 그룹 블록, 폴리오, 매출채권, 채널 계약·정산, 호텔 회계·손익, 캐셔, 야간 감사와 운영 리포트를 하나의 운영 원장으로 연결하는 차세대 호텔 PMS(Property Management System)입니다.

단순한 대시보드 데모가 아니라 실제 상태 전이, 재고 차감, 정산 원장, 권한, 동시성, 감사 로그와 실패 복구를 데이터베이스 불변식으로 보호하는 것을 목표로 합니다.

> 현재 운영 구성: Next.js 16 + Vercel Functions + Supabase PostgreSQL 17 + Supavisor transaction pooler

## 현재 릴리스 현황

| 항목 | 현재 값 |
| --- | --- |
| 운영 URL | [https://aurora-pms-gilt.vercel.app](https://aurora-pms-gilt.vercel.app) |
| 격리 스테이징 URL | [https://aurora-pms-staging.vercel.app](https://aurora-pms-staging.vercel.app) — 별도 Vercel 프로젝트 `aurora-pms-staging` |
| GitHub 저장소 | [sksmsrkk-glitch/Aurora_PMS](https://github.com/sksmsrkk-glitch/Aurora_PMS) |
| 작업 브랜치 | `main` |
| 인증 | Supabase Auth password login, refreshable HttpOnly session, 서버 RBAC·property assignment |
| 데이터베이스 | Supabase 프로젝트 `tnbxreeidezidckemflb`, PostgreSQL 17 |
| 스테이징 데이터베이스 | Supabase Micro 프로젝트 `tkfcnkxxcsgslqfnoclg`, 운영 ref와 물리 분리 |
| Vercel 함수 리전 | Seoul `icn1` — 한국 호텔 사용자의 캐시 적중·정적·인증 응답 지연 최소화 |
| 저장소 지표 | [migration·table·RLS·action·test·CSS 자동 집계](generated/project-metrics.md) |
| 자동 검증 | production build + unit/behavior + PostgreSQL integration + staging E2E |
| 전체 업무 QA | 격리 환경 `qa:workflow` 25개 checkpoint, booking/CMS·공개 SEO E2E gate |
| 핵심 API release gate | Vercel Seoul: 200 requests, concurrency 10, 0 failures, 252.04 req/s, p50 36.13ms, p95 53.20ms |
| 공개 호텔·부킹 | `/hotel`, `/hotel/book`, PMS CMS 콘텐츠·이미지와 실시간 가격·재고 기반 직접 예약·취소 |

### 구현 완료 범위

| 영역 | 상태 | 구현 수준 |
| --- | --- | --- |
| 예약·투숙 | 완료 | 생성, 수정, 배정, 체크인·아웃, 취소, 노쇼, 룸 무브, 낙관적 잠금 |
| 객실·하우스키핑 | 완료 | 타입/실물 객실, 최대 500실 대량 생성, 청소·점검·OOS |
| 재고·요금 | 완료 | 최대 730일 조회, 5,000셀 벌크 변경, MLOS/CTA/CTD/stop-sell |
| 그룹·세일즈 | 완료 | 프로필, 블록, 날짜별 할당, rooming list, pickup, cutoff |
| 폴리오·캐셔·AR | 완료 | 다중 창, 라우팅, 분할, 반대, 결제·환불, 회사 후불, 수납 |
| 채널 허브 | 완료 | 연결·매핑, ARI, inbound revision, DLQ, outbox, delivery attempt |
| 채널 계약·정산 | 완료 | 수수료/입금가 계약, 채널 판매가·호텔 입금가, 발생·지급 대사 |
| 호텔 회계·손익 | 완료 | 11개 기본 계정, 복식부기, 불변 journal, 반대전표, P/L KPI |
| 리포트·Excel | 완료 | 11종, 키워드·복합 필터, 마스킹, CSV/XLSX, export audit |
| 야간 감사 | 완료 | blocker, 객실료 전기, cutoff, 영업일 전환 |
| UI 시스템 | 완료 | Aurora Flow UI, Toss Product Sans 실제 CDN 로드, 반응형·접근성 상태 |
| 인증·테넌트 격리 | 완료 | Supabase Auth, access/refresh cookie, 역할·capability, assignment 기반 property scope |
| 호텔 홈페이지·부킹 엔진 | 완료 | 실시간 가용성, CTA/CTD/MLOS, 요금 snapshot, 멱등 예약, 온라인 취소·재고 복원 |
| 홈페이지 관리 CMS | 완료 | 호텔 소개, 호텔/객실 이미지, 객실 소개·편의시설, 타입 생성·게시, Supabase Storage, 홈페이지 전용 일자별 판매 중지 |
| 운영 배포 | 완료 | GitHub, Supabase migration, Vercel Production, Seoul `icn1` |

### 2026-07-17 플랫폼 하드닝 라운드

- 배포 전에 migration ID, `aurora_app`의 `NOLOGIN`·`NOBYPASSRLS`, 연결 사용자 membership, tenant policy 수와 실제 `SET LOCAL ROLE` transaction을 검증합니다.
- 루트 SQL 정규식 허용 목록을 제거하고 인증에 필요한 `findActiveRoleAssignments(email)`만 닫힌 capability로 제공합니다.
- 운영 날짜·시각 컬럼을 `date`, `time`, `timestamptz`로 전환하고 PostgreSQL date parser가 `YYYY-MM-DD`를 보존하게 했습니다.
- `rate_plans`, `rate_plan_room_types`, `rate_plan_calendar`를 도입하고 WEB-DIRECT 요금이 공식 홈페이지의 nightly rate를 직접 구동합니다.
- 대시보드의 `+8%`, `4.2%` 같은 고정값을 제거하고 property 영업일 기준 오늘·전일의 도착, 점유, 매출, ADR을 계산합니다.
- 공개 사이트에 신뢰된 canonical, Open Graph, Hotel JSON-LD, 동적 sitemap과 PMS/API robots 차단을 추가했습니다.
- 불리언 플래그와 구조화 payload를 native `boolean`·`jsonb`로 전환하고 0박 예약을 DB 제약으로 차단합니다.
- 공개 호텔 layout을 PMS CSS·Query Provider와 분리하고 CMS projection만 60초 캐시합니다.
- ARI 365일 생성은 날짜별 왕복 대신 5개 범위 조회와 2개 bulk insert로 고정합니다.
- 90KB 단일 `globals.css`와 1,700줄 핸드북을 책임별 CSS·문서 모듈로 분리했습니다.

`완료`는 현재 저장소의 구현과 자동 QA 범위를 의미합니다. 실제 호텔의 법정 회계, 결제대행, 개인정보 처리, OTA 인증, 장애복구 목표를 충족했다는 인증은 아니며, 운영 전 [프로덕션 전환 전 필수 작업](operations.md#프로덕션-전환-전-필수-작업)을 별도로 수행해야 합니다.

## 문서 지도

- [아키텍처와 설계 결정](architecture.md)
- [화면·업무·홈페이지·리포트 기능](features.md)
- [보안·권한·데이터 모델·마이그레이션](security-data.md)
- [API·성능·UI·벤치마크](api-performance.md)
- [설치·개발·테스트](development.md)
- [운영·장애 대응·프로덕션 전환](operations.md)
- [자동 생성 프로젝트 지표](generated/project-metrics.md)
