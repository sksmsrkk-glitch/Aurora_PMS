/** Root metadata, security nonce bridge, fonts and global visual system. */
import type { Metadata } from "next";
import { AuroraQueryProvider } from "./query-provider";
import { publicSiteUrl } from "./hotel/seo";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: publicSiteUrl(),
  title:"Aurora PMS — Hotel Operations",
  description:"예약부터 객실, 체크인, 폴리오, 하우스키핑, 야간감사까지 연결하는 차세대 호텔 운영 시스템",
  icons:{icon:[{url:"/brand/aurora-mark-64.png",type:"image/png",sizes:"64x64"}],apple:[{url:"/brand/aurora-mark-192.png",type:"image/png",sizes:"192x192"}]},
  openGraph:{title:"AURORA PMS",description:"호텔 운영의 모든 순간을 하나로",images:["/og.png"]},
  twitter:{card:"summary_large_image",title:"AURORA PMS",description:"호텔 운영의 모든 순간을 하나로",images:["/og.png"]},
};
export default function RootLayout({children}:{children:React.ReactNode}) {
  return (
    <html lang="ko">
      <head>
        <link rel="preconnect" href="https://static.toss.im" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://static.toss.im/tps/main.css" />
      </head>
      <body><AuroraQueryProvider>{children}</AuroraQueryProvider></body>
    </html>
  );
}
