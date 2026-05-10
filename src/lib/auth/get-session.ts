import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken, type SessionJwtPayload } from "./session-token";

export async function getSessionFromCookies(): Promise<SessionJwtPayload | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return null;
  return verifySessionToken(raw);
}
