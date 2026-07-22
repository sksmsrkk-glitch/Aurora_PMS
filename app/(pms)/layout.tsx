/** Back-office-only fonts, styles, and query cache boundary. */
import { Suspense } from "react";
import { TalosQueryProvider } from "../query-provider";
import "../globals.css";
import PmsFrame from "./_components/pms-frame";

export default function PmsLayout({ children }: { children: React.ReactNode }) {
  return <>
    <link rel="preconnect" href="https://static.toss.im" crossOrigin="anonymous" />
    <link rel="stylesheet" href="https://static.toss.im/tps/main.css" />
    <TalosQueryProvider>
      <Suspense fallback={<main className="loading"><div className="loading-wordmark talos-wordmark">TALOS PMS</div><p>운영 화면을 준비하고 있습니다</p></main>}>
        <PmsFrame>{children}</PmsFrame>
      </Suspense>
    </TalosQueryProvider>
  </>;
}
