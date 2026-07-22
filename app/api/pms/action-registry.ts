/** Zod-validated PMS action registry: capability, domain, and input contract. */
import { z } from "zod";

export type ActionDomain =
  | "reservation" | "rooms" | "inventory" | "groups" | "finance"
  | "integrations" | "accounting" | "website" | "operations" | "reports" | "users";

const actionCapability = {
  create_reservation:"RESERVATION_WRITE",edit_reservation:"RESERVATION_WRITE",update_reservation_detail:"RESERVATION_WRITE",link_reservation:"RESERVATION_WRITE",queue_reservation_voucher:"RESERVATION_WRITE",cancel_reservation:"RESERVATION_WRITE",assign_room:"RESERVATION_WRITE",assign_reservation_room:"RESERVATION_WRITE",move_reservation_room:"RESERVATION_WRITE",unassign_reservation_room:"RESERVATION_WRITE",
  mark_no_show:"STAY_WRITE",check_in:"STAY_WRITE",check_out:"STAY_WRITE",move_room:"STAY_WRITE",
  update_inventory_control:"INVENTORY_WRITE",bulk_update_inventory_controls:"INVENTORY_WRITE",upsert_rate_plan:"INVENTORY_WRITE",bulk_update_rate_blocks:"INVENTORY_WRITE",
  create_account_profile:"GROUP_WRITE",create_business_block:"GROUP_WRITE",update_block_inventory:"GROUP_WRITE",add_rooming_entry:"GROUP_WRITE",cutoff_block:"GROUP_WRITE",pickup_rooming_entry:"GROUP_PICKUP",
  upsert_banquet_venue:"GROUP_WRITE",upsert_banquet_reservation:"GROUP_WRITE",set_banquet_reservation_status:"GROUP_WRITE",
  post_payment:"FOLIO_WRITE",post_charge:"FOLIO_WRITE",create_folio_window:"FOLIO_WRITE",create_routing_rule:"FOLIO_WRITE",split_folio_entry:"FOLIO_WRITE",reverse_folio_entry:"FOLIO_WRITE",refund_payment:"FOLIO_WRITE",
  transfer_to_ar:"AR_WRITE",post_ar_payment:"AR_WRITE",housekeeping:"HOUSEKEEPING_WRITE",
  create_channel_connection:"INTEGRATION_WRITE",create_channel_mapping:"INTEGRATION_WRITE",upsert_channel_contract:"INTEGRATION_WRITE",queue_ari_delta:"INTEGRATION_WRITE",dispatch_ari_update:"INTEGRATION_WRITE",ingest_channel_message:"INTEGRATION_WRITE",replay_channel_message:"INTEGRATION_WRITE",dispatch_outbox_event:"INTEGRATION_WRITE",
  upsert_channel_catalog:"INTEGRATION_WRITE",configure_property_channel:"INTEGRATION_WRITE",set_property_channel_active:"INTEGRATION_WRITE",reorder_property_channels:"INTEGRATION_WRITE",delete_property_channel:"INTEGRATION_WRITE",upsert_channel_product_cutoff:"INTEGRATION_WRITE",delete_channel_product_cutoff:"INTEGRATION_WRITE",
  post_accounting_entry:"ACCOUNTING_WRITE",reverse_accounting_entry:"ACCOUNTING_WRITE",accrue_channel_settlement:"ACCOUNTING_WRITE",mark_channel_settlement_paid:"ACCOUNTING_WRITE",restore_channel_settlement_payment:"ACCOUNTING_WRITE",
  open_cashier:"CASHIER_WRITE",close_cashier:"CASHIER_WRITE",run_night_audit:"EOD_RUN",
  create_room_type:"MASTER_WRITE",update_room_type:"MASTER_WRITE",create_room:"MASTER_WRITE",update_room:"MASTER_WRITE",bulk_create_rooms:"MASTER_WRITE",upsert_property_season:"MASTER_WRITE",delete_property_season:"MASTER_WRITE",upsert_property_holiday:"MASTER_WRITE",delete_property_holiday:"MASTER_WRITE",upsert_amenity_catalog:"MASTER_WRITE",delete_amenity_catalog:"MASTER_WRITE",upsert_service_catalog:"MASTER_WRITE",delete_service_catalog:"MASTER_WRITE",
  update_website_settings:"WEBSITE_WRITE",update_room_type_website:"WEBSITE_WRITE",upload_website_media:"WEBSITE_WRITE",delete_website_media:"WEBSITE_WRITE",
  create_staff_user:"USER_ADMIN",update_staff_access:"USER_ADMIN",set_staff_active:"USER_ADMIN",reset_staff_password:"USER_ADMIN",
  upsert_hotel_member:"USER_ADMIN",set_hotel_member_active:"USER_ADMIN",reset_hotel_member_password:"USER_ADMIN",
  export_report:"REPORT_EXPORT",
} as const;

