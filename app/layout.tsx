/** Root metadata, security nonce bridge, fonts and global visual system. */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { AuroraQueryProvider } from "./query-provider";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const h = await headers(); const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000"; const protocol = h.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https"); const image = `${protocol}://${host}/og.png`;
  return { title:"Aurora PMS — Hotel Operations", description:"예약부터 객실, 체크인, 폴리오, 하우스키핑, 야간감사까지 연결하는 차세대 호텔 운영 시스템", icons:{icon:[{url:"/brand/aurora-mark-64.png",type:"image/png",sizes:"64x64"}],apple:[{url:"/brand/aurora-mark-192.png",type:"image/png",sizes:"192x192"}]}, openGraph:{title:"AURORA PMS",description:"호텔 운영의 모든 순간을 하나로",images:[image]}, twitter:{card:"summary_large_image",title:"AURORA PMS",description:"호텔 운영의 모든 순간을 하나로",images:[image]} };
}
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
