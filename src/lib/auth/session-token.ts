import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE_NAME = "origin_session";

export type SessionJwtPayload = {
  sub: string;
  oid: string;
  role: "admin" | "player";
};

function secretKey() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error("SESSION_SECRET must be set (min 16 chars) for auth.");
  }
  return new TextEncoder().encode(s);
}

export async function signSessionToken(payload: SessionJwtPayload): Promise<string> {
  return new SignJWT({ oid: payload.oid, role: payload.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<SessionJwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    const oid = typeof payload.oid === "string" ? payload.oid : null;
    const role = payload.role === "admin" || payload.role === "player" ? payload.role : null;
    if (!sub || !oid || !role) return null;
    return { sub, oid, role };
  } catch {
    return null;
  }
}