export type PmsAction = keyof typeof actionCapability;

const domainActions: Record<ActionDomain, readonly PmsAction[]> = {
  reservation:["create_reservation","edit_reservation","update_reservation_detail","link_reservation","queue_reservation_voucher","cancel_reservation","assign_room","assign_reservation_room","move_reservation_room","unassign_reservation_room","mark_no_show","check_in","check_out","move_room"],
  rooms:["create_room_type","update_room_type","create_room","update_room","bulk_create_rooms","housekeeping","upsert_property_season","delete_property_season","upsert_property_holiday","delete_property_holiday","upsert_amenity_catalog","delete_amenity_catalog","upsert_service_catalog","delete_service_catalog"],
  inventory:["update_inventory_control","bulk_update_inventory_controls","upsert_rate_plan","bulk_update_rate_blocks"],
  groups:["create_account_profile","create_business_block","update_block_inventory","add_rooming_entry","cutoff_block","pickup_rooming_entry","upsert_banquet_venue","upsert_banquet_reservation","set_banquet_reservation_status"],
  finance:["post_payment","post_charge","create_folio_window","create_routing_rule","split_folio_entry","reverse_folio_entry","refund_payment","transfer_to_ar","post_ar_payment"],
  integrations:["create_channel_connection","create_channel_mapping","upsert_channel_contract","queue_ari_delta","dispatch_ari_update","ingest_channel_message","replay_channel_message","dispatch_outbox_event","upsert_channel_catalog","configure_property_channel","set_property_channel_active","reorder_property_channels","delete_property_channel","upsert_channel_product_cutoff","delete_channel_product_cutoff"],
  accounting:["post_accounting_entry","reverse_accounting_entry","accrue_channel_settlement","mark_channel_settlement_paid","restore_channel_settlement_payment"],
  website:["update_website_settings","update_room_type_website","upload_website_media","delete_website_media"],
  operations:["open_cashier","close_cashier","run_night_audit"],
  reports:["export_report"],
  users:["create_staff_user","update_staff_access","set_staff_active","reset_staff_password","upsert_hotel_member","set_hotel_member_active","reset_hotel_member_password"],
};

const domainByAction = new Map<PmsAction, ActionDomain>();
for (const [domain, actions] of Object.entries(domainActions) as [ActionDomain, readonly PmsAction[]][]) {
  for (const action of actions) domainByAction.set(action, domain);
}

