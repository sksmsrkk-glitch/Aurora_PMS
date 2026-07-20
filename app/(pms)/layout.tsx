/** Back-office-only fonts, styles, and query cache boundary. */
import { TalosQueryProvider } from "../query-provider";
import "../globals.css";
import PmsFrame from "./_components/pms-frame";

export default function PmsLayout({ children }: { children: React.ReactNode }) {
  return <>
    <link rel="preconnect" href="https://static.toss.im" crossOrigin="anonymous" />
    <link rel="stylesheet" href="https://static.toss.im/tps/main.css" />
    <TalosQueryProvider><PmsFrame>{children}</PmsFrame></TalosQueryProvider>
  </>;
}
