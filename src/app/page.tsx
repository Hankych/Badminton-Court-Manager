"use client";

import {
  clampMmr,
  DEFAULT_MMR,
  formatOffCourtWait,
  formatOffCourtWaitShort,
  getRecommendation,
  MMR_MAX,
  MMR_MIN,
  minutesSince,
  validateScore,
} from "@/lib/domain";
import { PasswordField } from "@/components/password-field";
import { emptyActiveCourts, emptyGhostCourts, makeEmptySlots } from "@/lib/club/queue-promotion";
import {
  ActiveCourt,
  CourtResultDraft,
  GhostCourt,
  SessionMember,
  SessionSnapshot,
  User,
} from "@/lib/types";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";

const ORG_NAME = "Origin";

type ClubSessionDto = { id: string; status: string; rosterProfileIds: string[] } | null;

type SlotLocation = { courtType: "active" | "ghost"; courtIndex: number; slot: 1 | 2 | 3 | 4 };

function replaceActiveSlot(
  courts: ActiveCourt[],
  courtIndex: number,
  slotNum: 1 | 2 | 3 | 4,
  userId: string | null,
): ActiveCourt[] {
  return courts.map((c) =>
    c.index !== courtIndex
      ? c
      : {
          ...c,
          slots: c.slots.map((s) => (s.slot === slotNum ? { ...s, userId } : s)),
        },
  );
}

function replaceGhostSlot(
  courts: GhostCourt[],
  courtSortOrder: number,
  slotNum: 1 | 2 | 3 | 4,
  userId: string | null,
): GhostCourt[] {
  return courts.map((c) =>
    c.sortOrder !== courtSortOrder
      ? c
      : {
          ...c,
          slots: c.slots.map((s) => (s.slot === slotNum ? { ...s, userId } : s)),
        },
  );
}

function writeSlot(
  active: ActiveCourt[],
  ghost: GhostCourt[],
  loc: SlotLocation,
  userId: string | null,
): { active: ActiveCourt[]; ghost: GhostCourt[] } {
  if (loc.courtType === "active") {
    return { active: replaceActiveSlot(active, loc.courtIndex, loc.slot, userId), ghost };
  }
  return { active, ghost: replaceGhostSlot(ghost, loc.courtIndex, loc.slot, userId) };
}

/** Apply two slot writes in one transition (swap or unrelated updates). */
function applySlotPair(
  active: ActiveCourt[],
  ghost: GhostCourt[],
  locA: SlotLocation,
  uidA: string | null,
  locB: SlotLocation,
  uidB: string | null,
): { active: ActiveCourt[]; ghost: GhostCourt[] } {
  let { active: na, ghost: ng } = writeSlot(active, ghost, locA, uidA);
  ({ active: na, ghost: ng } = writeSlot(na, ng, locB, uidB));
  return { active: na, ghost: ng };
}

/** Sequential ghost fills on one board update (avoids stale React state from repeated assignToCourt). */
function batchPlaceBenchPlayersOnGhostCourt(
  active: ActiveCourt[],
  ghost: GhostCourt[],
  courtSortOrder: number,
  orderedUserIds: string[],
): { active: ActiveCourt[]; ghost: GhostCourt[] } {
  let a = active;
  let g = ghost;
  for (let i = 0; i < orderedUserIds.length; i++) {
    const uid = orderedUserIds[i]!;
    const slotNum = (i + 1) as 1 | 2 | 3 | 4;
    const cleared = stripUserFromBoard(a, g, uid);
    const loc: SlotLocation = { courtType: "ghost", courtIndex: courtSortOrder, slot: slotNum };
    const next = writeSlot(cleared.active, cleared.ghost, loc, uid);
    a = next.active;
    g = next.ghost;
  }
  return { active: a, ghost: g };
}

function getOccupantAt(
  active: ActiveCourt[],
  ghost: GhostCourt[],
  courtType: "active" | "ghost",
  courtIndex: number,
  slotNum: 1 | 2 | 3 | 4,
): string | null {
  if (courtType === "active") {
    const c = active.find((x) => x.index === courtIndex);
    return c?.slots.find((s) => s.slot === slotNum)?.userId ?? null;
  }
  const c = ghost.find((x) => x.sortOrder === courtIndex);
  return c?.slots.find((s) => s.slot === slotNum)?.userId ?? null;
}

function stripUserFromBoard(active: ActiveCourt[], ghost: GhostCourt[], userId: string) {
  return {
    active: active.map((c) => ({
      ...c,
      slots: c.slots.map((s) => (s.userId === userId ? { ...s, userId: null } : s)),
    })),
    ghost: ghost.map((c) => ({
      ...c,
      slots: c.slots.map((s) => (s.userId === userId ? { ...s, userId: null } : s)),
    })),
  };
}

function findUserSlot(active: ActiveCourt[], ghost: GhostCourt[], userId: string): SlotLocation | null {
  for (const c of active) {
    for (const s of c.slots) {
      if (s.userId === userId) {
        return { courtType: "active", courtIndex: c.index, slot: s.slot };
      }
    }
  }
  for (const c of ghost) {
    for (const s of c.slots) {
      if (s.userId === userId) {
        return { courtType: "ghost", courtIndex: c.sortOrder, slot: s.slot };
      }
    }
  }
  return null;
}

type DragPayload =
  | { source: "bench"; userId: string }
  | { source: "court"; userId: string; courtType: "active" | "ghost"; courtIndex: number; slot: 1 | 2 | 3 | 4 };

function parseDragPayload(e: DragEvent): DragPayload | null {
  const raw = e.dataTransfer.getData("application/json");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return null;
  }
}

