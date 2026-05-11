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
  minutesWaitingOffCourt,
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
const LIVE_STATE_REFRESH_MS = 2000;

type ClubSessionDto = { id: string; status: string; rosterProfileIds: string[] } | null;
type ClubStatePayload = {
  users: User[];
  clubSession: ClubSessionDto;
  activeCourts: ActiveCourt[];
  ghostCourts: GhostCourt[];
  sessionMembers: SessionMember[];
  snapshots: SessionSnapshot[];
};

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
  const [selectedBenchIds, setSelectedBenchIds] = useState<Set<string>>(() => new Set());
  const [benchPlacementMode, setBenchPlacementMode] = useState<"active" | "ghost" | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [benchPanelHeight, setBenchPanelHeight] = useState<number | null>(null);

  const boardDirtyRef = useRef(false);
  const boardMutationGenRef = useRef(0);
  const syncingFromApiRef = useRef(false);
  const liveRefreshInFlightRef = useRef(false);
  const courtsColumnRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(activeCourts);
  const ghostRef = useRef(ghostCourts);

  const showAlert = useCallback((message: string, tone: "info" | "warning" | "error" = "info") => {
    setAlertModal({ message, tone });
  }, []);

  const applyClubState = useCallback((d: ClubStatePayload) => {
    syncingFromApiRef.current = true;
    setUsers(d.users);
    setClubSession(d.clubSession);
    setActiveCourts(d.activeCourts);
    setGhostCourts(d.ghostCourts);
    setSessionMembers(d.sessionMembers);
    setSnapshots(d.snapshots);
    boardDirtyRef.current = false;
    queueMicrotask(() => {
      syncingFromApiRef.current = false;
    });
  }, []);

  const loadClubState = useCallback(async (options?: { silent?: boolean; protectLocalBoard?: boolean }) => {
    if (options?.protectLocalBoard && boardDirtyRef.current) return false;
    const genAtStart = boardMutationGenRef.current;
    const st = await fetch("/api/club/state", { cache: "no-store" });
    if (st.status === 401) {
      router.replace("/login");
      return false;
    }
    if (!st.ok) {
      const err = await st.json().catch(() => ({}));
      if (!options?.silent) {
        showAlert(String((err as { error?: string }).error ?? "Could not load club state."), "error");
      }
      return false;
    }
    const d = (await st.json()) as ClubStatePayload;
    if (options?.protectLocalBoard && (boardDirtyRef.current || boardMutationGenRef.current !== genAtStart)) {
      return false;
    }
    applyClubState(d);
    return true;
  }, [applyClubState, router, showAlert]);

  const loadAll = useCallback(async () => {
    const meRes = await fetch("/api/auth/me", { cache: "no-store" });
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
    await loadClubState();
  }, [loadClubState, router]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      await loadAll();
      if (!cancelled) setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    activeRef.current = activeCourts;
    ghostRef.current = ghostCourts;
  }, [activeCourts, ghostCourts]);

  useEffect(() => {
    if (!hydrated || !viewer) return;
    let stopped = false;
    const protectLocalBoard = viewer.role === "admin";

    async function refreshLiveState() {
      if (stopped) return;
      if (document.visibilityState === "hidden") return;
      if (liveRefreshInFlightRef.current) return;
      liveRefreshInFlightRef.current = true;
      try {
        await loadClubState({ silent: true, protectLocalBoard });
      } finally {
        liveRefreshInFlightRef.current = false;
      }
    }

    const intervalId = window.setInterval(() => {
      void refreshLiveState();
    }, LIVE_STATE_REFRESH_MS);
    const onFocus = () => void refreshLiveState();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshLiveState();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hydrated, loadClubState, viewer]);

  useEffect(() => {
    if (syncingFromApiRef.current) return;
    if (!clubSession || clubSession.status !== "active") return;
    if (viewer?.role !== "admin") return;
    if (!boardDirtyRef.current) return;
    const sid = clubSession.id;
    const t = window.setTimeout(() => {
      void (async () => {
        const genAtSend = boardMutationGenRef.current;
        const res = await fetch(`/api/club/session/${sid}/board`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ activeCourts: activeRef.current, ghostCourts: ghostRef.current }),
        });
        if (boardMutationGenRef.current !== genAtSend) {
          boardDirtyRef.current = true;
          return;
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showAlert(String((err as { error?: string }).error ?? "Could not save board."), "warning");
          await loadAll();
          return;
        }
        /** Success: keep optimistic UI — a follow-up `loadAll` used to apply a stale GET and undo “Clear”. */
        boardDirtyRef.current = false;
      })();
    }, 200);
    return () => window.clearTimeout(t);
  }, [activeCourts, ghostCourts, clubSession, viewer?.role, loadAll, showAlert]);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const isAdminView = viewer?.role === "admin";
  const activeSessionLive = clubSession?.status === "active";
  const playerMembers = sessionMembers.filter((m) => usersById.get(m.userId)?.role === "player");
  const benchMembers = playerMembers
    .filter((m) => m.boardState === "bench")
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const canMutateBoard = Boolean(isAdminView && activeSessionLive);
  const validSelectedBenchIds = new Set(selectedBenchIds.size ? [...selectedBenchIds].filter((id) => benchMembers.some((m) => m.userId === id)) : []);
  const viewerSessionMember =
    viewer?.role === "player" ? sessionMembers.find((m) => m.userId === viewer.id) ?? null : null;
  const viewerBoardSlot = viewer?.role === "player" ? findUserSlot(activeCourts, ghostCourts, viewer.id) : null;

  useEffect(() => {
    const el = courtsColumnRef.current;
    if (!isAdminView || adminTab !== "live" || !el) {
      setBenchPanelHeight(null);
      return;
    }
    const target = el;

    function updateHeight() {
      const desktop = window.matchMedia("(min-width: 1280px)").matches;
      if (!desktop) {
        setBenchPanelHeight(null);
        return;
      }
      setBenchPanelHeight(Math.ceil(target.getBoundingClientRect().height));
    }

    updateHeight();
    const ro = new ResizeObserver(updateHeight);
    ro.observe(target);
    window.addEventListener("resize", updateHeight);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [isAdminView, adminTab, activeCourts, ghostCourts, resultDraft, scoreModalCourtIndex]);

  function markBoardDirty() {
    if (!canMutateBoard) return;
    boardDirtyRef.current = true;
    boardMutationGenRef.current += 1;
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

  function toggleBenchSelection(userId: string) {
    if (!canMutateBoard) return;
    setBenchPlacementMode(null);
    setSelectedBenchIds((prev) => {
      const benchIds = new Set(benchMembers.map((m) => m.userId));
      const next = new Set([...prev].filter((id) => benchIds.has(id)));
      if (next.has(userId)) {
        next.delete(userId);
        return next;
      }
      if (next.size >= 4) {
        showAlert("You can select up to four bench players at a time.", "warning");
        return prev;
      }
      next.add(userId);
      return next;
    });
  }

  function clearBenchSelection() {
    setSelectedBenchIds(new Set());
    setBenchPlacementMode(null);
  }

  function placeSelectedBenchPlayers(courtType: "active" | "ghost", courtIndex: number) {
    if (!canMutateBoard) return;
    const selected = [...selectedBenchIds].filter((id) => benchMembers.some((m) => m.userId === id));
    if (selected.length === 0) {
      showAlert("Select one to four bench players first.", "warning");
      return;
    }
    const targetCourt =
      courtType === "active"
        ? activeCourts.find((c) => c.index === courtIndex)
        : ghostCourts.find((c) => c.sortOrder === courtIndex);
    if (!targetCourt) return;
    const emptySlots = targetCourt.slots.filter((s) => s.userId === null).sort((a, b) => a.slot - b.slot);
    const targetName = courtType === "active" ? `Court ${courtIndex}` : `Queue ${courtIndex}`;
    if (emptySlots.length < selected.length) {
      showAlert(
        `${targetName} only has ${emptySlots.length} open spot${emptySlots.length === 1 ? "" : "s"}. Clear more space or choose another court.`,
        "warning",
      );
      return;
    }

    markBoardDirty();
    let nextActive = activeCourts;
    let nextGhost = ghostCourts;
    selected.forEach((userId, index) => {
      const cleared = stripUserFromBoard(nextActive, nextGhost, userId);
      const next = writeSlot(cleared.active, cleared.ghost, {
        courtType,
        courtIndex,
        slot: emptySlots[index]!.slot,
      }, userId);
      nextActive = next.active;
      nextGhost = next.ghost;
    });
    setActiveCourts(nextActive);
    setGhostCourts(nextGhost);
    setSessionMembers((prev) =>
      prev.map((m) =>
        selected.includes(m.userId) ? { ...m, boardState: courtType === "active" ? "active" : "ghost" } : m,
      ),
    );
    clearBenchSelection();
  }

  /** Empty this court only; everyone currently on it returns to the bench. */
  function clearCourtToBench(courtType: "active" | "ghost", courtIndex: number) {
    if (!canMutateBoard) return;
    const ids =
      courtType === "active"
        ? (activeCourts.find((c) => c.index === courtIndex)?.slots ?? [])
            .map((s) => s.userId)
            .filter((id): id is string => Boolean(id))
        : (ghostCourts.find((c) => c.sortOrder === courtIndex)?.slots ?? [])
            .map((s) => s.userId)
            .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    markBoardDirty();
    if (courtType === "active") {
      setActiveCourts(
        activeCourts.map((c) =>
          c.index !== courtIndex ? c : { ...c, slots: c.slots.map((s) => ({ ...s, userId: null })) },
        ),
      );
    } else {
      setGhostCourts(
        ghostCourts.map((c) =>
          c.sortOrder !== courtIndex ? c : { ...c, slots: c.slots.map((s) => ({ ...s, userId: null })) },
        ),
      );
    }
    ids.forEach((uid) => setState(uid, "bench"));
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
    const rec = getRecommendation({ benchMembers, usersById, now: nowMs });
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
    const merged = {
      winnerSide: resultDraft[courtIndex]?.winnerSide ?? "top",
      winnerScore: resultDraft[courtIndex]?.winnerScore ?? 21,
      loserScore: resultDraft[courtIndex]?.loserScore ?? 18,
    };
    if (merged.winnerScore === "" || merged.loserScore === "") {
      showAlert("Enter both scores before recording.", "warning");
      return;
    }
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
    const now = new Date();
    const snapshotDate = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    const res = await fetch(`/api/club/session/${clubSession.id}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshotDate }),
    });
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

  /** Creates an empty club session and activates it so admins add players from Manage Players. */
  async function startSession() {
    const res = await fetch("/api/club/session", { method: "POST" });
    if (res.status === 409) {
      await loadAll();
      showAlert("A session is already open.", "info");
      return;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showAlert(String((err as { error?: string }).error ?? "Could not create session."), "error");
      return;
    }
    const data = (await res.json()) as { clubSessionId?: string };
    const sid = data.clubSessionId;
    if (!sid) {
      await loadAll();
      showAlert("Session created but response was unexpected. Refresh the page.", "warning");
      return;
    }
    const act = await fetch(`/api/club/session/${sid}/activate`, { method: "POST" });
    if (!act.ok) {
      const err = await act.json().catch(() => ({}));
      await loadAll();
      showAlert(String((err as { error?: string }).error ?? "Could not start live session."), "warning");
      return;
    }
    boardDirtyRef.current = false;
    await loadAll();
    showAlert("Session started with an empty roster. Add players from Manage Players.", "info");
  }

  /** If a draft row exists but activation failed, finish moving it to live (empty roster is allowed). */
  async function continueActivateSession() {
    if (!clubSession || clubSession.status !== "draft") return;
    const res = await fetch(`/api/club/session/${clubSession.id}/activate`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      await loadAll();
      showAlert(String((err as { error?: string }).error ?? "Could not go live."), "warning");
      return;
    }
    boardDirtyRef.current = false;
    await loadAll();
    showAlert("Live session is running. Add or adjust players from Manage Players.", "info");
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
    await fetch(`/api/org/profiles/${userId}`, { method: "DELETE" });
    await loadAll();
  }

  async function addPlayerToSession(userId: string) {
    if (!clubSession) return;
    if (clubSession.status === "draft") {
      const next = [...new Set([...clubSession.rosterProfileIds, userId])];
      const res = await fetch(`/api/club/session/${clubSession.id}/roster`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: next }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showAlert(String((err as { error?: string }).error ?? "Could not update session roster."), "warning");
        return;
      }
    } else if (clubSession.status === "active") {
      const res = await fetch(`/api/club/session/${clubSession.id}/roster`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add: [userId] }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showAlert(String((err as { error?: string }).error ?? "Could not add player to the live session."), "warning");
        return;
      }
    } else {
      return;
    }
    await loadAll();
  }

  async function removePlayerFromSession(userId: string) {
    if (!clubSession) return;
    if (clubSession.status === "draft") {
      const next = clubSession.rosterProfileIds.filter((id) => id !== userId);
      const res = await fetch(`/api/club/session/${clubSession.id}/roster`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: next }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showAlert(String((err as { error?: string }).error ?? "Could not update session roster."), "warning");
        return;
      }
    } else if (clubSession.status === "active") {
      const res = await fetch(`/api/club/session/${clubSession.id}/roster`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remove: [userId] }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showAlert(String((err as { error?: string }).error ?? "Could not remove player from the live session."), "warning");
        return;
      }
    } else {
      return;
    }
    await loadAll();
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
      <SessionHeader
        viewer={viewer}
        sessionPhase={
          clubSession?.status === "active" ? "active" : clubSession?.status === "draft" ? "draft" : "idle"
        }
        onLogout={logout}
      />

      <div className="mx-auto w-full max-w-7xl space-y-4 px-4 pb-6 pt-4 md:px-6 md:pb-8 md:pt-5">
        {isAdminView ? (
          <nav
            className="nav-glass-pills inline-flex max-w-full flex-wrap rounded-full border p-1 ring-1 ring-white/55"
            aria-label="Admin Sections"
          >
            <button
              type="button"
              onClick={() => setAdminTab("live")}
              className={`min-w-[8rem] sm:flex-none sm:min-w-[10rem] ${adminTab === "live" ? "btn-glass-tab-active" : "btn-glass-tab"}`}
            >
              Live Session
            </button>
            <button
              type="button"
              onClick={() => setAdminTab("players")}
              className={`min-w-[8rem] sm:flex-none sm:min-w-[10rem] ${adminTab === "players" ? "btn-glass-tab-active" : "btn-glass-tab"}`}
            >
              Manage Players
            </button>
          </nav>
        ) : null}

        {isAdminView && adminTab === "live" && !clubSession ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-emerald-200/90 bg-gradient-to-br from-emerald-50 via-white to-emerald-50/30 px-4 py-4 shadow-sm ring-1 ring-emerald-100/80 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-zinc-900">Start a live session</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-600 sm:text-sm">
                Opens an empty session so courts and bench are ready. Add people from{" "}
                <span className="font-medium text-zinc-800">Manage Players</span> whenever you like.
              </p>
            </div>
            <ActionButton
              variant="success"
              className="w-full min-h-[48px] shrink-0 touch-manipulation sm:w-auto sm:min-w-[12rem]"
              onClick={() => void startSession()}
            >
              Start session
            </ActionButton>
          </div>
        ) : null}

        {isAdminView && adminTab === "live" && clubSession?.status === "draft" ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-amber-200/90 bg-amber-50/90 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <p className="text-sm text-amber-950">
              This session is still in <span className="font-semibold">draft</span> — finish going live (empty roster is fine), or refresh if something went wrong.
            </p>
            <ActionButton
              variant="success"
              className="w-full min-h-[48px] shrink-0 touch-manipulation sm:w-auto sm:min-w-[10rem]"
              onClick={() => void continueActivateSession()}
            >
              Go live
            </ActionButton>
          </div>
        ) : null}

        {isAdminView && adminTab === "live" && clubSession?.status === "active" ? (
          <div className="rounded-2xl border border-amber-200/80 bg-amber-50/70 p-4 shadow-sm sm:p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-900/80">End session</p>
            <p className="mt-1 text-sm leading-relaxed text-zinc-700 md:max-w-3xl">
              Everyone&apos;s board clears when you finish. Save a dated snapshot first, or close without saving if you didn&apos;t need a record.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <ActionButton className="w-full" variant="primary" onClick={() => void finishSession()}>
                {"Save Snapshot & Close"}
              </ActionButton>
              <ActionButton className="w-full" variant="danger" onClick={() => void abandonSessionNoSave()}>
                Close Without Saving
              </ActionButton>
            </div>
          </div>
        ) : null}

        {viewer.role === "player" ? (
          <PlayerSessionBanner
            activeSessionLive={activeSessionLive}
            member={viewerSessionMember}
            boardSlot={viewerBoardSlot}
          />
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

            <div className="grid gap-4 xl:grid-cols-12 xl:items-start">
              <div
                ref={courtsColumnRef}
                className={isAdminView ? "space-y-4 xl:col-span-8" : "mx-auto w-full max-w-5xl space-y-4 xl:col-span-12"}
              >
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
                              className="btn-glass btn-glass-success w-full rounded-lg px-2 py-1.5 text-center text-xs font-medium"
                            >
                              Record Match Result
                            </button>
                          ) : undefined
                        }
                        onClearCourt={isAdminView && canMutateBoard ? () => clearCourtToBench("active", court.index) : undefined}
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
                        onClearCourt={isAdminView && canMutateBoard ? () => clearCourtToBench("ghost", court.sortOrder) : undefined}
                      />
                    ))}
                  </div>
                </SectionContainer>
              </div>

              {isAdminView ? (
                <div
                  className="min-h-0 xl:col-span-4 xl:overflow-hidden"
                  style={benchPanelHeight ? { height: benchPanelHeight, maxHeight: benchPanelHeight } : undefined}
                >
                  <BenchPanel
                    members={benchMembers}
                    usersById={usersById}
                    nowMs={nowMs}
                    onDropToBench={handleDropToBench}
                    canDrag={Boolean(canMutateBoard)}
                    selectedIds={validSelectedBenchIds}
                    placementMode={benchPlacementMode}
                    activeCourts={activeCourts}
                    ghostCourts={ghostCourts}
                    onToggleSelected={toggleBenchSelection}
                    onClearSelection={clearBenchSelection}
                    onPlacementModeChange={setBenchPlacementMode}
                    onPlaceSelected={placeSelectedBenchPlayers}
                    showMatchSuggest={activeSessionLive}
                    canUseMatchSuggest={canMutateBoard}
                    onOpenMatchSuggest={() => setBenchSuggestOpen(true)}
                    heightPx={benchPanelHeight}
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
          <ManagePlayersPanel
            players={rosterPlayers}
            clubSession={clubSession}
            sessionMembers={sessionMembers}
            onAdd={addOrgPlayer}
            onUpdate={updateOrgPlayer}
            onPermaDelete={deleteOrgPlayer}
            onSessionRosterAdd={addPlayerToSession}
            onSessionRosterRemove={removePlayerFromSession}
          />
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

function PlayerSessionBanner(props: {
  activeSessionLive: boolean;
  member: SessionMember | null;
  boardSlot: SlotLocation | null;
}) {
  if (!props.activeSessionLive) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-zinc-900">No live session right now</p>
            <p className="mt-0.5 text-xs text-zinc-500">Waiting for the admin to start the next session.</p>
          </div>
          <span className="inline-flex w-fit items-center rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600 ring-1 ring-zinc-200">
            Standby
          </span>
        </div>
      </div>
    );
  }

  if (!props.member) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-gradient-to-r from-amber-50 via-white to-white px-4 py-3 shadow-sm ring-1 ring-amber-100">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-amber-950">Live session is running, but you are not in it</p>
            <p className="mt-0.5 text-xs leading-relaxed text-amber-800/80">
              Ask the admin to add you. Until then, this is a spectator view with live court updates.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex w-fit items-center rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-200">
              Not in session
            </span>
            <span className="inline-flex w-fit items-center rounded-full bg-white px-3 py-1 text-xs font-semibold text-zinc-600 ring-1 ring-zinc-200">
              Live updates on
            </span>
          </div>
        </div>
      </div>
    );
  }

  const status =
    props.member.boardState === "active"
      ? "Playing"
      : props.member.boardState === "ghost"
        ? "Queue"
        : props.member.boardState === "break"
          ? "Break"
          : "Bench";
  const location =
    props.boardSlot?.courtType === "active"
      ? `Court ${props.boardSlot.courtIndex}`
      : props.boardSlot?.courtType === "ghost"
        ? `Queue ${props.boardSlot.courtIndex}`
        : status === "Bench"
          ? "Bench"
          : status;
  const tone =
    props.member.boardState === "active"
      ? "border-emerald-200 from-emerald-50 via-white to-white ring-emerald-100"
      : props.member.boardState === "ghost"
        ? "border-sky-200 from-sky-50 via-white to-white ring-sky-100"
        : "border-zinc-200 from-zinc-50 via-white to-white ring-zinc-100";
  const statusTone =
    props.member.boardState === "active"
      ? "bg-emerald-100 text-emerald-900 ring-emerald-200"
      : props.member.boardState === "ghost"
        ? "bg-sky-100 text-sky-900 ring-sky-200"
        : "bg-zinc-100 text-zinc-700 ring-zinc-200";

  return (
    <div className={`rounded-2xl border bg-gradient-to-r px-4 py-3 shadow-sm ring-1 ${tone}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-zinc-900">You are in this session</p>
          <p className="mt-0.5 text-xs text-zinc-600">
            Current status: <span className="font-semibold text-zinc-900">{location}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className={`inline-flex w-fit items-center rounded-full px-3 py-1 text-xs font-semibold ring-1 ${statusTone}`}>
            {status}
          </span>
          <span className="inline-flex w-fit items-center rounded-full bg-white px-3 py-1 text-xs font-semibold text-zinc-600 ring-1 ring-zinc-200">
            Live updates on
          </span>
        </div>
      </div>
    </div>
  );
}

function IconPencil(props: { className?: string }) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.875 4.875 0 0 1-1.174 1.956l-1.107.885c-.792.633-1.956.022-1.847-1.006l.25-2.188a4.875 4.875 0 0 1 1.174-1.956L16.862 4.487Z"
      />
    </svg>
  );
}

