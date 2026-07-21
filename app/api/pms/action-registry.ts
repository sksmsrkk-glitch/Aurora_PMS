/** Zod-validated PMS action registry: capability, domain, and input contract. */
import { z } from "zod";

export type ActionDomain =
  | "reservation" | "rooms" | "inventory" | "groups" | "finance"
  | "integrations" | "accounting" | "website" | "operations" | "reports" | "users";

const actionCapability = {
  create_reservation:"RESERVATION_WRITE",edit_reservation:"RESERVATION_WRITE",update_reservation_detail:"RESERVATION_WRITE",link_reservation:"RESERVATION_WRITE",queue_reservation_voucher:"RESERVATION_WRITE",cancel_reservation:"RESERVATION_WRITE",assign_room:"RESERVATION_WRITE",
  mark_no_show:"STAY_WRITE",check_in:"STAY_WRITE",check_out:"STAY_WRITE",move_room:"STAY_WRITE",
  update_inventory_control:"INVENTORY_WRITE",bulk_update_inventory_controls:"INVENTORY_WRITE",upsert_rate_plan:"INVENTORY_WRITE",
  create_account_profile:"GROUP_WRITE",create_business_block:"GROUP_WRITE",update_block_inventory:"GROUP_WRITE",add_rooming_entry:"GROUP_WRITE",cutoff_block:"GROUP_WRITE",pickup_rooming_entry:"GROUP_PICKUP",
  post_payment:"FOLIO_WRITE",post_charge:"FOLIO_WRITE",create_folio_window:"FOLIO_WRITE",create_routing_rule:"FOLIO_WRITE",split_folio_entry:"FOLIO_WRITE",reverse_folio_entry:"FOLIO_WRITE",refund_payment:"FOLIO_WRITE",
  transfer_to_ar:"AR_WRITE",post_ar_payment:"AR_WRITE",housekeeping:"HOUSEKEEPING_WRITE",
  create_channel_connection:"INTEGRATION_WRITE",create_channel_mapping:"INTEGRATION_WRITE",upsert_channel_contract:"INTEGRATION_WRITE",queue_ari_delta:"INTEGRATION_WRITE",dispatch_ari_update:"INTEGRATION_WRITE",ingest_channel_message:"INTEGRATION_WRITE",replay_channel_message:"INTEGRATION_WRITE",dispatch_outbox_event:"INTEGRATION_WRITE",
  post_accounting_entry:"ACCOUNTING_WRITE",reverse_accounting_entry:"ACCOUNTING_WRITE",accrue_channel_settlement:"ACCOUNTING_WRITE",mark_channel_settlement_paid:"ACCOUNTING_WRITE",
  open_cashier:"CASHIER_WRITE",close_cashier:"CASHIER_WRITE",run_night_audit:"EOD_RUN",
  create_room_type:"MASTER_WRITE",update_room_type:"MASTER_WRITE",create_room:"MASTER_WRITE",update_room:"MASTER_WRITE",bulk_create_rooms:"MASTER_WRITE",
  update_website_settings:"WEBSITE_WRITE",update_room_type_website:"WEBSITE_WRITE",upload_website_media:"WEBSITE_WRITE",delete_website_media:"WEBSITE_WRITE",
  create_staff_user:"USER_ADMIN",update_staff_access:"USER_ADMIN",set_staff_active:"USER_ADMIN",reset_staff_password:"USER_ADMIN",
  export_report:"REPORT_EXPORT",
} as const;

export type PmsAction = keyof typeof actionCapability;

