import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDay, flagPeople, type DayInput } from "../lib/today-day.ts";

const at = (h: number, m = 0) => new Date(2026, 10, 19, h, m);
const iso = (h: number, m = 0) => at(h, m).toISOString();
const settings = {kitchen_positions: null, dinner_starts: 17, overtime_weekly: 40};
const shifts = [
  {user_id: "gm", starts_at: iso(15), ends_at: iso(23), position: "GM"},
  {user_id: "ana", starts_at: iso(17), ends_at: iso(23), position: "Server"},
  {user_id: "toño", starts_at: iso(16), ends_at: iso(23), position: "Line Cook"},
  {user_id: "lu", starts_at: iso(11), ends_at: iso(15), position: "Server"},
];
const base: DayInput = {settings, shifts, board: {posted: false, out: ["Toro"], low: ["Uni"]}, jobs: [{user_id: "ana", phase: "opening", done: true}, {user_id: "ana", phase: "closing", done: false}],
  sectionsSent: true, events: [{name: "Altamar", starts_at: iso(18), guests: 45}], reportFiled: false};

test("the day runs in order, with lunch, pre-shift, dinner, the event and close", () => {
  const day = buildDay(base, at(16, 10));
  assert.deepEqual(day.map(m => m.title), ["Opening side work", "Lunch", "Pre-shift", "Dinner", "Altamar", "Closing time"]);
  assert.deepEqual(day.map(m => m.state), ["done", "done", "now", "later", "later", "later"]);
  const pre = day.find(m => m.title === "Pre-shift")!;
  assert.equal(pre.tag?.text, "Not posted"); assert.deepEqual(pre.out, ["Toro"]);
  assert.equal(day.find(m => m.title === "Dinner")?.tag?.text, "Side work and sections sent");
  assert.match(day.find(m => m.title === "Dinner")!.detail, /1 on the floor, 1 in the kitchen/);
  assert.equal(day.find(m => m.title === "Closing time")?.detail, "Closing side work 0 of 1");
});

test("the report turns red near close, and green once filed", () => {
  assert.equal(buildDay(base, at(22, 30)).at(-1)?.tag?.tone, "bad");
  assert.equal(buildDay({...base, reportFiled: true}, at(22, 30)).at(-1)?.tag?.text, "Report filed");
});

test("a day with nobody scheduled and no event has no timeline", () => {
  assert.deepEqual(buildDay({...base, shifts: [], events: []}, at(12)), []);
});

test("only people who need something are flagged", () => {
  const today = [
    {user_id: "ana", starts_at: iso(17), ends_at: iso(23), position: "Server"},
    {user_id: "mia", starts_at: iso(17), ends_at: iso(23), position: "Server"},
    {user_id: "luis", starts_at: iso(16), ends_at: iso(24), position: "Bartender"},
    {user_id: "toño", starts_at: iso(16), ends_at: iso(23), position: "Line Cook"},
  ];
  const {flags, all} = flagPeople({settings, today, weekHours: new Map([["luis", 39.5], ["ana", 20]]), withJobs: new Set(["ana", "luis"]),
    inSections: new Set(["ana"]), sectionPositions: p => p === "Server"});
  assert.equal(all.length, 4);
  const byId = Object.fromEntries(flags.map(f => [f.user_id, f.notes]));
  assert.deepEqual(byId.luis, ["39.5 h this week"]);
  assert.deepEqual(byId.mia, ["no side work today", "no section"]);
  assert.ok(!("ana" in byId) && !("toño" in byId), "the cook isn't asked for side work or a section");
});

test("without a dinner hour, dinner starts when most of the crew does, not when the manager comes in", () => {
  const crew = [
    {user_id: "gm", starts_at: iso(15), ends_at: iso(23), position: "GM"},
    {user_id: "a", starts_at: iso(17), ends_at: iso(23), position: "Server"},
    {user_id: "b", starts_at: iso(17), ends_at: iso(23), position: "Server"},
    {user_id: "c", starts_at: iso(16), ends_at: iso(23), position: "Bartender"},
  ];
  const day = buildDay({...base, settings: {...settings, dinner_starts: null}, shifts: crew, events: []}, at(12));
  assert.equal(new Date(day.find(m => m.title === "Dinner")!.at).getHours(), 17);
  const {flags} = flagPeople({settings, today: crew, weekHours: new Map(), withJobs: new Set(["a"]), inSections: null, sectionPositions: () => false});
  assert.deepEqual(flags.map(f => f.user_id).sort(), ["b", "c"], "the GM isn't asked for side work");
});