type ManagePlayersSort = "name_asc" | "mmr_desc" | "mmr_asc";
type ManagePlayersSessionFilter = "all" | "in_session" | "inactive";

function managePlayerPresence(
  userId: string,
  rosterIdSet: Set<string>,
  memberById: Map<string, SessionMember>,
): { label: string; tone: "inactive" | "playing" | "queue" | "bench" | "break" } {
  if (!rosterIdSet.has(userId)) return { label: "Not in session", tone: "inactive" };
  const m = memberById.get(userId);
  if (!m) return { label: "Bench", tone: "bench" };
  if (m.boardState === "active") return { label: "Playing", tone: "playing" };
  if (m.boardState === "ghost") return { label: "Queue", tone: "queue" };
  if (m.boardState === "break") return { label: "Break", tone: "break" };
  return { label: "Bench", tone: "bench" };
}

function managePresenceChipClass(tone: ReturnType<typeof managePlayerPresence>["tone"]) {
  switch (tone) {
    case "inactive":
      return "bg-zinc-100 text-zinc-700 ring-zinc-200/80";
    case "playing":
      return "bg-emerald-100 text-emerald-900 ring-emerald-200/80";
    case "queue":
      return "bg-violet-100 text-violet-900 ring-violet-200/80";
    case "bench":
      return "bg-sky-100 text-sky-900 ring-sky-200/80";
    case "break":
      return "bg-amber-100 text-amber-950 ring-amber-200/80";
    default:
      return "bg-zinc-100 text-zinc-800 ring-zinc-200/80";
  }
}

