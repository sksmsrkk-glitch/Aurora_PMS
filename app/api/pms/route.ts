/** Thin Next.js PMS transport: read projection selection plus command delegation. */
import { getPmsDatabase, scopePmsDatabase } from "../../../db/pms-database";
import { ReportRequestError } from "./reporting";
import {
  loadAccountingCenter,
  loadInventoryCalendar,
  loadWebsiteAdmin,
  PmsExtendedError,
} from "./extended";
import {
  principalAccessFailureResponse,
  principalFor,
  ready,
  runtimeBindings,
} from "./auth";
import {
  cachedCoreSnapshotResponse,
  cachedReport,
  cachedSnapshotResponse,
  workspaceProjection,
  type WorkspaceProjection,
} from "./read-model";
import { handlePmsPost } from "./command-gateway";
import { schemaNotReadyResponse } from "../../../db/schema-contract";
import { canViewWorkspace } from "../../access-control";
import { PMS_WORKSPACES, type PmsWorkspace } from "../../pms-workspaces";
import { loadStaffUsers } from "./staff";
import { scheduleDurableWorkerKick } from "../../worker-kick";
import {
  loadFrontdesk,
  loadPmsSearch,
  loadReservationAvailability,
  loadReservationCalendar,
  loadReservationDetail,
  PmsReadError,
} from "./frontdesk-read";
import { loadReservationVoucher } from "./voucher-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  // All read models pass through authentication and the property-scoped adapter.
  // `view` selects a bounded projection; no branch accepts a raw table or SQL name.
  const rootDb = getPmsDatabase(runtimeBindings);
  try {
    await ready(rootDb);
  } catch (error) {
    const response = schemaNotReadyResponse(error);
    if (response) return response;
    throw error;
  }
  const principal = await principalFor(request, rootDb);
  if (!principal) return principalAccessFailureResponse(request);
  if (principal.principalType === "SUPPORT") {
    if (!principal.supportGrantId || !principal.authUserId)
      return Response.json(
        { error: "지원 세션이 만료되었습니다." },
        { status: 403 },
      );
    const audited = await rootDb.recordSupportAccess({
      grantId: principal.supportGrantId,
      authUserId: principal.authUserId,
      actorEmail: principal.email,
      write: false,
      requestId: crypto.randomUUID(),
      action: `GET:${new URL(request.url).searchParams.get("view") || "full"}`,
    });
    if (!audited)
      return Response.json(
        { error: "지원 권한이 만료되었거나 회수되었습니다." },
        { status: 403 },
      );
  }
  if (principal.mustChangePassword)
    return Response.json(
      {
        error: "임시 비밀번호를 먼저 변경해 주세요.",
        code: "PASSWORD_CHANGE_REQUIRED",
      },
      { status: 428 },
    );
  if (!principal.capabilities.includes("READ"))
    return Response.json(
      { error: "이 호텔에 부여된 활성 페이지 권한이 없습니다." },
      { status: 403 },
    );
  const db = scopePmsDatabase(rootDb, principal.propertyId);
  const url = new URL(request.url);
  const view = url.searchParams.get("view");
  if (view === "search") {
    const maySearch =
      canViewWorkspace(principal.workspaceAccess, "frontdesk") ||
      canViewWorkspace(principal.workspaceAccess, "rooms") ||
      canViewWorkspace(principal.workspaceAccess, "finance");
    if (!maySearch)
      return Response.json(
        { error: "통합 검색 권한이 없습니다." },
        { status: 403 },
      );
    try {
      return Response.json(await loadPmsSearch(db, url.searchParams, principal), {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      console.error("PMS global search failed", error);
      return Response.json(
        { error: "통합 검색을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요." },
        { status: 500, headers: { "Cache-Control": "private, no-store" } },
      );
    }
  }
  if (view === "frontdesk") {
    if (!canViewWorkspace(principal.workspaceAccess, "frontdesk"))
      return Response.json(
        { error: "프런트 데스크 조회 권한이 없습니다." },
        { status: 403 },
      );
    try {
      return Response.json(
        await loadFrontdesk(db, url.searchParams, principal),
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      if (error instanceof PmsReadError)
        return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }
  if (view === "reservation_availability") {
    if (!canViewWorkspace(principal.workspaceAccess, "frontdesk"))
      return Response.json(
        { error: "예약 가용성 조회 권한이 없습니다." },
        { status: 403 },
      );
    try {
      return Response.json(
        await loadReservationAvailability(db, url.searchParams),
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      if (error instanceof PmsReadError)
        return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }
  if (view === "reservation_calendar") {
    if (!canViewWorkspace(principal.workspaceAccess, "frontdesk"))
      return Response.json(
        { error: "예약 가용성 조회 권한이 없습니다." },
        { status: 403 },
      );
    try {
      return Response.json(
        await loadReservationCalendar(db, url.searchParams),
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      if (error instanceof PmsReadError)
        return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }
  if (view === "reservation_detail") {
    if (!canViewWorkspace(principal.workspaceAccess, "frontdesk"))
      return Response.json(
        { error: "예약 상세 조회 권한이 없습니다." },
        { status: 403 },
      );
    try {
      return Response.json(
        await loadReservationDetail(
          db,
          url.searchParams.get("reservationId") || "",
          principal,
        ),
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      if (error instanceof PmsReadError)
        return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }
  if (view === "reservation_voucher") {
    if (!canViewWorkspace(principal.workspaceAccess, "frontdesk"))
      return Response.json({ error: "예약 확인서 조회 권한이 없습니다." }, { status: 403 });
    const format=url.searchParams.get("format")||"json";
    if(!["json","pdf","xlsx","html"].includes(format))return Response.json({error:"지원하지 않는 확인서 형식입니다."},{status:400});
    if(format!=="json"&&!principal.canExport)return Response.json({error:"파일 출력 권한이 없습니다."},{status:403});
    try {
      const voucher=await loadReservationVoucher(db,url.searchParams.get("reservationId")||"",url.searchParams,principal);
      if(format==="json")return Response.json(voucher,{headers:{"Cache-Control":"private, no-store"}});
      // PDF/font and ZIP libraries stay out of the common PMS read bundle and
      // are loaded only after an authorized document request reaches this branch.
      const documents=await import("./voucher-document");
      if(format==="html")return new Response(documents.renderVoucherHtml(voucher,true),{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"private, no-store","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
      const bytes=format==="pdf"?await documents.buildVoucherPdf(voucher):documents.buildVoucherWorkbook(voucher),filename=documents.voucherFilename(voucher,format),responseBody=Uint8Array.from(bytes).buffer;
      return new Response(responseBody,{headers:{"Content-Type":format==="pdf"?"application/pdf":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":`attachment; filename="${filename}"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
    } catch (error) {
      if (error instanceof PmsReadError) return Response.json({error:error.message},{status:error.status});
      throw error;
    }
  }
  if (view === "core")
    return cachedCoreSnapshotResponse(db, principal, request);
  if (view === "groups" || view === "finance" || view === "channels") {
    const allowed =
      view === "finance"
        ? canViewWorkspace(principal.workspaceAccess, "finance") ||
          canViewWorkspace(principal.workspaceAccess, "revenue")
        : canViewWorkspace(principal.workspaceAccess, view);
    if (!allowed)
      return Response.json(
        { error: "이 페이지를 조회할 권한이 없습니다." },
        { status: 403 },
      );
    return Response.json(
      await workspaceProjection(db, view as WorkspaceProjection),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
  if (url.searchParams.get("view") === "inventory") {
    if (!canViewWorkspace(principal.workspaceAccess, "inventory"))
      return Response.json(
        { error: "재고 페이지를 조회할 권한이 없습니다." },
        { status: 403 },
      );
    try {
      const property = await db
          .prepare(
            "SELECT business_date FROM properties WHERE id=pms_current_property_id()",
          )
          .first<{ business_date: string }>(),
        from = url.searchParams.get("from") || String(property?.business_date),
        to = url.searchParams.get("to") || String(property?.business_date);
      return Response.json(
        await loadInventoryCalendar(db, from, to, principal.propertyId),
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      if (error instanceof PmsExtendedError)
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      throw error;
    }
  }
  if (url.searchParams.get("view") === "accounting") {
    if (!canViewWorkspace(principal.workspaceAccess, "accounting"))
      return Response.json(
        { error: "회계 페이지를 조회할 권한이 없습니다." },
        { status: 403 },
      );
    try {
      const property = await db
          .prepare(
            "SELECT business_date FROM properties WHERE id=pms_current_property_id()",
          )
          .first<{ business_date: string }>(),
        from = url.searchParams.get("from") || String(property?.business_date),
        to = url.searchParams.get("to") || String(property?.business_date);
      return Response.json(
        await loadAccountingCenter(db, from, to, principal.propertyId),
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      if (error instanceof PmsExtendedError)
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      throw error;
    }
  }
  if (url.searchParams.get("view") === "website") {
    if (!canViewWorkspace(principal.workspaceAccess, "website"))
      return Response.json(
        { error: "홈페이지 관리 권한이 없습니다." },
        { status: 403 },
      );
    try {
      return Response.json(await loadWebsiteAdmin(db, principal.propertyId), {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      if (error instanceof PmsExtendedError)
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      throw error;
    }
  }
  if (url.searchParams.get("view") === "report") {
    if (!canViewWorkspace(principal.workspaceAccess, "reports"))
      return Response.json(
        { error: "리포트 조회 권한이 없습니다." },
        { status: 403 },
      );
    try {
      return Response.json(
        await cachedReport(db, url.searchParams, principal),
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      if (error instanceof ReportRequestError)
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      throw error;
    }
  }
  if (view === "users") {
    if (!canViewWorkspace(principal.workspaceAccess, "users"))
      return Response.json(
        { error: "직원 및 권한 관리 페이지를 조회할 권한이 없습니다." },
        { status: 403 },
      );
    return Response.json(await loadStaffUsers(db, principal), {
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const fullSnapshotAllowed = PMS_WORKSPACES.filter(
    (workspace): workspace is PmsWorkspace => workspace !== "users",
  ).every((workspace) =>
    canViewWorkspace(principal.workspaceAccess, workspace),
  );
  if (!fullSnapshotAllowed)
    return Response.json(
      { error: "전체 데이터 스냅샷을 조회할 권한이 없습니다." },
      { status: 403 },
    );
  return cachedSnapshotResponse(db, principal, request);
}

export async function POST(request: Request) {
  const response = await handlePmsPost(request);
  if (response.ok) scheduleDurableWorkerKick();
  return response;
}
