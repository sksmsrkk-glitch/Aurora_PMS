import type { Metadata } from "next";
import PlatformConsole from "./platform-console";

export const metadata: Metadata = {
  title: "멀티호텔 관리 | Talos PMS",
  robots: { index: false, follow: false },
};

/** Dedicated organization/property control plane outside operational routes. */
export default function PlatformPage() {
  return <PlatformConsole />;
}