const requiredFields: Partial<Record<PmsAction, readonly string[]>> = {
  create_reservation:["firstName","lastName","arrivalDate","departureDate","roomTypeId"],
  edit_reservation:["reservationId","arrivalDate","departureDate","roomTypeId","expectedVersion"],
  update_reservation_detail:["reservationId","expectedVersion","bookerName","guestFirstName","guestLastName","adults","children","paymentType","reservationChecked","earlyCheckin","lateCheckout"],
  link_reservation:["reservationId","linkedConfirmationNo","relationType"],
  queue_reservation_voucher:["reservationId","language","showAmount","recipientEmail","subject"],
  cancel_reservation:["reservationId","expectedVersion","reason"],assign_room:["reservationId","roomId","expectedVersion"],
  assign_reservation_room:["reservationId","roomId","expectedVersion"],move_reservation_room:["reservationId","roomId","moveDate","reason","expectedVersion"],unassign_reservation_room:["reservationId","expectedVersion"],
  move_room:["reservationId","roomId","expectedVersion","reason"],mark_no_show:["reservationId"],check_in:["reservationId"],check_out:["reservationId"],
  create_room_type:["code","name","baseRate","capacity"],update_room_type:["roomTypeId","code","name","baseRate","capacity","expectedVersion"],
  create_room:["roomTypeId","number","floor"],update_room:["roomId","roomTypeId","number","floor","expectedVersion"],bulk_create_rooms:["roomTypeId","startNumber","count","floor"],
  update_inventory_control:["roomTypeId","stayDate"],bulk_update_inventory_controls:["roomTypeIds","from","to"],
  upsert_rate_plan:["code","name","currency","pricingModel","mealPlan","packageType","baseOccupancy","maxOccupancy"],
  bulk_update_rate_blocks:["mappingIds","from","to","weekdays","allocation","sellRate","closed","minStay","cta","ctd"],
  create_account_profile:["name","type"],create_business_block:["name","arrivalDate","departureDate"],
  update_block_inventory:["blockId","roomTypeId","stayDate"],add_rooming_entry:["blockId","firstName","lastName","arrivalDate","departureDate","roomTypeId"],
  pickup_rooming_entry:["entryId"],cutoff_block:["blockId"],post_payment:["reservationId","amount"],post_charge:["reservationId","amount"],
  upsert_banquet_venue:["code","name","capacity"],
  upsert_banquet_reservation:["venueId","eventDate","startTime","endTime","eventName","contactName","attendees","fee"],
  set_banquet_reservation_status:["banquetReservationId","status","expectedVersion"],
  create_folio_window:["reservationId"],create_routing_rule:["reservationId","windowId","code"],split_folio_entry:["entryId","targetWindowId","amount"],
  reverse_folio_entry:["entryId","reason"],refund_payment:["entryId","amount","reason"],transfer_to_ar:["windowId","accountProfileId","dueDate"],post_ar_payment:["invoiceId","amount"],
  housekeeping:["roomId"],open_cashier:["openingAmount"],close_cashier:["countedAmount"],
  create_channel_connection:["provider","externalPropertyId","name"],create_channel_mapping:["connectionId","roomTypeId","externalRoomTypeId","ratePlan","externalRatePlanId"],
  queue_ari_delta:["mappingId","startDate","endDate"],dispatch_ari_update:["updateId"],
  ingest_channel_message:["connectionId","messageId","eventType","externalReservationId","revision"],replay_channel_message:["messageId"],dispatch_outbox_event:["eventId"],
  upsert_channel_catalog:["providerCode","displayName","channelClass","integrationMode","sortOrder"],
  configure_property_channel:["catalogId","active","sortOrder","supplierConfig","salesCutoffDays"],set_property_channel_active:["settingId","active","expectedVersion"],reorder_property_channels:["settingIds"],delete_property_channel:["settingId"],
  upsert_channel_product_cutoff:["settingId","ratePlanId","cutoffDays","cutoffTime","active"],delete_channel_product_cutoff:["cutoffId"],
  update_room_type_website:["roomTypeId"],upload_website_media:["dataUrl","filename","scope"],delete_website_media:["mediaId"],
  upsert_channel_contract:["connectionId","contractType","validFrom"],post_accounting_entry:["businessDate","description","debitAccountId","creditAccountId","amount"],
  reverse_accounting_entry:["entryId","reason"],accrue_channel_settlement:["connectionId","reservationId"],mark_channel_settlement_paid:["settlementId"],restore_channel_settlement_payment:["settlementId","reason"],
  export_report:["report"],
  create_staff_user:["email","displayName","password","role","workspacePermissions","canExport"],
  update_staff_access:["assignmentId","displayName","role","workspacePermissions","canExport","expectedVersion"],
  set_staff_active:["assignmentId","active","expectedVersion"],
  reset_staff_password:["assignmentId","password","expectedVersion"],
  upsert_hotel_member:["memberNo","memberType","name","grade","administratorType","joinedDate"],
  set_hotel_member_active:["memberId","active","expectedVersion"],
  reset_hotel_member_password:["memberId","password","expectedVersion"],
  upsert_property_season:["name","seasonType","startDate","endDate","adjustmentType","adjustment","active"],delete_property_season:["seasonId"],
  upsert_property_holiday:["name","stayDate","holidayType","active"],delete_property_holiday:["holidayId"],
  upsert_amenity_catalog:["code","name","category","sortOrder","active"],delete_amenity_catalog:["amenityId"],
  upsert_service_catalog:["code","name","category","pricingType","price","currency","sortOrder","active"],delete_service_catalog:["serviceId"],
};

const dateField=/^(?:arrivalDate|departureDate|stayDate|startDate|endDate|eventDate|joinedDate|businessDate|dueDate|depositDate|restoreDate|validFrom|validTo|from|to)$/u;
const isoDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/u,"YYYY-MM-DD 형식이 필요합니다.");
const scalar=z.union([z.string().trim().min(1).max(20_000),z.number().finite(),z.boolean()]);
function fieldSchema(field:string){
  // A decoded image is capped again at 3MB in the storage boundary. This larger
  // transport cap only accounts for base64 expansion and the data-URL prefix.
  if(field==="dataUrl")return z.string().min(32).max(4_200_000).regex(/^data:image\/(?:jpeg|png|webp);base64,/u,"지원하지 않는 이미지 형식입니다.");
  return dateField.test(field)?isoDate:scalar;
}

export type ActionRegistration = {
  action:PmsAction;
  capability:(typeof actionCapability)[PmsAction];
  domain:ActionDomain;
  schema:z.ZodType<Record<string,unknown>>;
};

export const actionRegistry = new Map<PmsAction,ActionRegistration>(
  (Object.keys(actionCapability) as PmsAction[]).map((action)=>{
    const shape:Record<string,z.ZodTypeAny>={action:z.literal(action)};
    for(const field of requiredFields[action]||[])shape[field]=fieldSchema(field);
    return [action,{action,capability:actionCapability[action],domain:domainByAction.get(action)!,schema:z.object(shape).passthrough()}];
  }),
);

export function registrationFor(value:unknown){
  return typeof value==="string"?actionRegistry.get(value as PmsAction):undefined;
}

export function validationMessage(error:z.ZodError){
  return error.issues.slice(0,5).map((issue)=>(issue.path.join(".")||"body")+": "+issue.message).join(", ");
}