export default function Home() {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [viewer, setViewer] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [clubSession, setClubSession] = useState<ClubSessionDto>(null);
  const [draftPick, setDraftPick] = useState<Set<string>>(() => new Set());
  const [activeCourts, setActiveCourts] = useState<ActiveCourt[]>(() => emptyActiveCourts());
  const [ghostCourts, setGhostCourts] = useState<GhostCourt[]>(() => emptyGhostCourts());
  const [sessionMembers, setSessionMembers] = useState<SessionMember[]>([]);
  const [snapshots, setSnapshots] = useState<SessionSnapshot[]>([]);
  const [alertModal, setAlertModal] = useState<{ message: string; tone: "info" | "warning" | "error" } | null>(null);
  const [scoreModalCourtIndex, setScoreModalCourtIndex] = useState<number | null>(null);
  const [adminTab, setAdminTab] = useState<"live" | "players">("live");
  const [resultDraft, setResultDraft] = useState<Record<number, CourtResultDraft>>({});
  const [recommendation, setRecommendation] = useState<{ players: string[]; warning: string | null } | null>(null);
  const [benchSuggestOpen, setBenchSuggestOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const boardDirtyRef = useRef(false);
  const syncingFromApiRef = useRef(false);
  const activeRef = useRef(activeCourts);
  const ghostRef = useRef(ghostCourts);
  activeRef.current = activeCourts;
  ghostRef.current = ghostCourts;

  function showAlert(message: string, tone: "info" | "warning" | "error" = "info") {
    setAlertModal({ message, tone });
  }

  const loadAll = useCallback(async () => {
    const meRes = await fetch("/api/auth/me");
    if (meRes.status === 401) {
      router.replace("/login");
      return;
    }
    const meData = (await meRes.json()) as { user?: User; username?: string } | null;
    if (!meData?.user) {
      router.replace("/login");
      return;
    }
    setViewer(meData.user);

    const st = await fetch("/api/club/state");
    if (!st.ok) {
      const err = await st.json().catch(() => ({}));
      showAlert(String((err as { error?: string }).error ?? "Could not load club state."), "error");
      return;
    }
    const d = (await st.json()) as {
      users: User[];
      clubSession: ClubSessionDto;
      activeCourts: ActiveCourt[];
      ghostCourts: GhostCourt[];
      sessionMembers: SessionMember[];
      snapshots: SessionSnapshot[];
    };
    syncingFromApiRef.current = true;
    setUsers(d.users);
    setClubSession(d.clubSession);
    setActiveCourts(d.activeCourts);
    setGhostCourts(d.ghostCourts);
    setSessionMembers(d.sessionMembers);
    setSnapshots(d.snapshots);
    if (d.clubSession?.status === "draft") {
      setDraftPick(new Set(d.clubSession.rosterProfileIds));
    }
    boardDirtyRef.current = false;
    queueMicrotask(() => {
      syncingFromApiRef.current = false;
    });
  }, [router]);

  useEffect(() => {
    void loadAll().finally(() => setHydrated(true));
  }, [loadAll]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (syncingFromApiRef.current) return;
    if (!clubSession || clubSession.status !== "active") return;
    if (viewer?.role !== "admin") return;
    if (!boardDirtyRef.current) return;
    const sid = clubSession.id;
    const t = window.setTimeout(() => {
      boardDirtyRef.current = false;
      void (async () => {
        const res = await fetch(`/api/club/session/${sid}/board`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ activeCourts: activeRef.current, ghostCourts: ghostRef.current }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showAlert(String((err as { error?: string }).error ?? "Could not save board."), "warning");
        }
        await loadAll();
      })();
    }, 200);
    return () => window.clearTimeout(t);
  }, [activeCourts, ghostCourts, clubSession, viewer?.role, loadAll]);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const isAdminView = viewer?.role === "admin";
  const activeSessionLive = clubSession?.status === "active";
  const playerMembers = sessionMembers.filter((m) => usersById.get(m.userId)?.role === "player");
  const benchMembers = playerMembers
    .filter((m) => m.boardState === "bench")
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const canMutateBoard = Boolean(isAdminView && activeSessionLive);

  function markBoardDirty() {
    if (canMutateBoard) boardDirtyRef.current = true;
  }

  function setState(userId: string, boardState: SessionMember["boardState"]) {
    setSessionMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, boardState } : m)));
  }

  function assignToCourt(
    courtIndex: number,
    slotNumber: 1 | 2 | 3 | 4,
    userId: string,
    courtType: "active" | "ghost",
  ) {
    if (!canMutateBoard) return;
    const targetLoc: SlotLocation = { courtType, courtIndex, slot: slotNumber };
    const displacedId = getOccupantAt(activeCourts, ghostCourts, courtType, courtIndex, slotNumber);
    const source = findUserSlot(activeCourts, ghostCourts, userId);

    if (displacedId === userId) return;
    markBoardDirty();

    if (!displacedId) {
      const cleared = stripUserFromBoard(activeCourts, ghostCourts, userId);
      const { active: na, ghost: ng } = writeSlot(cleared.active, cleared.ghost, targetLoc, userId);
      setActiveCourts(na);
      setGhostCourts(ng);
      setState(userId, courtType === "active" ? "active" : "ghost");
      return;
    }

    if (!source) {
      const cleared = stripUserFromBoard(activeCourts, ghostCourts, userId);
      const { active: na, ghost: ng } = writeSlot(cleared.active, cleared.ghost, targetLoc, userId);
      setActiveCourts(na);
      setGhostCourts(ng);
      setState(userId, courtType === "active" ? "active" : "ghost");
      setState(displacedId, "bench");
      return;
    }

    const { active: na, ghost: ng } = applySlotPair(
      activeCourts,
      ghostCourts,
      source,
      displacedId,
      targetLoc,
      userId,
    );
    setActiveCourts(na);
    setGhostCourts(ng);
    setState(userId, courtType === "active" ? "active" : "ghost");
    setState(displacedId, source.courtType === "active" ? "active" : "ghost");
  }

  function moveToBench(userId: string) {
    if (!canMutateBoard) return;
    markBoardDirty();
    const cleared = stripUserFromBoard(activeCourts, ghostCourts, userId);
    setActiveCourts(cleared.active);
    setGhostCourts(cleared.ghost);
    setState(userId, "bench");
  }

  function applyRecommendationToGhost() {
    if (!recommendation || !canMutateBoard) return;
    const emptyGhost = ghostCourts.find((g) => g.slots.every((s) => s.userId === null));
    if (!emptyGhost) {
      showAlert("No empty queue court is available.", "warning");
      return;
    }
    const ids = recommendation.players.slice(0, 4);
    if (ids.length < 4) return;
    markBoardDirty();
    const { active, ghost } = batchPlaceBenchPlayersOnGhostCourt(
      activeCourts,
      ghostCourts,
      emptyGhost.sortOrder,
      ids,
    );
    setActiveCourts(active);
    setGhostCourts(ghost);
    ids.forEach((uid) => setState(uid, "ghost"));
    setRecommendation(null);
  }

  function handleRecommendMatch() {
    const rec = getRecommendation({ benchMembers, usersById, now: Date.now() });
    if (!rec) {
      showAlert("Need at least 4 bench players.", "warning");
      setRecommendation(null);
      return;
    }
    setRecommendation({ players: rec.playerIds, warning: rec.warning });
  }

  function dismissRecommendation() {
    setRecommendation(null);
  }

  function swapSlotsWithinCourt(
    courtType: "active" | "ghost",
    courtIndex: number,
    fromSlot: 1 | 2 | 3 | 4,
    toSlot: 1 | 2 | 3 | 4,
  ) {
    if (!canMutateBoard) return;
    if (fromSlot === toSlot) return;
    markBoardDirty();
    if (courtType === "active") {
      setActiveCourts((prev) =>
        prev.map((c) => {
          if (c.index !== courtIndex) return c;
          const fromUser = c.slots.find((s) => s.slot === fromSlot)?.userId ?? null;
          const toUser = c.slots.find((s) => s.slot === toSlot)?.userId ?? null;
          return {
            ...c,
            slots: c.slots.map((s) => {
              if (s.slot === fromSlot) return { ...s, userId: toUser };
              if (s.slot === toSlot) return { ...s, userId: fromUser };
              return s;
            }),
          };
        }),
      );
      return;
    }
    setGhostCourts((prev) =>
      prev.map((c) => {
        if (c.sortOrder !== courtIndex) return c;
        const fromUser = c.slots.find((s) => s.slot === fromSlot)?.userId ?? null;
        const toUser = c.slots.find((s) => s.slot === toSlot)?.userId ?? null;
        return {
          ...c,
          slots: c.slots.map((s) => {
            if (s.slot === fromSlot) return { ...s, userId: toUser };
            if (s.slot === toSlot) return { ...s, userId: fromUser };
            return s;
          }),
        };
      }),
    );
  }

  async function recordAndFinish(courtIndex: number) {
    const merged: CourtResultDraft = {
      winnerSide: resultDraft[courtIndex]?.winnerSide ?? "top",
      winnerScore: resultDraft[courtIndex]?.winnerScore ?? 21,
      loserScore: resultDraft[courtIndex]?.loserScore ?? 18,
    };
    const scoreError = validateScore(merged.winnerScore, merged.loserScore);
    if (scoreError) {
      showAlert(scoreError, "warning");
      return;
    }
    if (!clubSession || clubSession.status !== "active") {
      showAlert("Start a live session before recording.", "warning");
      return;
    }
    const res = await fetch(`/api/club/session/${clubSession.id}/record-match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courtIndex,
        winnerSide: merged.winnerSide,
        winnerScore: merged.winnerScore,
        loserScore: merged.loserScore,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showAlert(String((err as { error?: string }).error ?? "Could not record match."), "warning");
      return;
    }
    boardDirtyRef.current = false;
    await loadAll();
    setResultDraft((prev) => {
      const next = { ...prev };
      delete next[courtIndex];
      return next;
    });
    showAlert("Result recorded, Elo applied, and court finished.", "info");
    setScoreModalCourtIndex(null);
  }

  async function finishSession() {
    if (!clubSession || clubSession.status !== "active") return;
    if (playerMembers.length === 0) {
      showAlert("Can't save a snapshot with an empty roster. Add players, or choose Close Without Saving.", "error");
      return;
    }
    const res = await fetch(`/api/club/session/${clubSession.id}/finish`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showAlert(String((err as { error?: string }).error ?? "Could not finish session."), "error");
      return;
    }
    boardDirtyRef.current = false;
    await loadAll();
    showAlert("Session closed. Snapshot saved.", "info");
  }

  async function abandonSessionNoSave() {
    if (!clubSession || clubSession.status !== "active") return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Close this session without saving a snapshot?\n\nRoster and board will be cleared. Player accounts under Manage Players are not deleted.",
      )
    ) {
      return;
    }
    const res = await fetch(`/api/club/session/${clubSession.id}/abandon`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showAlert(String((err as { error?: string }).error ?? "Could not close session."), "warning");
      return;
    }
    boardDirtyRef.current = false;
    await loadAll();
    showAlert("Session closed. No snapshot was saved.", "info");
  }

  async function startSessionDraft() {
    const res = await fetch("/api/club/session", { method: "POST" });
    if (res.status === 409) {
      await loadAll();
      showAlert("Continue the session already in progress.", "info");
      return;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showAlert(String((err as { error?: string }).error ?? "Could not create session."), "error");
      return;
    }
    await loadAll();
    showAlert("Pick players, then Activate Session — it saves your selection for you. Use Save Roster anytime to persist a draft only.", "info");
  }

  async function saveDraftRoster() {
    if (!clubSession || clubSession.status !== "draft") return;
    const res = await fetch(`/api/club/session/${clubSession.id}/roster`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileIds: [...draftPick] }),
    });
    if (!res.ok) {
      showAlert("Could not save roster.", "warning");
      return;
    }
    await loadAll();
    showAlert("Roster saved.", "info");
  }

  async function activateSession() {
    if (!clubSession || clubSession.status !== "draft") return;
    if (draftPick.size === 0) {
      showAlert("Select at least one player for the roster before going live.", "warning");
      return;
    }
    const rosterRes = await fetch(`/api/club/session/${clubSession.id}/roster`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileIds: [...draftPick] }),
    });
    if (!rosterRes.ok) {
      const err = await rosterRes.json().catch(() => ({}));
      showAlert(String((err as { error?: string }).error ?? "Could not save roster before activating."), "warning");
      return;
    }
    const res = await fetch(`/api/club/session/${clubSession.id}/activate`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const code = String((err as { error?: string }).error ?? "");
      if (code === "roster_empty") {
        showAlert("Roster failed to persist. Try Save Roster, then Activate again.", "warning");
      } else {
        showAlert(code || "Could not activate session.", "warning");
      }
      return;
    }
    boardDirtyRef.current = false;
    await loadAll();
    showAlert("Live session started.", "info");
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  function handleCourtSlotDrop(
    courtType: "active" | "ghost",
    courtIndex: number,
    targetSlot: 1 | 2 | 3 | 4,
    e: DragEvent,
  ) {
    e.preventDefault();
    if (!canMutateBoard) return;
    const payload = parseDragPayload(e);
    if (!payload) return;

    if (payload.source === "court") {
      if (payload.courtType === courtType && payload.courtIndex === courtIndex) {
        swapSlotsWithinCourt(courtType, courtIndex, payload.slot, targetSlot);
        return;
      }
      assignToCourt(courtIndex, targetSlot, payload.userId, courtType);
      return;
    }

    assignToCourt(courtIndex, targetSlot, payload.userId, courtType);
  }

  function handleDropToBench(e: DragEvent) {
    e.preventDefault();
    if (!canMutateBoard) return;
    const payload = parseDragPayload(e);
    if (!payload) return;
    moveToBench(payload.userId);
  }

  async function addOrgPlayer(input: { username: string; password: string; name: string; mmr: number }): Promise<boolean> {
    const name = input.name.trim();
    const uname = input.username.trim();
    if (!name || !uname || !input.password) {
      showAlert("Username, password, and display name are required.", "warning");
      return false;
    }
    const res = await fetch("/api/org/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: uname, password: input.password, name, mmr: clampMmr(input.mmr) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showAlert(String((err as { error?: string }).error ?? "Could not create player."), "warning");
      return false;
    }
    await loadAll();
    showAlert(`Added ${name} to the roster.`, "info");
    return true;
  }

  async function updateOrgPlayer(userId: string, patch: { name: string; mmr: number }) {
    const name = patch.name.trim();
    if (!name) {
      showAlert("Name cannot be empty.", "warning");
      return;
    }
    const res = await fetch(`/api/org/profiles/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mmr: clampMmr(patch.mmr) }),
    });
    if (!res.ok) {
      showAlert("Could not update player.", "warning");
      return;
    }
    await loadAll();
  }

  async function deleteOrgPlayer(userId: string) {
    const res = await fetch(`/api/org/profiles/${userId}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showAlert(String((err as { error?: string }).error ?? "Could not remove player."), "warning");
      return;
    }
    await loadAll();
    showAlert("Player removed.", "info");
  }

  const rosterPlayers = useMemo(() => users.filter((u) => u.role === "player"), [users]);

  if (!hydrated || !viewer) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-100 text-zinc-600">
        <p className="text-sm font-medium">Loading club…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-100 text-zinc-900">
      <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:p-6">
        <SessionHeader
          viewer={viewer}
          sessionPhase={
            clubSession?.status === "active" ? "active" : clubSession?.status === "draft" ? "draft" : "idle"
          }
          onLogout={logout}
        />

        {isAdminView ? (
          <nav
            className="inline-flex max-w-full flex-wrap rounded-full border border-zinc-200/90 bg-white p-1 shadow-sm ring-1 ring-zinc-100"
            aria-label="Admin Sections"
          >
            <button
              type="button"
              onClick={() => setAdminTab("live")}
              className={`min-h-[42px] min-w-[8rem] flex-1 rounded-full px-4 py-2 text-sm font-semibold transition sm:flex-none sm:min-w-[10rem] ${
                adminTab === "live" ? "bg-zinc-900 text-white shadow-md" : "text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              Live Session
            </button>
            <button
              type="button"
              onClick={() => setAdminTab("players")}
              className={`min-h-[42px] min-w-[8rem] flex-1 rounded-full px-4 py-2 text-sm font-semibold transition sm:flex-none sm:min-w-[10rem] ${
                adminTab === "players" ? "bg-zinc-900 text-white shadow-md" : "text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              Manage Players
            </button>
          </nav>
        ) : null}

        <AlertModal
          open={alertModal !== null}
          message={alertModal?.message ?? ""}
          tone={alertModal?.tone ?? "info"}
          onDismiss={() => setAlertModal(null)}
        />

        {scoreModalCourtIndex !== null ? (
          <ScoreEntryModal
            courtTitle={`Court ${scoreModalCourtIndex}`}
            slots={activeCourts.find((c) => c.index === scoreModalCourtIndex)?.slots ?? makeEmptySlots()}
            usersById={usersById}
            draft={resultDraft[scoreModalCourtIndex]}
            setDraft={(d) => setResultDraft((prev) => ({ ...prev, [scoreModalCourtIndex]: d }))}
            onSubmit={() => void recordAndFinish(scoreModalCourtIndex)}
            onClose={() => setScoreModalCourtIndex(null)}
          />
        ) : null}

        {!isAdminView || adminTab === "live" ? (
          <>
            <SectionContainer title="Session Controls">
              {isAdminView && !clubSession ? (
                <div className="mb-4 flex flex-wrap gap-2">
                  <ActionButton variant="success" onClick={() => void startSessionDraft()}>
                    New Session
                  </ActionButton>
                </div>
              ) : null}
              {isAdminView && clubSession?.status === "draft" ? (
                <div className="space-y-3 border-b border-zinc-100 pb-4 mb-4">
                  <p className="text-sm text-zinc-600">
                    Choose who’s on this run and activate — your checkboxes are saved automatically when you start. Everyone starts on the bench until you place them on courts. Use Save Roster if you want to save a draft without going live yet.
                  </p>
                  <p className="text-xs text-zinc-500">
                    Snapshots use the date when you <span className="font-medium text-zinc-700">Save Snapshot & Close</span> — not Save Roster.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {rosterPlayers.map((p) => (
                      <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={draftPick.has(p.id)}
                          onChange={(e) => {
                            setDraftPick((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(p.id);
                              else next.delete(p.id);
                              return next;
                            });
                          }}
                        />
                        <span>{p.name}</span>
                      </label>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton variant="neutral" onClick={() => void saveDraftRoster()}>
                      Save Roster
                    </ActionButton>
                    <ActionButton variant="success" onClick={() => void activateSession()}>
                      Activate Session
                    </ActionButton>
                  </div>
                </div>
              ) : null}
              {isAdminView && clubSession?.status === "active" ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 p-3 sm:p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-900/80">
                      End Session
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-zinc-700 md:max-w-3xl">
                      Everyone&apos;s board clears when you finish. Save a dated snapshot first, or close without saving if you didn&apos;t need a record.
                    </p>
                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <ActionButton className="w-full" variant="primary" onClick={() => void finishSession()}>
                        {`Save Snapshot & Close`}
                      </ActionButton>
                      <ActionButton className="w-full" variant="danger" onClick={() => void abandonSessionNoSave()}>
                        Close Without Saving
                      </ActionButton>
                      <button
                        type="button"
                        title="Suggest four balanced bench players for the next open queue court"
                        onClick={() => setBenchSuggestOpen(true)}
                        className="w-full min-h-[44px] touch-manipulation rounded-lg border border-violet-600 bg-violet-600 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1 sm:col-span-2 lg:col-span-1"
                      >
                        Generate Match Suggestion
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
              {!activeSessionLive && viewer.role === "player" ? (
                <p className="mt-3 text-sm text-zinc-600">No live session right now — waiting for the admin to start one.</p>
              ) : null}
            </SectionContainer>

            <BenchSuggestModal
              open={benchSuggestOpen && Boolean(isAdminView && activeSessionLive)}
              onClose={() => {
                dismissRecommendation();
                setBenchSuggestOpen(false);
              }}
              recommendation={recommendation}
              usersById={usersById}
              benchCount={benchMembers.length}
              canMutate={canMutateBoard}
              onGenerate={handleRecommendMatch}
              onApply={() => {
                applyRecommendationToGhost();
                setBenchSuggestOpen(false);
              }}
            />

            <div className="grid gap-4 lg:grid-cols-12">
              <div className="space-y-4 lg:col-span-8">
                <SectionContainer title="Active Courts">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {activeCourts.map((court) => (
                      <BadmintonCourtCard
                        key={`active-${court.index}`}
                        title={`Court ${court.index}`}
                        tone="active"
                        courtType="active"
                        courtIndex={court.index}
                        slots={court.slots}
                        usersById={usersById}
                        sessionMembers={sessionMembers}
                        nowMs={nowMs}
                        canDrag={Boolean(canMutateBoard)}
                        onCourtSlotDrop={(slot, e) => handleCourtSlotDrop("active", court.index, slot, e)}
                        onRemovePlayer={moveToBench}
                        footerSlot={
                          isAdminView && canMutateBoard ? (
                            <button
                              type="button"
                              onClick={() => setScoreModalCourtIndex(court.index)}
                              className="w-full rounded-lg border border-emerald-600 bg-emerald-700 px-2 py-1.5 text-center text-xs font-medium text-white shadow-sm transition hover:bg-emerald-800"
                            >
                              Record Match Result
                            </button>
                          ) : undefined
                        }
                      />
                    ))}
                  </div>
                </SectionContainer>

                <SectionContainer title="Queue Courts">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {ghostCourts.map((court) => (
                      <BadmintonCourtCard
                        key={`ghost-${court.sortOrder}`}
                        title={`Queue ${court.sortOrder}`}
                        tone="ghost"
                        courtType="ghost"
                        courtIndex={court.sortOrder}
                        slots={court.slots}
                        usersById={usersById}
                        sessionMembers={sessionMembers}
                        nowMs={nowMs}
                        canDrag={Boolean(canMutateBoard)}
                        onCourtSlotDrop={(slot, e) => handleCourtSlotDrop("ghost", court.sortOrder, slot, e)}
                        onRemovePlayer={moveToBench}
                      />
                    ))}
                  </div>
                </SectionContainer>
              </div>

              {isAdminView ? (
                <div className="space-y-4 lg:col-span-4">
                  <BenchPanel
                    members={benchMembers}
                    usersById={usersById}
                    nowMs={nowMs}
                    onDropToBench={handleDropToBench}
                    canDrag={Boolean(canMutateBoard)}
                  />
                </div>
              ) : null}
            </div>

            {isAdminView ? (
              <AdminHistory snapshots={snapshots} usersById={usersById} />
            ) : (
              <PlayerHistory snapshots={snapshots} viewerId={viewer?.id ?? ""} usersById={usersById} />
            )}
          </>
        ) : (
          <ManagePlayersPanel players={rosterPlayers} onAdd={addOrgPlayer} onUpdate={updateOrgPlayer} onDelete={deleteOrgPlayer} />
        )}
      </div>
    </main>
  );
}

const inputUi =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm transition placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20";

function displayInitials(displayName: string) {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.slice(0, 1) ?? "?";
  const second = parts.length > 1 ? parts[parts.length - 1]?.slice(0, 1) ?? "" : parts[0]?.slice(1, 2) ?? "";
  return (first + second).toUpperCase();
}

function ManagePlayersPanel(props: {
  players: User[];
  onAdd: (input: { username: string; password: string; name: string; mmr: number }) => boolean | Promise<boolean>;
  onUpdate: (userId: string, patch: { name: string; mmr: number }) => void | Promise<void>;
  onDelete: (userId: string) => void | Promise<void>;
}) {
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [newMmr, setNewMmr] = useState(DEFAULT_MMR);
  const [searchQuery, setSearchQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editMmr, setEditMmr] = useState(DEFAULT_MMR);

  const filteredPlayers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return props.players;
    return props.players.filter((p) => p.name.toLowerCase().includes(q));
  }, [props.players, searchQuery]);

  useEffect(() => {
    if (!showAddModal) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [showAddModal]);

  useEffect(() => {
    if (!showAddModal || adding) return;
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setShowAddModal(false);
    }
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [showAddModal, adding]);

  function startEdit(u: User) {
    setEditingId(u.id);
    setEditName(u.name);
    setEditMmr(u.mmr);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(userId: string) {
    await props.onUpdate(userId, { name: editName, mmr: editMmr });
    setEditingId(null);
  }

  async function submitAdd() {
    setAdding(true);
    try {
      const ok = await props.onAdd({
        username: newUsername.trim(),
        password: newPassword,
        name: newName.trim(),
        mmr: newMmr,
      });
      if (!ok) return;
      setNewUsername("");
      setNewPassword("");
      setNewName("");
      setNewMmr(DEFAULT_MMR);
      setShowAddModal(false);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-6">
      {showAddModal ? (
        <div className="fixed inset-0 z-[58] flex items-center justify-center p-3 sm:p-6">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 z-[1] bg-black/45"
            onClick={() => !adding && setShowAddModal(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-player-modal-title"
            className="relative z-[2] flex max-h-[min(92dvh,540px)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-zinc-200/90 bg-white shadow-2xl ring-2 ring-black/[0.04]"
          >
            <header className="shrink-0 border-b border-zinc-100 px-5 py-4">
              <h2 id="add-player-modal-title" className="text-lg font-semibold tracking-tight text-zinc-900">
                Add Player
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
                Display name, then the username and password they&apos;ll use to sign in.
              </p>
            </header>
            <div className="space-y-4 overflow-y-auto overscroll-contain px-5 py-5">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-700">Name</span>
                <input
                  autoComplete="name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className={inputUi}
                  placeholder="e.g. Jamie Chan"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-700">Sign-in username</span>
                <input
                  autoComplete="username"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  className={inputUi}
                  placeholder="e.g. jamie.chan"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-700">Password</span>
                <PasswordField
                  value={newPassword}
                  onChange={setNewPassword}
                  autoComplete="new-password"
                  placeholder="Set their password"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-700">MMR</span>
                <input
                  type="number"
                  min={MMR_MIN}
                  max={MMR_MAX}
                  value={newMmr}
                  onChange={(e) => setNewMmr(Number(e.target.value))}
                  className={`${inputUi} max-w-[10rem] tabular-nums`}
                />
              </label>
            </div>
            <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-zinc-100 bg-zinc-50/70 p-4 sm:flex-row sm:justify-end sm:gap-3">
              <button
                type="button"
                disabled={adding}
                onClick={() => setShowAddModal(false)}
                className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-45 sm:w-auto sm:py-2.5"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={adding}
                onClick={() => void submitAdd()}
                className="w-full rounded-xl bg-emerald-700 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:min-w-[8.5rem] sm:py-2.5"
              >
                {adding ? "Adding…" : "Add Player"}
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="roster-heading" className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-100 bg-zinc-50/70 px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3 gap-y-3">
            <div className="min-w-0">
              <h3 id="roster-heading" className="text-base font-semibold text-zinc-900">
                Players
              </h3>
              <p className="text-xs text-zinc-500">
                {props.players.length} player{props.players.length === 1 ? "" : "s"}
                {searchQuery.trim()
                  ? ` · ${filteredPlayers.length} match${filteredPlayers.length !== 1 ? "es" : ""}`
                  : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800 touch-manipulation"
            >
              <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Add Player
            </button>
          </div>
          <label className="relative mt-4 block w-full">
            <span className="sr-only">Search players by name</span>
            <svg
              className="pointer-events-none absolute left-3 top-1/2 size-[1.125rem] -translate-y-1/2 text-zinc-400"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
            </svg>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name…"
              className={`${inputUi} min-h-[44px] py-2.5 pl-10`}
            />
          </label>
        </div>

        {props.players.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 text-2xl text-zinc-400">
              +
            </div>
            <p className="text-sm font-medium text-zinc-800">No players yet</p>
            <p className="max-w-xs text-xs text-zinc-500">Use Add Player, or load seed accounts from your setup script.</p>
          </div>
        ) : filteredPlayers.length === 0 ? (
          <div className="px-6 py-14 text-center text-sm text-zinc-600">No matches — try another name.</div>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {filteredPlayers.map((u) => (
              <li
                key={u.id}
                className={`transition-colors ${editingId === u.id ? "bg-emerald-50/40 ring-2 ring-emerald-200 ring-inset" : "hover:bg-zinc-50/80"}`}
              >
                <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div
                      className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50 text-xs font-bold text-emerald-800"
                      aria-hidden
                    >
                      {displayInitials(editingId === u.id ? editName : u.name)}
                    </div>
                    <div className="min-w-0">
                      {editingId === u.id ? (
                        <div className="flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                          <label className="block min-w-0 flex-1 sm:min-w-[12rem]">
                            <span className="mb-1.5 block text-xs font-medium text-zinc-700">Name</span>
                            <input
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              className={inputUi}
                            />
                          </label>
                          <label className="block w-full sm:w-auto sm:min-w-[7rem] sm:max-w-[8rem]">
                            <span className="mb-1.5 block text-xs font-medium text-zinc-700">MMR</span>
                            <input
                              type="number"
                              min={MMR_MIN}
                              max={MMR_MAX}
                              value={editMmr}
                              onChange={(e) => setEditMmr(Number(e.target.value))}
                              className={`${inputUi} tabular-nums`}
                            />
                          </label>
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-baseline gap-2 gap-y-1">
                            <span className="truncate font-semibold text-zinc-900">{u.name}</span>
                            <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-emerald-900">
                              {u.mmr} MMR
                            </span>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-zinc-500">
                            {u.username ? (
                              <>
                                <span className="font-mono text-[11px] text-zinc-600">{u.username}</span>
                                <span className="mx-1.5 text-zinc-300" aria-hidden>
                                  ·
                                </span>
                              </>
                            ) : null}
                            <span className="tabular-nums">…{u.id.slice(-8)}</span>
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 sm:pl-4">
                    {editingId === u.id ? (
                      <>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void saveEdit(u.id)}
                          className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-800"
                        >
                          Save Changes
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startEdit(u)}
                          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 transition hover:border-emerald-300 hover:bg-emerald-50/50"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (typeof window !== "undefined" && window.confirm(`Remove ${u.name} from the roster? They will not be able to sign in until re-added.`)) {
                              void props.onDelete(u.id);
                            }
                          }}
                          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-900 transition hover:bg-red-100"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ResultEditor(props: {
  slots: ActiveCourt["slots"];
  usersById: Map<string, User>;
  draft: CourtResultDraft | undefined;
  setDraft: (draft: CourtResultDraft) => void;
  onFinish: () => void;
  variant?: "card" | "dialog";
}) {
  const variant = props.variant ?? "card";
  const fieldIds = useId();
  const labelFor = (slot: 1 | 2 | 3 | 4) => {
    const id = props.slots.find((s) => s.slot === slot)?.userId;
    return id ? props.usersById.get(id)?.name ?? id : "—";
  };
  const topLine = `${labelFor(1)} · ${labelFor(2)}`;
  const bottomLine = `${labelFor(3)} · ${labelFor(4)}`;
  const draft: CourtResultDraft = props.draft ?? {
    winnerSide: "top",
    winnerScore: 21,
    loserScore: 18,
  };

  const shell =
    variant === "dialog"
      ? "flex flex-col gap-6"
      : "mt-3 rounded-xl border border-zinc-200 bg-white/90 p-4";

  const labelUpper = "text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500";

  const teamBtn =
    "flex min-h-[48px] w-full items-center rounded-xl border px-4 text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500";

  return (
    <div className={shell}>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-900">Which team won?</h3>
        <div className="grid grid-cols-1 gap-2">
          <button
            type="button"
            onClick={() => props.setDraft({ ...draft, winnerSide: "top" })}
            aria-label={`Winning team: ${topLine}`}
            className={`${teamBtn} justify-center text-center ${
              draft.winnerSide === "top"
                ? "border-emerald-500 bg-emerald-50 font-semibold text-emerald-950 shadow-sm"
                : "border-zinc-200 bg-white text-zinc-900 hover:border-zinc-300 hover:bg-zinc-50"
            }`}
          >
            <span className="truncate">{topLine}</span>
          </button>
          <button
            type="button"
            onClick={() => props.setDraft({ ...draft, winnerSide: "bottom" })}
            aria-label={`Winning team: ${bottomLine}`}
            className={`${teamBtn} justify-center text-center ${
              draft.winnerSide === "bottom"
                ? "border-emerald-500 bg-emerald-50 font-semibold text-emerald-950 shadow-sm"
                : "border-zinc-200 bg-white text-zinc-900 hover:border-zinc-300 hover:bg-zinc-50"
            }`}
          >
            <span className="truncate">{bottomLine}</span>
          </button>
        </div>
      </section>

      <section className={variant === "dialog" ? "border-t border-zinc-100 pt-6" : "border-t border-zinc-100 pt-5"}>
        <p className={`${labelUpper} mb-4`}>Final score</p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor={`${fieldIds}-winner`} className="block text-xs font-medium text-zinc-600">
              Winner
            </label>
            <input
              id={`${fieldIds}-winner`}
              type="number"
              value={draft.winnerScore}
              onChange={(e) => props.setDraft({ ...draft, winnerScore: Number(e.target.value) })}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-center text-sm tabular-nums shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              aria-label="Winner score"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${fieldIds}-loser`} className="block text-xs font-medium text-zinc-600">
              Loser
            </label>
            <input
              id={`${fieldIds}-loser`}
              type="number"
              value={draft.loserScore}
              onChange={(e) => props.setDraft({ ...draft, loserScore: Number(e.target.value) })}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-center text-sm tabular-nums shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              aria-label="Loser score"
            />
          </div>
        </div>
      </section>

      <button
        onClick={props.onFinish}
        className="w-full rounded-xl bg-zinc-900 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800"
        type="button"
      >
        Record Result
      </button>
    </div>
  );
}

function ScoreEntryModal(props: {
  courtTitle: string;
  slots: ActiveCourt["slots"];
  usersById: Map<string, User>;
  draft: CourtResultDraft | undefined;
  setDraft: (draft: CourtResultDraft) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/45"
        aria-label="Close"
        onClick={props.onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="score-modal-title"
        className="relative flex max-h-[min(92vh,560px)] w-full max-w-[420px] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-zinc-100 px-6 py-5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Record Match Result</p>
            <h2 id="score-modal-title" className="mt-1 text-xl font-semibold tracking-tight text-zinc-900">
              {props.courtTitle}
            </h2>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
          >
            Cancel
          </button>
        </header>
        <div className="overflow-y-auto px-6 pb-6 pt-5">
          <ResultEditor
            slots={props.slots}
            usersById={props.usersById}
            draft={props.draft}
            setDraft={props.setDraft}
            onFinish={props.onSubmit}
            variant="dialog"
          />
        </div>
      </div>
    </div>
  );
}

function AlertModal(props: {
  open: boolean;
  message: string;
  tone: "info" | "warning" | "error";
  onDismiss: () => void;
}) {
  if (!props.open || !props.message) return null;
  const toneStyles: Record<typeof props.tone, string> = {
    info: "border-zinc-200 bg-white text-zinc-900",
    warning: "border-amber-200 bg-amber-50 text-amber-950",
    error: "border-red-200 bg-red-50 text-red-900",
  };
  const buttonStyles: Record<typeof props.tone, string> = {
    info: "bg-zinc-900 hover:bg-zinc-800",
    warning: "bg-amber-800 hover:bg-amber-900",
    error: "bg-red-800 hover:bg-red-900",
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/45"
        aria-label="Close message"
        onClick={props.onDismiss}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        className={`relative max-w-md rounded-2xl border p-5 shadow-2xl ${toneStyles[props.tone]}`}
      >
        <p className="text-sm leading-relaxed text-zinc-900">{props.message}</p>
        <button
          type="button"
          onClick={props.onDismiss}
          className={`mt-4 w-full rounded-lg py-2.5 text-sm font-semibold text-white transition ${buttonStyles[props.tone]}`}
        >
          OK
        </button>
      </div>
    </div>
  );
}

function SessionHeader(props: { viewer: User; sessionPhase: "idle" | "draft" | "active"; onLogout: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(ev: MouseEvent | TouchEvent) {
      const t = ev.target as Node | null;
      if (wrapRef.current && t && !wrapRef.current.contains(t)) setMenuOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const badge =
    props.sessionPhase === "active"
      ? { cls: "bg-emerald-100 text-emerald-800 ring-emerald-200", label: "Live" }
      : props.sessionPhase === "draft"
        ? { cls: "bg-amber-100 text-amber-900 ring-amber-200", label: "Draft" }
        : { cls: "bg-zinc-100 text-zinc-700 ring-zinc-200", label: "Idle" };

  const accountType = props.viewer.role === "admin" ? "Administrator" : "Member";

  const fn = props.viewer.firstName.trim();
  const ln = props.viewer.lastName.trim();
  const headlineFirst = fn || props.viewer.name.trim() || "—";
  const headlineLast = ln;

  const avatarLabel = fn || ln ? [fn, ln].filter(Boolean).join(" ").trim() : props.viewer.name;

  return (
    <header className="sticky top-0 z-30 rounded-2xl border border-zinc-200 bg-white shadow-md ring-1 ring-zinc-100/80 backdrop-blur-sm">
      <div className="overflow-hidden rounded-t-2xl">
        <div className="h-1 bg-gradient-to-r from-emerald-700 via-teal-500 to-emerald-600" aria-hidden />
      </div>
      <div className="flex items-start gap-3 px-3 py-3 sm:items-center sm:justify-between sm:gap-4 sm:px-5 sm:py-4">
        <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
          <div
            className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-zinc-900 text-[10px] font-black uppercase leading-none tracking-widest text-white shadow-inner sm:size-14 sm:text-xs"
            aria-hidden
          >
            <span className="px-1 text-center">{ORG_NAME.slice(0, 3)}</span>
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-800/90">{ORG_NAME}</p>
              <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${badge.cls}`}>
                {badge.label}
              </span>
            </div>
            <h1 className="truncate text-lg font-bold tracking-tight text-zinc-900 sm:text-2xl">Session Board</h1>
            <p className="truncate text-[11px] leading-snug text-zinc-500 sm:text-sm">Courts · queue · bench</p>
          </div>
        </div>

        <div ref={wrapRef} className="relative shrink-0 pt-1 sm:pt-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-haspopup="dialog"
            aria-label={`Account (${headlineFirst}${headlineLast ? ` ${headlineLast}` : ""})`}
            title="Account"
            className={`flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-emerald-700 to-teal-800 text-xs font-bold uppercase tracking-tight text-white shadow-md transition hover:brightness-105 focus-visible:outline focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 ${
              menuOpen ? "ring-2 ring-emerald-300 ring-offset-2" : ""
            }`}
          >
            <span aria-hidden>{displayInitials(avatarLabel)}</span>
          </button>
            {menuOpen ? (
              <div
                role="dialog"
                aria-label="Your account"
                className="absolute right-0 z-[100] mt-2 w-[min(18rem,calc(100vw-1.25rem))] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl ring-1 ring-black/10"
              >
                <div className="border-b border-zinc-100 px-4 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">Your profile</p>
                  <p className="mt-1.5 truncate text-[15px] font-semibold leading-snug text-zinc-900">
                    {props.viewer.name.trim() || "—"}
                  </p>
                  <dl className="mt-4 space-y-3.5 text-sm">
                    <div>
                      <dt className="text-xs font-medium text-zinc-500">Role</dt>
                      <dd className="mt-0.5 text-zinc-900">{accountType}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-zinc-500">Sign-in username</dt>
                      <dd className="mt-1 break-all rounded-lg bg-zinc-100 px-3 py-2 font-mono text-[13px] leading-relaxed text-zinc-900 ring-1 ring-zinc-200/80">
                        {props.viewer.username.trim() ? props.viewer.username : "—"}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="p-2 pt-0">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      props.onLogout();
                    }}
                    className="w-full rounded-xl px-3 py-2.5 text-center text-sm font-semibold text-zinc-900 transition hover:bg-zinc-100"
                  >
                    Log Out
                  </button>
                </div>
              </div>
            ) : null}
        </div>
      </div>
    </header>
  );
}

function SectionContainer(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-base font-semibold">{props.title}</h2>
      {props.children}
    </section>
  );
}

function BenchSuggestModal(props: {
  open: boolean;
  onClose: () => void;
  recommendation: { players: string[]; warning: string | null } | null;
  usersById: Map<string, User>;
  benchCount: number;
  canMutate: boolean;
  onGenerate: () => void;
  onApply: () => void;
}) {
  const rec = props.recommendation;
  const needMore = Math.max(0, 4 - props.benchCount);

  useEffect(() => {
    if (!props.open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") props.onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center p-3 sm:p-6">
      <button type="button" aria-label="Close" className="absolute inset-0 z-[1] bg-black/45" onClick={props.onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bench-suggest-title"
        className="relative z-[2] flex max-h-[min(90dvh,34rem)] w-full max-w-[26rem] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-zinc-100 px-5 py-4">
          <div className="min-w-0 pr-2">
            <h2 id="bench-suggest-title" className="text-lg font-semibold tracking-tight text-zinc-900">
              Bench match suggestion
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={props.onClose}
            className="-mr-1 -mt-1 flex size-10 shrink-0 touch-manipulation items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-950 focus-visible:outline focus-visible:ring-2 focus-visible:ring-violet-400/80 focus-visible:ring-offset-2"
          >
            <svg className="size-5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-5">
          {props.benchCount < 4 ? (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-950 ring-1 ring-amber-200/80">
              Add <span className="font-semibold tabular-nums">{needMore}</span> more player{needMore === 1 ? "" : "s"} to the bench first.
            </p>
          ) : null}

          {!rec ? (
            <div className="space-y-5">
              <p className="text-sm leading-relaxed text-zinc-600">
                Picks four people from the bench (balanced by rating). Review the lineup, then place them on the next open waiting court if you
                like it.
              </p>
              <button
                type="button"
                disabled={!props.canMutate || props.benchCount < 4}
                onClick={() => props.onGenerate()}
                className="w-full rounded-xl bg-violet-700 px-4 py-3.5 text-sm font-semibold text-white shadow-md transition hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Generate Match Suggestion
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <ul className="grid gap-3 sm:grid-cols-2">
                {rec.players.map((id) => {
                  const u = props.usersById.get(id);
                  const label = u?.name ?? id;
                  return (
                    <li
                      key={id}
                      className="flex min-w-0 items-center gap-3 rounded-xl border border-zinc-100 bg-zinc-50/90 px-3.5 py-3 text-left shadow-sm"
                    >
                      <span
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white text-[11px] font-bold text-violet-800 ring-1 ring-violet-200/90"
                        aria-hidden
                      >
                        {displayInitials(label)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-semibold text-zinc-900">{label}</p>
                        <p className="mt-0.5 text-[11px] tabular-nums text-zinc-500">{u ? `${u.mmr} MMR` : ""}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {rec.warning ? (
                <div className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-950 ring-1 ring-amber-200/80">
                  {rec.warning}
                </div>
              ) : null}
              <button
                type="button"
                disabled={!props.canMutate}
                onClick={() => props.onApply()}
                className="w-full rounded-xl bg-emerald-700 px-4 py-3.5 text-sm font-semibold text-white shadow-md transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Place On Queue Court
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BadmintonCourtCard(props: {
  title: string;
  tone: "active" | "ghost";
  courtType: "active" | "ghost";
  courtIndex: number;
  slots: Array<{ slot: 1 | 2 | 3 | 4; userId: string | null }>;
  usersById: Map<string, User>;
  sessionMembers: SessionMember[];
  nowMs: number;
  canDrag: boolean;
  onCourtSlotDrop: (slot: 1 | 2 | 3 | 4, e: DragEvent) => void;
  onRemovePlayer: (userId: string) => void;
  footerSlot?: React.ReactNode;
}) {
  const wrapperTone = props.tone === "active"
    ? "border-emerald-200 bg-emerald-50/70 shadow"
    : "border-zinc-200 bg-zinc-50 opacity-80";

  function renderSlotRow(slots: readonly (1 | 2 | 3 | 4)[]) {
    return slots.map((slotNum) => {
      const slot = props.slots.find((s) => s.slot === slotNum);
      if (!slot) return null;
      const user = slot.userId ? props.usersById.get(slot.userId) : null;
      const member = slot.userId ? props.sessionMembers.find((m) => m.userId === slot.userId) : null;
      return (
        <CourtSlot
          key={`${props.title}-${slot.slot}`}
          courtType={props.courtType}
          courtIndex={props.courtIndex}
          user={user ?? null}
          member={member ?? null}
          slot={slot.slot}
          nowMs={props.nowMs}
          canDrag={props.canDrag}
          onCourtSlotDrop={(e) => props.onCourtSlotDrop(slot.slot, e)}
          onRemove={props.onRemovePlayer}
        />
      );
    });
  }

  return (
    <article className={`rounded-2xl border p-3 ${wrapperTone}`}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-700">{props.title}</h3>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${props.tone === "active" ? "bg-emerald-100 text-emerald-700" : "bg-zinc-200 text-zinc-600"}`}>
          {props.tone === "active" ? "Active" : "Queue"}
        </span>
      </div>

      <div className="relative rounded-xl border border-emerald-200 bg-gradient-to-b from-emerald-50 via-emerald-100 to-emerald-200 p-2.5">
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">{renderSlotRow([1, 2])}</div>
          <div className="relative flex items-center justify-center py-0.5">
            <div className="h-0.5 w-full rounded-full bg-white/80 shadow-sm" aria-hidden />
            <span className="absolute rounded-full bg-white/95 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-900 shadow-sm">
              Net
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">{renderSlotRow([3, 4])}</div>
        </div>
      </div>
      {props.footerSlot ? <div className="mt-2">{props.footerSlot}</div> : null}
    </article>
  );
}

function CourtSlot(props: {
  courtType: "active" | "ghost";
  courtIndex: number;
  user: User | null;
  member: SessionMember | null;
  slot: 1 | 2 | 3 | 4;
  nowMs: number;
  canDrag: boolean;
  onCourtSlotDrop: (e: DragEvent) => void;
  onRemove: (userId: string) => void;
}) {
  if (!props.user) {
    return (
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          props.onCourtSlotDrop(e);
        }}
        className="h-[74px] rounded-xl border border-dashed border-white/80 bg-white/35"
      />
    );
  }
  const status = deriveStatus(props.member);
  const dragPayload: DragPayload = {
    source: "court",
    userId: props.user.id,
    courtType: props.courtType,
    courtIndex: props.courtIndex,
    slot: props.slot,
  };
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        props.onCourtSlotDrop(e);
      }}
    >
      <PlayerChip
        user={props.user}
        member={props.member}
        nowMs={props.nowMs}
        status={status}
        draggable={props.canDrag}
        dragPayload={dragPayload}
        onRemove={props.onRemove}
        compact
      />
    </div>
  );
}

