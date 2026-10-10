// Line-anchored note threads persisted under .deci/notes/<rev>.json.
// Pure: storage I/O stays with the caller (workspace.fs seam). Never throws
// on malformed input; validation caps length and rejects empties.
import type { NoteItem } from "./diffReview.js";

export interface StoredNote extends NoteItem {
  file: string;
  line: number | null;
  findingId?: string;
}

export type NoteMap = Record<string, StoredNote[]>;

export const MAX_NOTE_LENGTH = 2000;

export function notesPath(rev: string): string {
  const safe = rev.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "unknown";
  return `.deci/notes/${safe}.json`;
}

export function noteKey(file: string, line: number | null): string {
  return `${file}:${line ?? 0}`;
}

function cleanNote(n: unknown): StoredNote | null {
  if (!n || typeof n !== "object") return null;
  const r = n as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.file !== "string" || !r.file) return null;
  if (typeof r.text !== "string" || !r.text.trim()) return null;
  const author = r.author === "Deci" ? "Deci" : "You";
  const line = typeof r.line === "number" && Number.isFinite(r.line) && r.line > 0 ? r.line : null;
  return {
    id: r.id.slice(0, 64),
    author,
    text: r.text.slice(0, MAX_NOTE_LENGTH),
    at: typeof r.at === "string" ? r.at : new Date().toISOString(),
    resolved: r.resolved === true,
    file: r.file.slice(0, 512),
    line,
    findingId: typeof r.findingId === "string" && r.findingId ? r.findingId.slice(0, 128) : undefined,
  };
}

export function parseNotes(json: string): NoteMap {
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: NoteMap = {};
    for (const [k, arr] of Object.entries(v as Record<string, unknown>)) {
      if (typeof k !== "string" || !Array.isArray(arr)) continue;
      const notes = arr.map(cleanNote).filter((n): n is StoredNote => n !== null).slice(0, 200);
      if (notes.length) out[k.slice(0, 512)] = notes;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeNotes(map: NoteMap): string {
  return JSON.stringify(map, null, 2);
}

let counter = 0;

export function makeNoteId(): string {
  counter += 1;
  return `n${Date.now().toString(36)}${counter}`;
}

/** Add a note; returns null when text is empty or over cap. */
export function addNote(
  map: NoteMap,
  file: string,
  line: number | null,
  author: "You" | "Deci",
  text: string,
  findingId?: string,
): { map: NoteMap; note: StoredNote } | null {
  const clean = text.trim();
  if (!clean || clean.length > MAX_NOTE_LENGTH || !file) return null;
  const note: StoredNote = {
    id: makeNoteId(),
    author,
    text: clean,
    at: new Date().toISOString(),
    resolved: false,
    file,
    line,
    findingId,
  };
  const key = findingId ?? noteKey(file, line);
  return { map: { ...map, [key]: [...(map[key] ?? []), note] }, note };
}

export function toggleNoteResolved(map: NoteMap, id: string): NoteMap {
  const out: NoteMap = {};
  for (const [k, arr] of Object.entries(map)) {
    out[k] = arr.map((n) => (n.id === id ? { ...n, resolved: !n.resolved } : n));
  }
  return out;
}

export function deleteNote(map: NoteMap, id: string): NoteMap {
  const out: NoteMap = {};
  for (const [k, arr] of Object.entries(map)) {
    const rest = arr.filter((n) => n.id !== id);
    if (rest.length) out[k] = rest;
  }
  return out;
}

/** Notes for a finding thread: findingId match first, then file:line orphans. */
export function notesFor(
  map: NoteMap,
  decisionId: string,
  file: string,
  line: number | null,
): StoredNote[] {
  const direct = map[decisionId] ?? [];
  const orphans = (map[noteKey(file, line)] ?? []).filter((n) => !n.findingId);
  return [...direct, ...orphans];
}

export interface DecidedState {
  status: "accepted" | "rejected" | "investigating";
  reason?: string;
  constraint?: string;
  decidedAt: string;
}

export function decisionsPath(rev: string): string {
  const safe = rev.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "unknown";
  return `.deci/decisions/${safe}.json`;
}

export function parseDecided(json: string): Record<string, DecidedState> {
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, DecidedState> = {};
    for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
      if (typeof k !== "string" || !s || typeof s !== "object") continue;
      const r = s as Record<string, unknown>;
      if (r.status !== "accepted" && r.status !== "rejected" && r.status !== "investigating") continue;
      out[k.slice(0, 128)] = {
        status: r.status,
        reason: typeof r.reason === "string" ? r.reason.slice(0, 500) : undefined,
        constraint: typeof r.constraint === "string" ? r.constraint.slice(0, 500) : undefined,
        decidedAt: typeof r.decidedAt === "string" ? r.decidedAt : new Date().toISOString(),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeDecided(saved: Record<string, DecidedState>): string {
  return JSON.stringify(saved, null, 2);
}
