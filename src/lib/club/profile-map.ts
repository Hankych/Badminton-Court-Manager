import type { Role, User } from "@/lib/types";

export type ProfileRow = {
  id: string;
  organizationId: string;
  role: string;
  username: string;
  firstName: string;
  lastName: string;
  mmr: number;
};

export function profileRowToUser(p: ProfileRow): User {
  const firstName = (p.firstName ?? "").trim();
  const lastName = (p.lastName ?? "").trim();
  const name =
    [firstName, lastName].filter(Boolean).join(" ").trim() || (p.username?.trim() ?? "");
  return {
    id: p.id,
    organizationId: p.organizationId,
    role: (p.role === "admin" ? "admin" : "player") as Role,
    name,
    firstName,
    lastName,
    username: p.username?.trim() ?? "",
    mmr: p.mmr,
  };
}
