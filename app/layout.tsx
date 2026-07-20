/** Minimal document root shared by the isolated PMS and public hotel layouts. */
import type { Metadata } from "next";
import { publicSiteUrl } from "./hotel/seo";
import "./company-footer.css";

export const metadata: Metadata = {
  metadataBase: publicSiteUrl(),
  title:"Talos PMS — Hotel Operations",
  description:"예약부터 객실, 체크인, 폴리오, 하우스키핑, 야간감사까지 연결하는 차세대 호텔 운영 시스템",
  openGraph:{title:"Talos PMS",description:"호텔 운영의 모든 순간을 하나로"},
  twitter:{card:"summary",title:"Talos PMS",description:"호텔 운영의 모든 순간을 하나로"},
};
export default function RootLayout({children}:{children:React.ReactNode}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
