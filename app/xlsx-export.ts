"use client";

/** Browser download wrapper around the server-safe OpenXML workbook builder. */
import { buildReportWorkbook, safeSheetName, type ExportReport } from "../lib/xlsx-workbook";
export { buildReportWorkbook, type ExportColumn, type ExportReport } from "../lib/xlsx-workbook";

export function downloadReportWorkbook(report:ExportReport){
  const bytes=buildReportWorkbook(report),buffer=new Uint8Array(bytes).buffer,blob=new Blob([buffer],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}),url=URL.createObjectURL(blob),anchor=document.createElement("a");
  anchor.href=url;anchor.download=`Talos_${safeSheetName(report.title).replaceAll(" ","_")}_${report.filters.from||new Date().toISOString().slice(0,10)}.xlsx`;document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
