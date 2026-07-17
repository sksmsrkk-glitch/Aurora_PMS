/** Back-office-only fonts, styles, and query cache boundary. */
import { AuroraQueryProvider } from "../query-provider";
import "../globals.css";

export default function PmsLayout({ children }: { children: React.ReactNode }) {
  return <>
    <link rel="preconnect" href="https://static.toss.im" crossOrigin="anonymous" />
    <link rel="stylesheet" href="https://static.toss.im/tps/main.css" />
    <AuroraQueryProvider>{children}</AuroraQueryProvider>
  </>;
}
