/** Stable database/domain error translation without branch-local includes chains. */
export type MappedPmsError={status:number;error:string};

const mappings:readonly [RegExp,MappedPmsError][]=[
  [/SUBSCRIPTION_ROOM_LIMIT_EXCEEDED/iu,{status:409,error:"현재 요금제의 활성 객실 수 한도를 초과합니다."}],
  [/SUBSCRIPTION_USER_LIMIT_EXCEEDED/iu,{status:409,error:"현재 요금제의 활성 사용자 수 한도를 초과합니다."}],
  [/room_number_uq|rooms\.property_id/iu,{status:409,error:"다른 작업자가 같은 객실 번호를 먼저 생성했습니다. 객실 목록을 새로고침해 주세요."}],
  [/room_type_code_uq|room_types\.property_id/iu,{status:409,error:"이미 사용 중인 객실 타입 코드입니다."}],
  [/room_night_uq|reservation_nights\.property_id/iu,{status:409,error:"선택한 객실은 해당 일정에 이미 예약되어 있습니다. 다른 객실을 선택하세요."}],
  [/reservation_transition_from_uq|reservation_transitions\.property_id/iu,{status:409,error:"다른 작업자가 이미 이 예약의 상태를 변경했습니다. 화면을 새로고침해 확인하세요."}],
  [/reservation_mutation_version_uq|reservation_mutations\.property_id/iu,{status:409,error:"다른 작업자가 같은 예약 버전을 먼저 변경했습니다. 화면을 새로고침하세요."}],
  [/room type sold out/iu,{status:409,error:"선택한 객실 타입은 해당 날짜에 판매 가능한 재고가 없습니다."}],
  [/room type closed/iu,{status:409,error:"선택한 객실 타입은 해당 날짜에 판매가 마감되었습니다."}],
  [/reservation_type_night_uq/iu,{status:409,error:"예약의 날짜별 재고가 이미 반영되어 있습니다."}],
  [/block inventory sold out/iu,{status:409,error:"블록 할당이 하우스 가용 재고를 초과합니다."}],
  [/block allocation exhausted/iu,{status:409,error:"선택한 날짜의 블록 가용 객실이 모두 픽업되었습니다."}],
  [/block_pickup_entry_date_uq|block_pickup_nights\.rooming_entry_id/iu,{status:409,error:"다른 작업자가 이미 이 rooming list 항목을 픽업했습니다."}],
  [/business_block_code_uq|business_blocks\.property_id/iu,{status:409,error:"이미 사용 중인 블록 코드입니다."}],
  [/account_profile_external_uq|account_profiles\.property_id/iu,{status:409,error:"같은 유형과 외부 ID의 프로필이 이미 있습니다."}],
  [/invalid folio window/iu,{status:409,error:"열린 폴리오 창을 찾지 못했습니다."}],
  [/invalid folio entry|invalid folio detail/iu,{status:409,error:"전표 금액·세금 구성 또는 대상 폴리오가 올바르지 않습니다."}],
  [/folio_window_reservation_no_uq/iu,{status:409,error:"다른 작업자가 같은 폴리오 창 번호를 먼저 만들었습니다."}],
  [/ar_invoice_no_uq/iu,{status:409,error:"청구서 번호가 충돌했습니다. 다시 시도하세요."}],
  [/ar ledger entries are immutable|folio details are immutable/iu,{status:409,error:"확정 원장은 수정·삭제할 수 없습니다. 반대전표를 사용하세요."}],
  [/channel_connection_provider_property_uq|channel_connections\.property_id/iu,{status:409,error:"같은 채널과 외부 호텔 ID의 연결이 이미 있습니다."}],
  [/channel_mapping_external_uq|channel_mappings\.connection_id/iu,{status:409,error:"같은 외부 객실·요금 매핑이 이미 있습니다."}],
  [/rate_plan_property_code_uq|reservation_rate_plan_fk|channel_mapping_rate_plan_fk/iu,{status:409,error:"요금제 코드가 중복되었거나 연결된 요금제를 찾을 수 없습니다."}],
  [/stale channel revision/iu,{status:409,error:"이미 처리한 revision보다 오래된 채널 메시지입니다."}],
  [/integration attempts are immutable/iu,{status:409,error:"연동 시도 원장은 수정·삭제할 수 없습니다."}],
  [/pay or void accrued settlements/iu,{status:409,error:"정산 대기 건을 완료 또는 무효 처리한 뒤 계약 조건을 변경하세요."}],
  [/accounting journal lines are immutable|accounting journal entries are immutable/iu,{status:409,error:"확정 회계 원장은 수정·삭제할 수 없습니다. 반대전표를 생성하세요."}],
  [/accounting_journal_reversal_once_uq/iu,{status:409,error:"다른 작업자가 이미 이 전표의 반대전표를 생성했습니다."}],
  [/accounting_journal_source_once_uq/iu,{status:409,error:"다른 작업자가 이미 이 정산 또는 회계 작업을 완료했습니다."}],
  [/receipt must match the current paid settlement journal|restore must reverse the current paid settlement receipt|channel_deposit_event_reversal_uq/iu,{status:409,error:"다른 작업자가 이미 이 채널 입금 상태를 변경했습니다. 리포트를 새로 조회하세요."}],
  [/banquet venue time slot overlaps|banquet_reservation_overlap_guard/iu,{status:409,error:"선택한 연회장과 시간대에 이미 활성 예약이 있습니다."}],
  [/banquet_venue_property_code_uq/iu,{status:409,error:"이미 사용 중인 연회장 코드입니다."}],
  [/hotel_member_property_no_uq/iu,{status:409,error:"이미 사용 중인 회원 코드입니다."}],
  [/hotel_member_property_login_uq/iu,{status:409,error:"이미 사용 중인 회원 로그인 ID입니다."}],
];

export function mapPmsError(message:string){
  return mappings.find(([pattern])=>pattern.test(message))?.[1]??null;
}
