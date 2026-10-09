export type ProgramStatusRecord = {
  source: "program" | "chan";
  id: string | null;
  state: "idle" | "working" | "done" | "blocked" | "error";
  kind: "permission" | "question" | "auth" | null;
  progress: number | null;
  app: string | null;
  title: string | null;
  msg: string | null;
  seen: boolean;
  update_order: number;
};

export type ProgramStatus = { revision: number; records: ProgramStatusRecord[] };

export function markProgramCompletionsSeen(status: ProgramStatus | undefined): void {
  if (!status) return;
  for (const record of status.records) {
    if (record.state === "done" || record.state === "error") record.seen = true;
  }
}

export function applyProgramStatus(
  current: ProgramStatus | undefined,
  next: ProgramStatus,
): ProgramStatus {
  return !current || next.revision > current.revision ? next : current;
}

export function effectiveProgramApp(record: ProgramStatusRecord, status: ProgramStatus): string | null {
  if (record.app) return record.app;
  let id = record.id;
  while (id !== null) {
    id = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : null;
    const ancestor = status.records.find((candidate) => candidate.source === record.source && candidate.id === id);
    if (ancestor?.app) return ancestor.app;
  }
  return null;
}

export function presentProgramText(value: string | null, max = Infinity): string {
  if (!value) return "";
  const characters = Array.from(value, (character) =>
    /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/u.test(character) ? "□" : character,
  );
  return characters.length > max ? `${characters.slice(0, max).join("")}…` : characters.join("");
}

export function programVisual(status: ProgramStatus | undefined): {
  activity: "icon" | "spinner" | "ring";
  progress: number | null;
  attention: ProgramStatusRecord | null;
  working: boolean;
} {
  const records = status?.records ?? [];
  const working = records.filter((record) => record.state === "working");
  const root = records.find((record) => record.source === "program" && record.id === null);
  const latestWorking = [...working].sort((a, b) => b.update_order - a.update_order)[0];
  const progress = working.length
    ? (root?.progress ?? latestWorking?.progress ?? null)
    : null;
  const candidates = records.filter((record) =>
    record.state === "blocked" || ((record.state === "done" || record.state === "error") && !record.seen),
  );
  const rank = { blocked: 3, error: 2, done: 1, idle: 0, working: 0 };
  const attention = candidates.sort((a, b) => rank[b.state] - rank[a.state] || b.update_order - a.update_order)[0] ?? null;
  return { activity: working.length ? (progress === null ? "spinner" : "ring") : "icon", progress, attention, working: working.length > 0 };
}

export function programSummary(record: ProgramStatusRecord, status: ProgramStatus): string {
  return [record.state, record.kind, record.progress === null ? null : `${record.progress}%`, effectiveProgramApp(record, status), record.title, record.msg]
    .filter((part): part is string => part !== null && part !== "")
    .map((part) => presentProgramText(part, 120))
    .join(" · ");
}
