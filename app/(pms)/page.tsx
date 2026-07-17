import { redirect } from "next/navigation";

/** The bare product URL always resolves to the canonical operations workspace. */
export default function HomePage() {
  redirect("/overview");
}
