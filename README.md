# Aurora Hotel PMS

Aurora는 예약, 객실 재고, 프런트, 하우스키핑, 그룹 블록, 폴리오, 매출채권, 야간 감사, OTA 연동과 운영 리포트를 하나의 원장으로 연결하는 호텔 PMS입니다.

## 주요 기능

- 예약 생성·수정·취소·노쇼, 객실 배정과 룸 무브
- 객실 타입 및 실물 객실 마스터, 활성/비활성, 한 번에 최대 500실 대량 생성
- 날짜별 판매 한도, stop-sell, 최소 숙박, CTA/CTD, 요금 override
- 회사·여행사·그룹 계정, 비즈니스 블록, rooming list와 픽업
- append-only 폴리오, 다중 윈도우, 세금·봉사료, 분할·반대전표·환불
- AR 청구·부분 수납·신용 한도와 trial balance
- 캐셔 개시·마감과 차액 대사, 야간 감사와 영업일 마감
- OTA ARI delta, NEW/MODIFY/CANCEL, revision, DLQ와 transactional outbox
- 9개 통합 리포트, 최대 367일 복합 필터, Excel `.xlsx`와 CSV 내보내기
- 역할 기반 권한, 개인정보 마스킹, optimistic concurrency와 감사 로그

## 실행과 검증

```bash
npm install
npm run dev
npm test
npm run benchmark
```

Node.js `>=22.13.0`이 필요합니다. `npm test`는 프로덕션 빌드와 전체 D1 마이그레이션, 재고·정산·연동·리포트 불변식을 함께 검증합니다.

## 데이터와 배포

- 구조화된 운영 데이터: Cloudflare D1
- 스키마: `db/schema.ts`
- 마이그레이션: `drizzle/`
- 인증: Sites가 전달하는 workspace identity 헤더
- 배포 설정: `.openai/hosting.json`

결제 카드 원문이나 CVV는 저장하지 않으며, 실제 결제 연동에서는 PSP 토큰만 보관해야 합니다.