function ManagePlayersPanel(props: {
  players: User[];
  clubSession: ClubSessionDto;
  sessionMembers: SessionMember[];
  onAdd: (input: { username: string; password: string; name: string; mmr: number }) => boolean | Promise<boolean>;
  onUpdate: (userId: string, patch: { name: string; mmr: number }) => void | Promise<void>;
  onPermaDelete: (userId: string) => void | Promise<void>;
  onSessionRosterAdd: (userId: string) => void | Promise<void>;
  onSessionRosterRemove: (userId: string) => void | Promise<void>;
}) {
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [newMmr, setNewMmr] = useState(DEFAULT_MMR);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<ManagePlayersSort>("name_asc");
  const [sessionFilter, setSessionFilter] = useState<ManagePlayersSessionFilter>("all");
  const [adding, setAdding] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editMmr, setEditMmr] = useState(DEFAULT_MMR);
  const [permaDeleteMode, setPermaDeleteMode] = useState(false);
  const [sessionBusyId, setSessionBusyId] = useState<string | null>(null);

  const rosterIdSet = useMemo(
    () => new Set(props.clubSession?.rosterProfileIds ?? []),
    [props.clubSession?.rosterProfileIds],
  );
  const memberById = useMemo(
    () => new Map(props.sessionMembers.map((m) => [m.userId, m])),
    [props.sessionMembers],
  );

  const sortedPlayers = useMemo(() => {
    const copy = [...props.players];
    if (sortMode === "name_asc") {
      copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    } else if (sortMode === "mmr_desc") {
      copy.sort((a, b) => b.mmr - a.mmr || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    } else {
      copy.sort((a, b) => a.mmr - b.mmr || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    }
    return copy;
  }, [props.players, sortMode]);

  const filteredPlayers = useMemo(() => {
    let list = sortedPlayers;
    if (sessionFilter === "in_session") list = list.filter((p) => rosterIdSet.has(p.id));
    else if (sessionFilter === "inactive") list = list.filter((p) => !rosterIdSet.has(p.id));
    const q = searchQuery.trim().toLowerCase();
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q));
    return list;
  }, [sortedPlayers, sessionFilter, searchQuery, rosterIdSet]);

  const canMutateSessionRoster = Boolean(
    props.clubSession && (props.clubSession.status === "draft" || props.clubSession.status === "active"),
  );

  function enterPermaDeleteMode() {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "This turns on destructive delete mode.\n\nEach card will show an X. Clicking it permanently deletes that login — they cannot sign in again until you create a new player.\n\nTo take someone off the live session only, use the minus (−) control on their card instead.\n\nContinue?",
      )
    ) {
      return;
    }
    setPermaDeleteMode(true);
  }

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
                New player account
              </h2>
            </header>
            <div className="space-y-4 overflow-y-auto overscroll-contain px-5 py-5">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-700">Name</span>
                <input
                  autoComplete="name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className={inputUi}
                  placeholder="Jamie Chan"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-700">Username</span>
                <input
                  autoComplete="username"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  className={inputUi}
                  placeholder="jamie.chan"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-700">Password</span>
                <PasswordField
                  value={newPassword}
                  onChange={setNewPassword}
                  autoComplete="new-password"
                  placeholder="jamie123"
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
                className="btn-glass btn-glass-subtle w-full rounded-xl px-4 py-3 text-sm sm:w-auto sm:py-2.5"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={adding}
                onClick={() => void submitAdd()}
                className="btn-glass btn-glass-success w-full rounded-xl px-4 py-3 text-sm sm:w-auto sm:min-w-[8.5rem] sm:py-2.5"
              >
                {adding ? "Creating…" : "Create account"}
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
                {searchQuery.trim() || sessionFilter !== "all"
                  ? ` · ${filteredPlayers.length} shown`
                  : ""}
              </p>
              {!props.clubSession ? (
                <p className="mt-2 max-w-xl text-xs leading-relaxed text-amber-900/90">
                  No session yet — use Live Session to start a session, then add players here.
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {permaDeleteMode ? (
                <button
                  type="button"
                  onClick={() => setPermaDeleteMode(false)}
                  className="btn-glass btn-glass-subtle inline-flex min-h-[44px] shrink-0 touch-manipulation items-center justify-center gap-2 rounded-xl border-zinc-300/80 px-4 py-2.5 text-sm"
                >
                  Done deleting
                </button>
              ) : (
                <button
                  type="button"
                  onClick={enterPermaDeleteMode}
                  className="inline-flex min-h-[44px] shrink-0 touch-manipulation items-center justify-center gap-2 rounded-xl border border-red-200/90 bg-red-50/80 px-4 py-2.5 text-sm font-medium text-red-900 shadow-sm ring-1 ring-red-200/60 transition hover:bg-red-100/90"
                >
                  Delete accounts
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="btn-glass btn-glass-success inline-flex min-h-[44px] shrink-0 touch-manipulation items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm"
              >
                <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Create account
              </button>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-zinc-200/90 bg-white p-3 shadow-sm sm:p-4">
            <div className="flex flex-col gap-4 min-[720px]:flex-row min-[720px]:items-end min-[720px]:gap-3">
              <div className="min-w-0 min-[720px]:min-w-[8rem] min-[720px]:flex-1">
                <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">Search</span>
                <label className="relative block">
                  <span className="sr-only">Search by name</span>
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
                    placeholder="Name…"
                    className={`${inputUi} h-10 py-0 pl-10`}
                  />
                </label>
              </div>
              <div className="grid min-w-0 gap-3 min-[720px]:ml-auto min-[720px]:w-max min-[720px]:shrink-0 min-[720px]:grid-cols-[10rem_13.75rem] min-[720px]:items-end min-[720px]:gap-2 md:grid-cols-[10.75rem_14.75rem] lg:grid-cols-[11.75rem_16rem] xl:grid-cols-[12.25rem_17rem]">
                <div className="min-w-0">
                  <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">Sort</span>
                  <div
                    className="grid w-full max-w-full grid-cols-3 rounded-lg border border-zinc-200/90 bg-zinc-100/90 p-0.5"
                    role="group"
                    aria-label="Sort players"
                  >
                    {(
                      [
                        ["name_asc", "Name"] as const,
                        ["mmr_desc", "MMR ↓"] as const,
                        ["mmr_asc", "MMR ↑"] as const,
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSortMode(key)}
                        className={`min-h-9 rounded-md px-2 py-1.5 text-center text-xs font-semibold transition ${
                          sortMode === key
                            ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200/90"
                            : "text-zinc-600 hover:text-zinc-900"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="min-w-0">
                  <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">Filter</span>
                  <div
                    className="grid w-full max-w-full grid-cols-3 rounded-lg border border-zinc-200/90 bg-zinc-100/90 p-0.5"
                    role="group"
                    aria-label="Filter by session membership"
                  >
                    {(
                      [
                        ["all", "All"] as const,
                        ["in_session", "In session"] as const,
                        ["inactive", "Not in session"] as const,
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSessionFilter(key)}
                        className={`min-h-9 rounded-md px-2 py-1.5 text-center text-[11px] font-semibold leading-tight transition sm:text-xs ${
                          sessionFilter === key
                            ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200/90"
                            : "text-zinc-600 hover:text-zinc-900"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {permaDeleteMode ? (
          <div className="border-b border-red-200/80 bg-red-50/90 px-4 py-2.5 text-center text-[11px] font-medium leading-snug text-red-950 sm:px-6">
            Delete mode is on — only tap an X if you mean to permanently remove that account.
          </div>
        ) : null}

        {props.players.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 text-2xl text-zinc-400">
              +
            </div>
            <p className="text-sm font-medium text-zinc-800">No players yet</p>
            <p className="max-w-xs text-xs text-zinc-500">Use Create account, or load seed accounts from your setup script.</p>
          </div>
        ) : filteredPlayers.length === 0 ? (
          <div className="px-6 py-14 text-center text-sm text-zinc-600">
            No players match — try another search, filter, or sort.
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 sm:gap-3 sm:p-4">
            {filteredPlayers.map((u) => {
              const presence = managePlayerPresence(u.id, rosterIdSet, memberById);
              return (
              <li
                key={u.id}
                className={`relative rounded-lg border bg-white p-3 shadow-sm transition-shadow ${
                  editingId === u.id
                    ? "border-emerald-300 ring-2 ring-emerald-100"
                    : "border-zinc-200/90 hover:border-zinc-300 hover:shadow"
                }`}
              >
                {permaDeleteMode && editingId !== u.id ? (
                  <button
                    type="button"
                    title={`Permanently delete ${u.name}`}
                    aria-label={`Permanently delete ${u.name}`}
                    onClick={() => {
                      if (
                        typeof window !== "undefined" &&
                        window.confirm(
                          `Permanently delete ${u.name}?\n\nTheir account is removed from this organization. This cannot be undone.`,
                        )
                      ) {
                        void props.onPermaDelete(u.id);
                      }
                    }}
                    className="absolute right-1.5 top-1.5 z-[1] flex size-7 items-center justify-center rounded-full border border-red-300/90 bg-white text-base font-light leading-none text-red-600 shadow ring-1 ring-red-200/50 transition hover:bg-red-50 active:scale-95"
                  >
                    <span aria-hidden>×</span>
                  </button>
                ) : null}
                <div className="flex gap-2.5">
                  <div
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200/90 bg-gradient-to-br from-emerald-50/90 to-white text-[10px] font-bold text-emerald-900 shadow-sm"
                    aria-hidden
                  >
                    {displayInitials(editingId === u.id ? editName : u.name)}
                  </div>
                  <div className="min-w-0 flex-1 pr-6">
                    {editingId === u.id ? (
                      <>
                        <div className="space-y-2.5">
                          <label className="block min-w-0">
                            <span className="mb-1 block text-[11px] font-medium text-zinc-600">Name</span>
                            <input
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              className={inputUi}
                            />
                          </label>
                          <label className="block w-full max-w-[8.5rem]">
                            <span className="mb-1 block text-[11px] font-medium text-zinc-600">MMR</span>
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
                        <div className="flex flex-wrap gap-2 pt-0.5">
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="rounded-lg border border-zinc-200/90 bg-white/80 px-2.5 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => void saveEdit(u.id)}
                            className="rounded-lg bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-800"
                          >
                            Save
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="min-w-0 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0">
                                <span className="truncate text-sm font-semibold leading-tight text-zinc-900">{u.name}</span>
                                <span className="shrink-0 text-xs text-zinc-300" aria-hidden>
                                  ·
                                </span>
                                <span className="shrink-0 text-xs font-semibold tabular-nums text-zinc-600">{u.mmr}</span>
                              </div>
                              <p className="mt-0.5 truncate font-mono text-[11px] leading-tight text-zinc-500">
                                {u.username || "—"}
                              </p>
                            </div>
                            <span
                              className={`max-w-[9.5rem] shrink-0 truncate rounded-full px-2 py-0.5 text-center text-[10px] font-semibold leading-tight ring-1 ring-inset sm:max-w-none sm:whitespace-nowrap ${managePresenceChipClass(presence.tone)}`}
                            >
                              {presence.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 border-t border-zinc-100 pt-2">
                            <button
                              type="button"
                              onClick={() => startEdit(u)}
                              title="Edit name and MMR"
                              aria-label={`Edit ${u.name}`}
                              className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 text-[11px] font-semibold text-zinc-700 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900"
                            >
                              <IconPencil className="size-3.5" />
                              <span>Edit</span>
                            </button>
                            {canMutateSessionRoster ? (
                              rosterIdSet.has(u.id) ? (
                                <button
                                  type="button"
                                  disabled={sessionBusyId !== null}
                                  title={`Remove ${u.name} from this session`}
                                  aria-label={`Remove ${u.name} from this session`}
                                  onClick={() => {
                                    setSessionBusyId(u.id);
                                    void Promise.resolve(props.onSessionRosterRemove(u.id)).finally(() =>
                                      setSessionBusyId(null),
                                    );
                                  }}
                                  className="flex h-8 min-w-0 flex-1 items-center justify-center rounded-md border border-amber-200/90 bg-amber-50 px-2 text-[11px] font-semibold text-amber-950 shadow-sm transition hover:bg-amber-100/90 disabled:opacity-50"
                                >
                                  {sessionBusyId === u.id ? "Updating" : "Remove"}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={sessionBusyId !== null}
                                  title={`Add ${u.name} to this session`}
                                  aria-label={`Add ${u.name} to this session`}
                                  onClick={() => {
                                    setSessionBusyId(u.id);
                                    void Promise.resolve(props.onSessionRosterAdd(u.id)).finally(() =>
                                      setSessionBusyId(null),
                                    );
                                  }}
                                  className="flex h-8 min-w-0 flex-1 items-center justify-center rounded-md border border-emerald-200/90 bg-emerald-50 px-2 text-[11px] font-semibold text-emerald-950 shadow-sm transition hover:bg-emerald-100/90 disabled:opacity-50"
                                >
                                  {sessionBusyId === u.id ? "Updating" : "Add"}
                                </button>
                              )
                            ) : null}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </li>
              );
            })}
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
    "btn-glass flex min-h-[48px] w-full items-center justify-center rounded-xl px-4 text-sm text-center font-semibold";

  return (
    <div className={shell}>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-900">Which team won?</h3>
        <div className="grid grid-cols-1 gap-2">
          <button
            type="button"
            onClick={() => props.setDraft({ ...draft, winnerSide: "top" })}
            aria-label={`Winning team: ${topLine}`}
            className={`${teamBtn} ${
              draft.winnerSide === "top" ? "btn-glass-success" : "btn-glass-subtle"
            }`}
          >
            <span className="truncate">{topLine}</span>
          </button>
          <button
            type="button"
            onClick={() => props.setDraft({ ...draft, winnerSide: "bottom" })}
            aria-label={`Winning team: ${bottomLine}`}
            className={`${teamBtn} ${
              draft.winnerSide === "bottom" ? "btn-glass-success" : "btn-glass-subtle"
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
              onChange={(e) =>
                props.setDraft({
                  ...draft,
                  winnerScore: e.target.value === "" ? "" : Number(e.target.value),
                })
              }
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
              onChange={(e) =>
                props.setDraft({
                  ...draft,
                  loserScore: e.target.value === "" ? "" : Number(e.target.value),
                })
              }
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-center text-sm tabular-nums shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              aria-label="Loser score"
            />
          </div>
        </div>
      </section>

      <button
        onClick={props.onFinish}
        className="btn-glass btn-glass-primary w-full rounded-xl py-3 text-sm"
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
            aria-label="Close record match result"
            title="Close"
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-xl font-light leading-none text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          >
            <span aria-hidden>×</span>
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
    info: "btn-glass-primary",
    warning: "btn-glass-warning",
    error: "btn-glass-danger",
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
          className={`btn-glass mt-4 w-full rounded-lg py-2.5 text-sm ${buttonStyles[props.tone]}`}
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
      ? { cls: "bg-emerald-400/25 text-emerald-50 ring-emerald-300/40", label: "Live" }
      : props.sessionPhase === "draft"
        ? { cls: "bg-amber-400/25 text-amber-50 ring-amber-300/35", label: "Draft" }
        : { cls: "bg-white/12 text-zinc-200 ring-white/20", label: "Idle" };

  const accountType = props.viewer.role === "admin" ? "Administrator" : "Member";

  const fn = props.viewer.firstName.trim();
  const ln = props.viewer.lastName.trim();
  const headlineFirst = fn || props.viewer.name.trim() || "—";
  const headlineLast = ln;

  const avatarLabel = fn || ln ? [fn, ln].filter(Boolean).join(" ").trim() : props.viewer.name;

  return (
    <header className="relative z-20 w-full border-b border-emerald-500/25 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.35)] backdrop-blur-sm">
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-950 via-zinc-900 to-teal-950"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_100%_120%_at_15%_-30%,rgba(52,211,153,0.22),transparent_52%),radial-gradient(ellipse_80%_100%_at_95%_120%,rgba(20,184,166,0.12),transparent_45%)]"
        aria-hidden
      />

      <div className="relative h-px w-full bg-gradient-to-r from-transparent via-emerald-300/70 to-transparent" aria-hidden />

      <div className="relative flex min-h-[4.75rem] w-full items-center gap-4 px-5 py-3.5 sm:min-h-[5.25rem] sm:px-10 sm:py-4 lg:px-14 xl:px-16">
        <div className="flex min-w-0 flex-1 items-center gap-4 sm:gap-5">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-white/20 bg-white/10 text-[10px] font-black uppercase tracking-[0.2em] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-md sm:size-[3.25rem] sm:text-xs sm:tracking-widest"
            aria-hidden
          >
            <span className="px-1 text-center">{ORG_NAME.slice(0, 3)}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.26em] text-emerald-200/95 sm:text-xs">
                {ORG_NAME}
              </p>
              <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset sm:text-[11px] ${badge.cls}`}>
                {badge.label}
              </span>
            </div>
            <h1 className="mt-0.5 truncate text-xl font-bold tracking-tight text-white sm:text-2xl lg:text-[1.65rem]">
              Badminton Court Manager
            </h1>
          </div>
        </div>

        <div ref={wrapRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-haspopup="dialog"
            aria-label={`Account (${headlineFirst}${headlineLast ? ` ${headlineLast}` : ""})`}
            title="Account"
            className={`flex size-11 shrink-0 items-center justify-center rounded-full border border-white/30 bg-white/15 text-[10px] font-bold uppercase tracking-tight text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_4px_14px_rgba(0,0,0,0.25)] backdrop-blur-md transition hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/80 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 sm:size-12 sm:text-xs ${
              menuOpen ? "ring-2 ring-emerald-200/70 ring-offset-2 ring-offset-zinc-900" : ""
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
                      <dt className="text-xs font-medium text-zinc-500">Username</dt>
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
                    className="btn-glass btn-glass-subtle w-full rounded-xl px-3 py-2.5 text-center text-sm"
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

function SectionContainer(props: {
  title: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  action?: React.ReactNode;
}) {
  return (
    <section className={`rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm ${props.className ?? ""}`} style={props.style}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{props.title}</h2>
        {props.action ? <div className="shrink-0">{props.action}</div> : null}
      </div>
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
  const { open, onClose } = props;
  const rec = props.recommendation;
  const needMore = Math.max(0, 4 - props.benchCount);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

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
            className="btn-glass-icon -mr-1 -mt-1 size-10 touch-manipulation focus-visible:ring-2 focus-visible:ring-violet-400/70 focus-visible:ring-offset-2"
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
                className="btn-glass btn-glass-violet w-full rounded-xl px-4 py-3.5 text-sm"
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
                className="btn-glass btn-glass-success w-full rounded-xl px-4 py-3.5 text-sm"
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
  onClearCourt?: () => void;
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
          {props.tone === "active" ? "Playing" : "Queue"}
        </span>
      </div>

      <div className="relative rounded-xl border border-emerald-200 bg-gradient-to-b from-emerald-50 via-emerald-100 to-emerald-200 p-2.5">
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 items-start gap-2">{renderSlotRow([1, 2])}</div>
          <div className="relative flex items-center justify-center py-0.5">
            <div className="h-0.5 w-full rounded-full bg-white/80 shadow-sm" aria-hidden />
            <span className="absolute rounded-full bg-white/95 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-900 shadow-sm">
              Net
            </span>
          </div>
          <div className="grid grid-cols-2 items-start gap-2">{renderSlotRow([3, 4])}</div>
        </div>
      </div>
      {props.footerSlot || props.onClearCourt ? (
        <div className="mt-2 space-y-1.5">
          {props.footerSlot}
          {props.onClearCourt ? (
            <button
              type="button"
              onClick={props.onClearCourt}
              title="Clear this court — everyone returns to the bench"
              className="w-full rounded-lg border border-zinc-300/70 bg-white/60 px-2 py-1 text-center text-[11px] font-medium text-zinc-600 backdrop-blur-sm transition hover:bg-white/85 hover:text-zinc-900"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
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
  const slotShell = "min-h-[74px] h-[74px] max-h-[74px]";
  if (!props.user) {
    return (
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          props.onCourtSlotDrop(e);
        }}
        className={`rounded-xl border border-dashed border-white/80 bg-white/35 ${slotShell}`}
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
      className={`${slotShell} overflow-hidden rounded-xl`}
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

type BenchSort = "wait_desc" | "wait_asc" | "games_asc" | "games_desc" | "mmr_desc" | "mmr_asc";

function BenchPanel(props: {
  members: SessionMember[];
  usersById: Map<string, User>;
  nowMs: number;
  onDropToBench: (e: DragEvent) => void;
  canDrag: boolean;
  selectedIds: Set<string>;
  placementMode: "active" | "ghost" | null;
  activeCourts: ActiveCourt[];
  ghostCourts: GhostCourt[];
  onToggleSelected: (userId: string) => void;
  onClearSelection: () => void;
  onPlacementModeChange: (mode: "active" | "ghost" | null) => void;
  onPlaceSelected: (courtType: "active" | "ghost", courtIndex: number) => void;
  /** While the session is live, show “generate match” as a bench action. */
  showMatchSuggest?: boolean;
  canUseMatchSuggest?: boolean;
  onOpenMatchSuggest?: () => void;
  heightPx?: number | null;
}) {
  const suggest = Boolean(props.showMatchSuggest && props.onOpenMatchSuggest);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<BenchSort>("wait_desc");

  const visibleMembers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return props.members
      .map((member) => {
        const user = props.usersById.get(member.userId);
        return user ? { member, user } : null;
      })
      .filter((entry): entry is { member: SessionMember; user: User } => {
        if (!entry) return false;
        if (!q) return true;
        return entry.user.name.toLowerCase().includes(q) || entry.user.username.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const waitDiff = minutesWaitingOffCourt(a.member, props.nowMs) - minutesWaitingOffCourt(b.member, props.nowMs);
        const gameDiff = a.member.gamesPlayed - b.member.gamesPlayed;
        const mmrDiff = a.user.mmr - b.user.mmr;
        const nameDiff = a.user.name.localeCompare(b.user.name, undefined, { sensitivity: "base" });
        if (sortMode === "mmr_asc") return mmrDiff || -waitDiff || nameDiff;
        if (sortMode === "mmr_desc") return -mmrDiff || -waitDiff || nameDiff;
        if (sortMode === "games_asc") return gameDiff || -waitDiff || nameDiff;
        if (sortMode === "games_desc") return -gameDiff || -waitDiff || nameDiff;
        if (sortMode === "wait_asc") return waitDiff || gameDiff || nameDiff;
        return -waitDiff || gameDiff || nameDiff;
      });
  }, [props.members, props.nowMs, props.usersById, searchQuery, sortMode]);

  function toggleBenchSort(field: "wait" | "games" | "mmr") {
    setSortMode((prev) => {
      if (field === "wait") return prev === "wait_desc" ? "wait_asc" : "wait_desc";
      if (field === "mmr") return prev === "mmr_desc" ? "mmr_asc" : "mmr_desc";
      return prev === "games_asc" ? "games_desc" : "games_asc";
    });
  }

  function sortArrow(field: "wait" | "games" | "mmr") {
    if (field === "wait") {
      if (sortMode === "wait_desc") return "↓";
      if (sortMode === "wait_asc") return "↑";
    }
    if (field === "mmr") {
      if (sortMode === "mmr_desc") return "↓";
      if (sortMode === "mmr_asc") return "↑";
    }
    if (field === "games") {
      if (sortMode === "games_desc") return "↓";
      if (sortMode === "games_asc") return "↑";
    }
    return "";
  }

  const selectedCount = props.selectedIds.size;
  const placementCourts = props.placementMode === "active" ? props.activeCourts : props.ghostCourts;
  const suggestAction = suggest ? (
    <button
      type="button"
      title="Pick four balanced players from the bench"
      disabled={!props.canUseMatchSuggest}
      onClick={() => props.onOpenMatchSuggest?.()}
      className="btn-glass btn-glass-subtle inline-flex h-8 touch-manipulation items-center gap-1.5 rounded-lg border-violet-200/70 px-2.5 text-xs font-semibold text-violet-800 hover:border-violet-300/85 hover:bg-violet-50/55 disabled:opacity-50"
    >
      <svg className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
        />
      </svg>
      Suggest
    </button>
  ) : null;

  return (
    <SectionContainer
      title="Bench"
      className="flex h-full min-h-[28rem] flex-col overflow-hidden lg:min-h-0"
      style={props.heightPx ? { height: props.heightPx, maxHeight: props.heightPx } : undefined}
      action={suggestAction}
    >
      <div className="flex min-h-0 flex-1 flex-col space-y-3">
        <div className="shrink-0">
          <label className="relative block min-w-0">
            <span className="sr-only">Search bench players</span>
            <svg
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400"
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
              placeholder="Search bench"
              className="h-9 w-full rounded-lg border border-zinc-200 bg-white py-0 pl-8 pr-2 text-xs text-zinc-900 shadow-sm outline-none placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
            />
          </label>
        </div>
        {selectedCount > 0 ? (
          <div className="shrink-0 rounded-xl border border-emerald-200 bg-emerald-50/80 p-2 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold text-emerald-950">{selectedCount}/4 selected</p>
              <button
                type="button"
                onClick={props.onClearSelection}
                className="rounded-md px-2 py-1 text-[11px] font-semibold text-zinc-500 transition hover:bg-white/80 hover:text-zinc-800"
              >
                Clear
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => props.onPlacementModeChange(props.placementMode === "active" ? null : "active")}
                className={`h-8 rounded-lg px-2 text-[11px] font-semibold transition ${
                  props.placementMode === "active"
                    ? "bg-emerald-700 text-white shadow-sm"
                    : "bg-white text-emerald-900 ring-1 ring-emerald-200 hover:bg-emerald-50"
                }`}
              >
                Add to active court
              </button>
              <button
                type="button"
                onClick={() => props.onPlacementModeChange(props.placementMode === "ghost" ? null : "ghost")}
                className={`h-8 rounded-lg px-2 text-[11px] font-semibold transition ${
                  props.placementMode === "ghost"
                    ? "bg-sky-700 text-white shadow-sm"
                    : "bg-white text-sky-900 ring-1 ring-sky-200 hover:bg-sky-50"
                }`}
              >
                Add to queue court
              </button>
            </div>
            {props.placementMode ? (
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                {placementCourts.map((court) => {
                  const courtIndex = props.placementMode === "active" ? (court as ActiveCourt).index : (court as GhostCourt).sortOrder;
                  const openSlots = court.slots.filter((slot) => slot.userId === null).length;
                  return (
                    <button
                      key={`${props.placementMode}-${courtIndex}`}
                      type="button"
                      onClick={() => props.onPlaceSelected(props.placementMode!, courtIndex)}
                      className="min-h-9 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-zinc-800 ring-1 ring-zinc-200 transition hover:bg-zinc-50"
                    >
                      <span>{props.placementMode === "active" ? "Court" : "Queue"} {courtIndex}</span>
                      <span className="ml-1 text-[10px] font-medium text-zinc-500">({openSlots} open)</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            props.onDropToBench(e);
          }}
          className="min-h-0 flex-1 space-y-1.5 overflow-y-scroll overscroll-contain rounded-2xl border border-emerald-200 bg-emerald-50/70 p-2.5 pr-1.5 shadow-sm"
        >
          {props.members.length > 0 ? (
            <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,1.45fr)_2.8rem_3.4rem_3rem_3.2rem] items-center gap-1.5 rounded-lg border border-emerald-200/80 bg-emerald-50/95 px-2 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-950 shadow-sm backdrop-blur md:grid">
              <span>Player</span>
              <button
                type="button"
                onClick={() => toggleBenchSort("mmr")}
                className={`rounded px-1 py-0.5 text-center transition hover:bg-white/70 ${
                  sortMode.startsWith("mmr") ? "bg-white text-emerald-950 shadow-sm" : ""
                }`}
                aria-label="Sort bench by MMR"
              >
                MMR {sortArrow("mmr")}
              </button>
              <span className="text-center">Record</span>
              <button
                type="button"
                onClick={() => toggleBenchSort("games")}
                className={`rounded px-1 py-0.5 text-center transition hover:bg-white/70 ${
                  sortMode.startsWith("games") ? "bg-white text-emerald-950 shadow-sm" : ""
                }`}
                aria-label="Sort bench by games played"
              >
                Games {sortArrow("games")}
              </button>
              <button
                type="button"
                onClick={() => toggleBenchSort("wait")}
                className={`rounded px-1 py-0.5 text-center transition hover:bg-white/70 ${
                  sortMode.startsWith("wait") ? "bg-white text-emerald-950 shadow-sm" : ""
                }`}
                aria-label="Sort bench by wait time"
              >
                Wait {sortArrow("wait")}
              </button>
            </div>
          ) : null}
          {props.members.length > 0 ? (
            <div className="sticky top-0 z-10 flex gap-1 rounded-lg border border-emerald-200/80 bg-emerald-50/95 p-1 text-[10px] font-semibold text-emerald-950 shadow-sm backdrop-blur md:hidden">
              {(
                [
                  ["mmr", "MMR"] as const,
                  ["games", "Games"] as const,
                  ["wait", "Wait"] as const,
                ] as const
              ).map(([field, label]) => (
                <button
                  key={field}
                  type="button"
                  onClick={() => toggleBenchSort(field)}
                  className={`min-h-7 flex-1 rounded-md px-1.5 transition hover:bg-white/70 ${
                    sortMode.startsWith(field) ? "bg-white text-emerald-950 shadow-sm" : ""
                  }`}
                  aria-label={`Sort bench by ${label}`}
                >
                  {label} {sortArrow(field)}
                </button>
              ))}
            </div>
          ) : null}
          {props.members.length === 0 ? (
            <p className="rounded-xl border border-dashed border-emerald-200/80 bg-white/50 px-2 py-4 text-center text-xs text-zinc-600">
              Drop players here from a court.
            </p>
          ) : null}
          {props.members.length > 0 && visibleMembers.length === 0 ? (
            <p className="rounded-xl border border-dashed border-emerald-200/80 bg-white/50 px-2 py-4 text-center text-xs text-zinc-600">
              No bench players match your search.
            </p>
          ) : null}
          {visibleMembers.map(({ member: m, user }) => {
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
                selected={props.selectedIds.has(m.userId)}
                onToggleSelected={props.onToggleSelected}
              />
            );
          })}
        </div>
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
  selected?: boolean;
  onToggleSelected?: (userId: string) => void;
  onRemove?: (userId: string) => void;
}) {
  const isBench = props.variant === "bench";
  const dragHandlers = {
    draggable: Boolean(props.draggable && props.dragPayload),
    onDragStart: (e: DragEvent<HTMLDivElement>) => {
      if (!props.draggable || !props.dragPayload) return;
      e.dataTransfer.setData("application/json", JSON.stringify(props.dragPayload));
      e.dataTransfer.effectAllowed = "move";
    },
    onDoubleClick: () => props.onRemove?.(props.user.id),
    className: `rounded-xl border border-white/70 bg-white/90 shadow-sm transition hover:shadow ${
      props.draggable && props.dragPayload ? "cursor-grab active:cursor-grabbing" : ""
    }`,
  };

  if (props.compact && !isBench) {
    const hint =
      props.onRemove != null
        ? `${props.user.name} — MMR ${props.user.mmr}, ${props.status}. Double-click to move to bench.`
        : `${props.user.name} — MMR ${props.user.mmr}, ${props.status}`;
    return (
      <div
        {...dragHandlers}
        title={hint}
        className={`${dragHandlers.className} flex h-full min-h-0 flex-col items-center justify-center gap-1 px-2 py-1`}
      >
        <p className="w-full min-w-0 truncate text-center text-[12px] font-semibold leading-tight tracking-tight text-zinc-900">
          {props.user.name}
        </p>
        <div className="flex shrink-0 items-center gap-1 rounded-md bg-zinc-100/90 px-2 py-0.5 shadow-sm ring-1 ring-inset ring-zinc-200/80">
          <span className="text-[9px] font-medium uppercase tracking-wide text-zinc-500">MMR</span>
          <span className="text-[11px] font-semibold tabular-nums text-zinc-800">{props.user.mmr}</span>
        </div>
      </div>
    );
  }

  if (isBench) {
    return (
      <div
        draggable={dragHandlers.draggable}
        onDragStart={dragHandlers.onDragStart}
        onClick={() => props.onToggleSelected?.(props.user.id)}
        onDoubleClick={dragHandlers.onDoubleClick}
        onKeyDown={(e) => {
          if (!props.onToggleSelected) return;
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          props.onToggleSelected(props.user.id);
        }}
        role={props.onToggleSelected ? "button" : undefined}
        tabIndex={props.onToggleSelected ? 0 : undefined}
        aria-pressed={props.onToggleSelected ? Boolean(props.selected) : undefined}
        className={`${dragHandlers.className} p-2 ${
          props.selected
            ? "border-emerald-400 bg-emerald-50 ring-2 ring-emerald-300/60"
            : props.onToggleSelected
              ? "hover:border-emerald-200 hover:bg-emerald-50/40"
              : ""
        }`}
        {...(props.member
          ? {
              title: `Time off court (waiting on bench): ${formatOffCourtWait(props.member, props.nowMs)}`,
            }
          : {})}
      >
        <div className="hidden grid-cols-[minmax(0,1.45fr)_2.8rem_3.4rem_3rem_3.2rem] items-center gap-1.5 text-[11px] md:grid">
          <p className="min-w-0 truncate font-semibold text-zinc-900">{props.user.name}</p>
          <span className="text-center font-semibold tabular-nums text-zinc-800">{props.user.mmr}</span>
          <span className="text-center font-semibold tabular-nums text-zinc-800">
            {props.member?.wins ?? 0}-{props.member?.losses ?? 0}
          </span>
          <span className="text-center font-semibold tabular-nums text-zinc-800">{props.member?.gamesPlayed ?? 0}</span>
          <span className="text-center font-semibold tabular-nums text-zinc-800">
            {props.member ? formatOffCourtWaitShort(props.member, props.nowMs) : "-"}
          </span>
        </div>
        <div className="space-y-1.5 md:hidden">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <p className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-900">{props.user.name}</p>
            <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-700 ring-1 ring-zinc-200/80">
              {props.user.mmr}
            </span>
          </div>
          <div className="grid grid-cols-3 overflow-hidden rounded-lg bg-zinc-50 text-center text-[10px] leading-tight text-zinc-600 ring-1 ring-zinc-100">
            <div className="px-1.5 py-1.5">
              <p className="text-[9px] uppercase tracking-wide text-zinc-400">Record</p>
              <p className="mt-0.5 font-semibold tabular-nums text-zinc-800">
                {props.member?.wins ?? 0}-{props.member?.losses ?? 0}
              </p>
            </div>
            <div className="border-x border-zinc-100 px-1.5 py-1.5">
              <p className="text-[9px] uppercase tracking-wide text-zinc-400">Games</p>
              <p className="mt-0.5 font-semibold tabular-nums text-zinc-800">{props.member?.gamesPlayed ?? 0}</p>
            </div>
            <div className="px-1.5 py-1.5">
              <p className="text-[9px] uppercase tracking-wide text-zinc-400">Wait</p>
              <p className="mt-0.5 font-semibold tabular-nums text-zinc-800">
                {props.member ? formatOffCourtWaitShort(props.member, props.nowMs) : "-"}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      draggable={dragHandlers.draggable}
      onDragStart={dragHandlers.onDragStart}
      onDoubleClick={dragHandlers.onDoubleClick}
      className={`${dragHandlers.className} p-2`}
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
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span>
          <span className="block text-base font-semibold text-zinc-900">Admin Snapshot History</span>
          <span className="mt-0.5 block text-xs text-zinc-500">
            {props.snapshots.length} snapshot{props.snapshots.length === 1 ? "" : "s"}
          </span>
        </span>
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600 transition ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden
        >
          <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-zinc-100 p-4">
          {props.snapshots.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-3 py-4 text-center text-sm text-zinc-600">
              No snapshots yet.
            </p>
          ) : (
            props.snapshots.map((snap) => (
              <AdminSnapshotCard key={snap.id} snapshot={snap} usersById={props.usersById} />
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

function AdminSnapshotCard(props: { snapshot: SessionSnapshot; usersById: Map<string, User> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-zinc-900">{props.snapshot.snapshotName}</span>
          <span className="mt-0.5 block text-xs text-zinc-500">
            {props.snapshot.stats.length} player{props.snapshot.stats.length === 1 ? "" : "s"}
          </span>
        </span>
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-zinc-600 shadow-sm transition ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden
        >
          <svg className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="grid gap-1.5 border-t border-zinc-200/80 p-3 md:grid-cols-2">
          {props.snapshot.stats.length === 0 ? (
            <p className="rounded-lg bg-white p-2 text-xs text-zinc-600">No player stats in this snapshot.</p>
          ) : (
            props.snapshot.stats.map((s) => (
              <div key={`${props.snapshot.id}-${s.userId}`} className="rounded-lg bg-white p-2 text-xs text-zinc-700">
                {props.usersById.get(s.userId)?.name ?? s.userId} • {s.matchesPlayed} matches • {s.wins}W/{s.losses}L
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function ActionButton(props: {
  children: React.ReactNode;
  onClick: () => void;
  variant: "primary" | "danger" | "success" | "warning" | "neutral" | "highlight";
  className?: string;
}) {
  const classes: Record<typeof props.variant, string> = {
    primary: "btn-glass-primary",
    danger: "btn-glass-danger",
    success: "btn-glass-success",
    warning: "btn-glass-warning",
    neutral: "btn-glass-neutral",
    highlight: "btn-glass-highlight",
  };
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`btn-glass rounded-xl px-4 py-2.5 text-sm sm:py-2 ${classes[props.variant]} ${props.className ?? ""}`}
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