const domainActions: Record<ActionDomain, readonly PmsAction[]> = {
  reservation:["create_reservation","edit_reservation","update_reservation_detail","link_reservation","queue_reservation_voucher","cancel_reservation","assign_room","mark_no_show","check_in","check_out","move_room"],
  rooms:["create_room_type","update_room_type","create_room","update_room","bulk_create_rooms","housekeeping"],
  inventory:["update_inventory_control","bulk_update_inventory_controls","upsert_rate_plan"],
  groups:["create_account_profile","create_business_block","update_block_inventory","add_rooming_entry","cutoff_block","pickup_rooming_entry"],
  finance:["post_payment","post_charge","create_folio_window","create_routing_rule","split_folio_entry","reverse_folio_entry","refund_payment","transfer_to_ar","post_ar_payment"],
  integrations:["create_channel_connection","create_channel_mapping","upsert_channel_contract","queue_ari_delta","dispatch_ari_update","ingest_channel_message","replay_channel_message","dispatch_outbox_event"],
  accounting:["post_accounting_entry","reverse_accounting_entry","accrue_channel_settlement","mark_channel_settlement_paid"],
  website:["update_website_settings","update_room_type_website","upload_website_media","delete_website_media"],
  operations:["open_cashier","close_cashier","run_night_audit"],
  reports:["export_report"],
  users:["create_staff_user","update_staff_access","set_staff_active","reset_staff_password"],
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
  move_room:["reservationId","roomId","expectedVersion","reason"],mark_no_show:["reservationId"],check_in:["reservationId"],check_out:["reservationId"],
  create_room_type:["code","name","baseRate","capacity"],update_room_type:["roomTypeId","code","name","baseRate","capacity","expectedVersion"],
  create_room:["roomTypeId","number","floor"],update_room:["roomId","roomTypeId","number","floor","expectedVersion"],bulk_create_rooms:["roomTypeId","startNumber","count","floor"],
  update_inventory_control:["roomTypeId","stayDate"],bulk_update_inventory_controls:["roomTypeIds","from","to"],
  upsert_rate_plan:["code","name","currency","pricingModel","mealPlan","packageType","baseOccupancy","maxOccupancy"],
  create_account_profile:["name","type"],create_business_block:["name","arrivalDate","departureDate"],
  update_block_inventory:["blockId","roomTypeId","stayDate"],add_rooming_entry:["blockId","firstName","lastName","arrivalDate","departureDate","roomTypeId"],
  pickup_rooming_entry:["entryId"],cutoff_block:["blockId"],post_payment:["reservationId","amount"],post_charge:["reservationId","amount"],
  create_folio_window:["reservationId"],create_routing_rule:["reservationId","windowId","code"],split_folio_entry:["entryId","targetWindowId","amount"],
  reverse_folio_entry:["entryId","reason"],refund_payment:["entryId","amount","reason"],transfer_to_ar:["windowId","accountProfileId","dueDate"],post_ar_payment:["invoiceId","amount"],
  housekeeping:["roomId"],open_cashier:["openingAmount"],close_cashier:["countedAmount"],
  create_channel_connection:["provider","externalPropertyId","name"],create_channel_mapping:["connectionId","roomTypeId","externalRoomTypeId","ratePlan","externalRatePlanId"],
  queue_ari_delta:["mappingId","startDate","endDate"],dispatch_ari_update:["updateId"],
  ingest_channel_message:["connectionId","messageId","eventType","externalReservationId","revision"],replay_channel_message:["messageId"],dispatch_outbox_event:["eventId"],
  update_room_type_website:["roomTypeId"],upload_website_media:["dataUrl","filename","scope"],delete_website_media:["mediaId"],
  upsert_channel_contract:["connectionId","contractType","validFrom"],post_accounting_entry:["businessDate","description","debitAccountId","creditAccountId","amount"],
  reverse_accounting_entry:["entryId","reason"],accrue_channel_settlement:["connectionId","reservationId"],mark_channel_settlement_paid:["settlementId"],
  export_report:["report"],
  create_staff_user:["email","displayName","password","role","workspacePermissions","canExport"],
  update_staff_access:["assignmentId","displayName","role","workspacePermissions","canExport","expectedVersion"],
  set_staff_active:["assignmentId","active","expectedVersion"],
  reset_staff_password:["assignmentId","password","expectedVersion"],
};

const dateField=/^(?:arrivalDate|departureDate|stayDate|startDate|endDate|businessDate|dueDate|validFrom|validTo|from|to)$/u;
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
