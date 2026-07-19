/** HttpOnly active-property preference; authorization still verifies membership. */
import { cookies } from "next/headers";

const PROPERTY_COOKIE = "aurora-pms-property";
const PROPERTY_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export function selectedPropertyFromRequest(request: Request) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== PROPERTY_COOKIE) continue;
    try {
      const decoded = decodeURIComponent(value.join("="));
      return PROPERTY_ID.test(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function rememberSelectedProperty(propertyId: string) {
  if (!PROPERTY_ID.test(propertyId))
    throw new Error("Invalid property selection");
  (await cookies()).set(PROPERTY_COOKIE, propertyId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function clearSelectedProperty() {
  (await cookies()).set(PROPERTY_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
