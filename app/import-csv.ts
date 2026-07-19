/** Small RFC 4180-compatible parser used by the migration dry-run endpoint. */
export function parseCsv(input: string, maxRows = 2_000) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
        continue;
      }
      if (character === '"') {
        quoted = false;
        continue;
      }
      cell += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length > maxRows + 1)
        throw new Error(
          `CSV는 헤더를 제외하고 최대 ${maxRows.toLocaleString()}행까지 처리할 수 있습니다.`,
        );
      continue;
    }
    cell += character;
  }
  if (quoted) throw new Error("CSV 따옴표가 닫히지 않았습니다.");
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  if (rows.length < 2) throw new Error("CSV 헤더와 데이터 행이 필요합니다.");
  const headers = rows[0].map((value) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^\ufeff/u, "")
      .replace(/[\s-]+/gu, "_"),
  );
  if (
    headers.some(
      (header, index) => !header || headers.indexOf(header) !== index,
    )
  )
    throw new Error("CSV 헤더가 비어 있거나 중복되었습니다.");
  return rows.slice(1).map((values, index) => ({
    rowNumber: index + 2,
    data: Object.fromEntries(
      headers.map((header, column) => [header, (values[column] || "").trim()]),
    ),
  }));
}

export type ImportKind = "ROOM_TYPES" | "ROOMS" | "GUESTS" | "RESERVATIONS";

const requiredHeaders: Record<ImportKind, string[]> = {
  ROOM_TYPES: ["code", "name", "base_rate", "capacity"],
  ROOMS: ["number", "room_type_code", "floor"],
  GUESTS: ["external_id", "first_name", "last_name"],
  RESERVATIONS: [
    "external_id",
    "confirmation_no",
    "guest_external_id",
    "room_type_code",
    "arrival_date",
    "departure_date",
    "nightly_rate",
  ],
};

export function assertImportHeaders(
  kind: ImportKind,
  row: Record<string, string>,
) {
  const missing = requiredHeaders[kind].filter((header) => !(header in row));
  if (missing.length)
    throw new Error(`필수 헤더가 없습니다: ${missing.join(", ")}`);
}

export function normalizedImportRow(
  kind: ImportKind,
  data: Record<string, string>,
) {
  if (kind === "ROOM_TYPES")
    return {
      code: data.code?.toUpperCase(),
      name: data.name,
      base_rate: Number(data.base_rate),
      capacity: Number(data.capacity),
      description: (data.description || "").slice(0, 300),
    };
  if (kind === "ROOMS")
    return {
      number: data.number?.toUpperCase(),
      room_type_code: data.room_type_code?.toUpperCase(),
      floor: Number(data.floor),
      features: (data.features || "")
        .split("|")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 20),
    };
  if (kind === "GUESTS")
    return {
      external_id: data.external_id,
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email?.toLowerCase() || null,
      phone: data.phone || null,
      vip_level: (data.vip_level || "NONE").toUpperCase(),
      nationality: (data.nationality || "KR").toUpperCase(),
    };
  return {
    external_id: data.external_id,
    confirmation_no: data.confirmation_no?.toUpperCase(),
    guest_external_id: data.guest_external_id,
    room_type_code: data.room_type_code?.toUpperCase(),
    arrival_date: data.arrival_date,
    departure_date: data.departure_date,
    adults: Number(data.adults || 1),
    children: Number(data.children || 0),
    source: data.source || "Migration",
    rate_plan: (data.rate_plan || "BAR").toUpperCase(),
    nightly_rate: Number(data.nightly_rate),
    eta: data.eta || null,
    notes: (data.notes || "").slice(0, 1000),
  };
}

export function validateImportRow(
  kind: ImportKind,
  row: Record<string, unknown>,
) {
  const errors: string[] = [];
  const text = (key: string, max: number) => {
    const value = String(row[key] || "");
    if (!value || value.length > max)
      errors.push(`${key}: 1~${max}자가 필요합니다.`);
  };
  if (kind === "ROOM_TYPES") {
    text("code", 16);
    text("name", 120);
    if (!Number.isFinite(row.base_rate) || Number(row.base_rate) < 0)
      errors.push("base_rate: 0 이상의 금액이 필요합니다.");
    if (
      !Number.isInteger(row.capacity) ||
      Number(row.capacity) < 1 ||
      Number(row.capacity) > 20
    )
      errors.push("capacity: 1~20의 정수가 필요합니다.");
  } else if (kind === "ROOMS") {
    text("number", 16);
    text("room_type_code", 16);
    if (
      !Number.isInteger(row.floor) ||
      Number(row.floor) < -10 ||
      Number(row.floor) > 250
    )
      errors.push("floor: -10~250의 정수가 필요합니다.");
  } else if (kind === "GUESTS") {
    text("external_id", 120);
    text("first_name", 80);
    text("last_name", 80);
    if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(String(row.email)))
      errors.push("email: 형식이 올바르지 않습니다.");
    if (row.phone && !/^[0-9+() .-]{7,24}$/u.test(String(row.phone)))
      errors.push("phone: 형식이 올바르지 않습니다.");
  } else {
    for (const key of [
      "external_id",
      "confirmation_no",
      "guest_external_id",
      "room_type_code",
    ])
      text(key, key === "confirmation_no" ? 40 : 120);
    const arrival = String(row.arrival_date || ""),
      departure = String(row.departure_date || "");
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(arrival) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(departure) ||
      departure <= arrival
    )
      errors.push(
        "arrival_date/departure_date: 출발일이 도착일보다 늦어야 합니다.",
      );
    if (
      !Number.isInteger(row.adults) ||
      Number(row.adults) < 1 ||
      Number(row.adults) > 20 ||
      !Number.isInteger(row.children) ||
      Number(row.children) < 0 ||
      Number(row.children) > 20
    )
      errors.push("adults/children: 허용 범위를 확인하세요.");
    if (!Number.isFinite(row.nightly_rate) || Number(row.nightly_rate) < 0)
      errors.push("nightly_rate: 0 이상의 금액이 필요합니다.");
  }
  return errors;
}
