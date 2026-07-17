/** Deterministic operational guidance derived only from the current PMS facts. */
type ArrivalFact = {
  arrival_date: string;
  status: string;
  eta: string | null;
  room_number: string | null;
};

type RoomFact = { housekeeping_status: string };

export type DashboardInsight = {
  message: string;
  workspace: "frontdesk" | "rooms";
  actionLabel: string;
};

export function dashboardInsight(
  reservations: ArrivalFact[],
  rooms: RoomFact[],
  businessDate: string,
): DashboardInsight {
  const arrivals = reservations.filter(
    (reservation) => reservation.arrival_date === businessDate && reservation.status === "DUE_IN",
  );
  const unassigned = arrivals.filter((reservation) => !reservation.room_number).length;
  const dirty = rooms.filter((room) => room.housekeeping_status === "DIRTY").length;
  const etaHours = arrivals
    .map((reservation) => Number.parseInt(reservation.eta?.slice(0, 2) || "", 10))
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);

  let peakStart: number | null = null;
  let peakCount = 0;
  for (let start = 0; start <= 22; start += 1) {
    const count = etaHours.filter((hour) => hour >= start && hour < start + 2).length;
    if (count > peakCount) {
      peakStart = start;
      peakCount = count;
    }
  }

  if (!arrivals.length) {
    return {
      message: "오늘 도착 예정 예약이 없습니다. 객실 준비 상태를 정기적으로 확인해 주세요.",
      workspace: dirty > 0 ? "rooms" : "frontdesk",
      actionLabel: dirty > 0 ? "객실 준비 보기" : "예약 현황 보기",
    };
  }

  const facts = [`오늘 도착 ${arrivals.length}건 중 미배정 ${unassigned}건입니다.`];
  if (peakStart !== null && peakCount > 0) {
    facts.push(`${String(peakStart).padStart(2, "0")}:00–${String(peakStart + 2).padStart(2, "0")}:00 도착 예정이 ${peakCount}건으로 가장 많습니다.`);
  }
  if (dirty > 0) facts.push(`청소 필요 객실 ${dirty}실을 함께 확인해 주세요.`);
  return {
    message: facts.join(" "),
    workspace: dirty > 0 || unassigned > 0 ? "rooms" : "frontdesk",
    actionLabel: dirty > 0 || unassigned > 0 ? "객실 준비 보기" : "도착 예약 보기",
  };
}
