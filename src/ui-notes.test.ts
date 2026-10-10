import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addNote,
  decisionsPath,
  deleteNote,
  MAX_NOTE_LENGTH,
  makeNoteId,
  noteKey,
  notesFor,
  notesPath,
  parseDecided,
  parseNotes,
  serializeDecided,
  serializeNotes,
  toggleNoteResolved,
} from "./vscode/ui/notes.js";

test("notes paths are revision-scoped and sanitised", () => {
  assert.equal(notesPath("abc123"), ".deci/notes/abc123.json");
  assert.equal(notesPath("../../etc"), ".deci/notes/etc.json");
  assert.equal(decisionsPath("r/1"), ".deci/decisions/r1.json");
  assert.equal(noteKey("a.ts", 3), "a.ts:3");
  assert.equal(noteKey("a.ts", null), "a.ts:0");
});

test("addNote validates emptiness, cap and file", () => {
  assert.equal(addNote({}, "a.ts", 1, "You", "   "), null);
  assert.equal(addNote({}, "", 1, "You", "hi"), null);
  assert.equal(addNote({}, "a.ts", 1, "You", "x".repeat(MAX_NOTE_LENGTH + 1)), null);
  const r = addNote({}, "a.ts", 2, "Deci", "look <here>", "D1");
  assert.ok(r && r.note.author === "Deci" && r.note.findingId === "D1");
  assert.ok(r.map["D1"]?.length === 1);
  const r2 = addNote({}, "a.ts", 2, "You", "orphan");
  assert.ok(r2?.map["a.ts:2"]?.length === 1);
});

test("toggle and delete prune correctly", () => {
  const r = addNote({}, "a.ts", 1, "You", "hi", "D1")!;
  const t = toggleNoteResolved(r.map, r.note.id);
  assert.equal(t["D1"]?.[0]?.resolved, true);
  assert.deepEqual(deleteNote(t, r.note.id), {});
});

test("parseNotes drops malformed entries, never throws", () => {
  assert.deepEqual(parseNotes("nope"), {});
  assert.deepEqual(parseNotes("[1,2]"), {});
  const m = parseNotes(JSON.stringify({ "D1": [{ id: "n", file: "a", text: "t", author: "X" }], "bad": "x", "empty": [{ id: "", file: "", text: "" }] }));
  assert.equal(m["D1"]?.[0]?.author, "You");
  assert.ok(!("bad" in m) && !("empty" in m));
  assert.ok(serializeNotes(m).includes('"D1"'));
});

test("notesFor prefers finding threads, falls back to line orphans", () => {
  const a = addNote({}, "a.ts", 2, "You", "thread", "D1")!;
  const b = addNote(a.map, "a.ts", 2, "You", "orphan")!;
  const c = addNote(b.map, "a.ts", 2, "You", "other", "D9")!;
  const got = notesFor(c.map, "D1", "a.ts", 2).map((n) => n.text);
  assert.deepEqual(got, ["thread", "orphan"]);
});

test("parseDecided validates statuses only", () => {
  assert.deepEqual(parseDecided("bad"), {});
  const s = parseDecided(JSON.stringify({ D1: { status: "accepted", decidedAt: "t" }, D2: { status: "nope" } }));
  assert.deepEqual(Object.keys(s), ["D1"]);
  assert.ok(serializeDecided(s).includes("accepted"));
});

test("note ids are unique", () => {
  assert.notEqual(makeNoteId(), makeNoteId());
});