function BenchPanel(props: {
  members: SessionMember[];
  usersById: Map<string, User>;
  nowMs: number;
  onDropToBench: (e: DragEvent) => void;
  canDrag: boolean;
}) {
  return (
    <SectionContainer title="Bench">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          props.onDropToBench(e);
        }}
        className="space-y-2 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-2.5 shadow-sm"
      >
        {props.members.length === 0 ? (
          <p className="rounded-xl border border-dashed border-emerald-200/80 bg-white/50 px-2 py-4 text-center text-xs text-zinc-600">
            Drop players here from a court.
          </p>
        ) : null}
        {props.members.map((m) => {
          const user = props.usersById.get(m.userId);
          if (!user) return null;
          const dragPayload: DragPayload = { source: "bench", userId: m.userId };
          return (
            <PlayerChip
              key={m.userId}
              user={user}
              member={m}
              nowMs={props.nowMs}
              status="Waiting"
              draggable={props.canDrag}
              dragPayload={dragPayload}
              variant="bench"
            />
          );
        })}
      </div>
    </SectionContainer>
  );
}

function PlayerChip(props: {
  user: User;
  member: SessionMember | null;
  nowMs: number;
  status: "Playing" | "Waiting" | "Ghost" | "Break";
  draggable?: boolean;
  compact?: boolean;
  variant?: "bench" | "default";
  dragPayload?: DragPayload;
  onRemove?: (userId: string) => void;
}) {
  const isBench = props.variant === "bench";
  return (
    <div
      draggable={Boolean(props.draggable && props.dragPayload)}
      onDragStart={(e) => {
        if (!props.draggable || !props.dragPayload) return;
        e.dataTransfer.setData("application/json", JSON.stringify(props.dragPayload));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDoubleClick={() => props.onRemove?.(props.user.id)}
      className={`rounded-xl border border-white/70 bg-white/90 p-2 shadow-sm transition hover:shadow ${
        props.draggable && props.dragPayload ? "cursor-grab active:cursor-grabbing" : ""
      }`}
      {...(isBench && props.member
        ? {
            title: `Time off court (waiting on bench): ${formatOffCourtWait(props.member, props.nowMs)}`,
          }
        : {})}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-zinc-800">{props.user.name}</p>
          {!isBench ? (
            <div className="mt-1">
              <StatusBadge status={props.status} />
            </div>
          ) : (
            <div className="mt-2 space-y-1.5">
              <StatusBadge status={props.status} />
              {props.member ? (
                <div className="rounded-lg bg-zinc-50 px-2 py-1.5 text-[10px] leading-snug text-zinc-700 ring-1 ring-zinc-100">
                  <p className="tabular-nums tracking-tight">
                    <span className="text-zinc-500">Played</span> {props.member.gamesPlayed}
                    <span className="mx-1.5 text-zinc-300" aria-hidden>
                      ·
                    </span>
                    <span className="text-zinc-500">Record</span> {props.member.wins}–{props.member.losses}
                    <span className="mx-1.5 text-zinc-300" aria-hidden>
                      ·
                    </span>
                    <span className="text-zinc-500">Wait</span>{" "}
                    <span className="font-semibold text-zinc-900">{formatOffCourtWaitShort(props.member, props.nowMs)}</span>
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </div>
        {isBench ? (
          <span className="shrink-0 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-700 shadow-sm ring-1 ring-black/5">
            {props.user.mmr}
          </span>
        ) : null}
      </div>
      {!isBench ? (
        <div className="mt-1.5 grid grid-cols-2 gap-1 text-[10px] text-zinc-600">
          <>
            <span>R {props.user.mmr}</span>
            <span>W {formatMinutes(minutesSince(props.member?.lastGameFinishedAt ?? null, props.nowMs))}</span>
            {!props.compact ? (
              <>
                <span>G {props.member?.gamesPlayed ?? 0}</span>
                <span>
                  {props.member?.wins ?? 0}-{props.member?.losses ?? 0}
                </span>
              </>
            ) : null}
          </>
        </div>
      ) : null}
    </div>
  );
}

function PlayerHistory(props: { snapshots: SessionSnapshot[]; viewerId: string; usersById: Map<string, User> }) {
  return (
    <SectionContainer title="My Session History">
      <div className="grid gap-2 md:grid-cols-2">
        {props.snapshots.map((snap) => {
          const stat = snap.stats.find((s) => s.userId === props.viewerId);
          if (!stat) return null;
          return (
            <div key={snap.id} className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm">
              <p className="font-semibold">{snap.snapshotName}</p>
              <p className="text-zinc-600">
                {stat.matchesPlayed} matches • {stat.wins}W / {stat.losses}L
              </p>
            </div>
          );
        })}
      </div>
    </SectionContainer>
  );
}

function AdminHistory(props: { snapshots: SessionSnapshot[]; usersById: Map<string, User> }) {
  return (
    <SectionContainer title="Admin Snapshot History">
      <div className="space-y-3">
        {props.snapshots.map((snap) => (
          <div key={snap.id} className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
            <p className="mb-2 font-semibold">{snap.snapshotName}</p>
            <div className="grid gap-1.5 md:grid-cols-2">
              {snap.stats.map((s) => (
                <div key={`${snap.id}-${s.userId}`} className="rounded-lg bg-white p-2 text-xs text-zinc-700">
                  {(props.usersById.get(s.userId)?.name ?? s.userId)} • {s.matchesPlayed} matches • {s.wins}W/{s.losses}L
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionContainer>
  );
}

function ActionButton(props: {
  children: React.ReactNode;
  onClick: () => void;
  variant: "primary" | "danger" | "success" | "warning" | "neutral" | "highlight";
  className?: string;
}) {
  const classes: Record<typeof props.variant, string> = {
    primary: "bg-zinc-900 text-white hover:bg-zinc-800",
    danger: "bg-red-700 text-white hover:bg-red-800",
    success: "bg-emerald-700 text-white hover:bg-emerald-800",
    warning: "bg-amber-600 text-white hover:bg-amber-700",
    neutral: "bg-zinc-700 text-white hover:bg-zinc-800",
    highlight: "bg-indigo-700 text-white hover:bg-indigo-800",
  };
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`rounded-lg px-4 py-2.5 text-sm font-semibold shadow-sm transition sm:py-2 ${classes[props.variant]} ${props.className ?? ""}`}
    >
      {props.children}
    </button>
  );
}

function StatusBadge(props: { status: "Playing" | "Waiting" | "Ghost" | "Break" }) {
  const classes: Record<typeof props.status, string> = {
    Playing: "bg-emerald-100 text-emerald-700",
    Waiting: "bg-zinc-200 text-zinc-700",
    Ghost: "bg-indigo-100 text-indigo-700",
    Break: "bg-amber-100 text-amber-700",
  };
  const label = props.status === "Ghost" ? "Queue" : props.status;
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${classes[props.status]}`}>
      {label}
    </span>
  );
}

function deriveStatus(member: SessionMember | null | undefined): "Playing" | "Waiting" | "Ghost" | "Break" {
  if (!member) return "Waiting";
  if (member.boardState === "active") return "Playing";
  if (member.boardState === "ghost") return "Ghost";
  if (member.boardState === "break") return "Break";
  return "Waiting";
}

function formatMinutes(value: number | null): string {
  if (value === null) return "No games";
  return `${value}m`;
}
