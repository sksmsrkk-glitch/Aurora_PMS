"use client";

/** Dependency-light OpenXML workbook generator for audited report exports. */

import { strToU8, zipSync } from "fflate";

export type ExportColumn={key:string;label:string;type?:string};
export type ExportReport={title:string;generatedAt:string;filters:Record<string,string>;columns:ExportColumn[];rows:Array<Record<string,unknown>>;summary:Array<{label:string;value:string|number;format?:string}>;exportId?:string};
type Cell={value:unknown;style?:number};

const xml=(value:unknown)=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
const columnName=(index:number)=>{let value=index+1,name="";while(value){value--;name=String.fromCharCode(65+(value%26))+name;value=Math.floor(value/26);}return name;};
const safeSheetName=(value:string)=>value.replace(/[\\/?*:[\]]/g," ").slice(0,31)||"Report";

function cellXml(cell:Cell,row:number,column:number){
  const ref=`${columnName(column)}${row}`,style=cell.style?` s="${cell.style}"`:"",value=cell.value;
  if(typeof value==="number"&&Number.isFinite(value))return `<c r="${ref}"${style} t="n"><v>${value}</v></c>`;
  if(typeof value==="boolean")return `<c r="${ref}"${style} t="b"><v>${value?1:0}</v></c>`;
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(Array.isArray(value)?value.join(", "):value)}</t></is></c>`;
}

function worksheet(rows:Cell[][],freeze=true,filter=true){
  const maxColumns=Math.max(1,...rows.map(row=>row.length)),last=`${columnName(maxColumns-1)}${Math.max(1,rows.length)}`;
  const widths=Array.from({length:maxColumns},(_,column)=>Math.min(48,Math.max(10,...rows.slice(0,200).map(row=>String(row[column]?.value??"").length+2))));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0">${freeze?'<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>':''}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${widths.map((width,index)=>`<col min="${index+1}" max="${index+1}" width="${width}" customWidth="1"/>`).join("")}</cols><sheetData>${rows.map((row,index)=>`<row r="${index+1}"${index===0?' ht="24" customHeight="1"':''}>${row.map((cell,column)=>cellXml(cell,index+1,column)).join("")}</row>`).join("")}</sheetData>${filter&&rows.length>1?`<autoFilter ref="A1:${columnName(maxColumns-1)}${rows.length}"/>`:""}</worksheet>`;
}

export function buildReportWorkbook(report:ExportReport){
  const parameters:Cell[][]=[
    [{value:"Aurora PMS 리포트 내보내기",style:1},{value:"",style:1}],
    [{value:"리포트"},{value:report.title}],
    [{value:"생성 시각"},{value:report.generatedAt}],
    [{value:"내보내기 ID"},{value:report.exportId||""}],
    ...Object.entries(report.filters).map(([key,value])=>[{value:key},{value:value||"전체"}]),
    [{value:"결과 행 수"},{value:report.rows.length,style:3}],
    [],
    [{value:"요약",style:1},{value:"값",style:1}],
    ...report.summary.map(item=>[{value:item.label},{value:item.value,style:item.format==="currency"?2:item.format==="percent"?4:3}]),
  ];
  const data:Cell[][]=[report.columns.map(column=>({value:column.label,style:1})),...report.rows.map(row=>report.columns.map(column=>({value:row[column.key]??"",style:column.type==="currency"?2:column.type==="percent"?4:column.type==="number"?3:0})))];
  const sheetNames=["Parameters",safeSheetName(report.title)];
  const files:Record<string,Uint8Array>={
    "[Content_Types].xml":strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${sheetNames.map((_,index)=>`<Override PartName="/xl/worksheets/sheet${index+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
    "_rels/.rels":strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`),
    "docProps/core.xml":strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(report.title)}</dc:title><dc:creator>Aurora PMS</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`),
    "docProps/app.xml":strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Aurora PMS</Application><Company>Aurora Hotel</Company></Properties>`),
    "xl/workbook.xml":strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheetNames.map((name,index)=>`<sheet name="${xml(name)}" sheetId="${index+1}" r:id="rId${index+1}"/>`).join("")}</sheets><calcPr calcId="191029"/></workbook>`),
    "xl/_rels/workbook.xml.rels":strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetNames.map((_,index)=>`<Relationship Id="rId${index+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index+1}.xml"/>`).join("")}<Relationship Id="rId${sheetNames.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml":strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.00\&quot;%\&quot;"/></numFmts><fonts count="2"><font><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos Display"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF103B32"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
    "xl/worksheets/sheet1.xml":strToU8(worksheet(parameters,false,false)),
    "xl/worksheets/sheet2.xml":strToU8(worksheet(data,true,true)),
  };
  return zipSync(files,{level:6});
}

export function downloadReportWorkbook(report:ExportReport){
  const bytes=buildReportWorkbook(report),buffer=new Uint8Array(bytes).buffer;const blob=new Blob([buffer],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}),url=URL.createObjectURL(blob),anchor=document.createElement("a");anchor.href=url;anchor.download=`Aurora_${safeSheetName(report.title).replaceAll(" ","_")}_${report.filters.from||new Date().toISOString().slice(0,10)}.xlsx`;document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
