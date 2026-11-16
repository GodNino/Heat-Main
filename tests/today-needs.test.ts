import { test } from "node:test";
import assert from "node:assert/strict";
import { needsFrom, partOfDay, type Facts } from "../lib/today-needs.ts";

// A Thursday with a dinner from 5 PM to 11 PM, local time.
const at = (h: number, m = 0) => new Date(2026, 10, 19, h, m);
const dinner = [{user_id: "a", starts_at: at(17).toISOString(), ends_at: at(23).toISOString()}, {user_id: "b", starts_at: at(17).toISOString(), ends_at: at(23).toISOString()}];
const base: Facts = {shifts: dinner, posted: false, sideJobs: 0, pending: 1, released: 1, timeOff: 1, positions: 0, retakes: 0, urgent: 0,
  order: "Yuzu, sesame oil", reportToday: false, events: [{id: "e", name: "Altamar", starts_at: at(18).toISOString(), unread: 2}]};
const keys = (now: Date, f: Facts = base) => needsFrom(f, now).map(n => n.key);

test("the part of the day follows the clock and the last shift", () => {
  const end = Date.parse(dinner[0].ends_at);
  assert.equal(partOfDay(at(10), end), "morning");
  assert.equal(partOfDay(at(16), end), "afternoon");
  assert.equal(partOfDay(at(22, 30), end), "close");
  assert.equal(partOfDay(at(21), null), "afternoon");
  assert.equal(partOfDay(at(22), null), "close");
});

test("in the morning, last night's order comes first; requests wait at the end", () => {
  const list = keys(at(10));
  assert.equal(list[0], "order");
  assert.ok(list.indexOf("preshift") > 0 && list.indexOf("released") > 0);
  assert.deepEqual(list.slice(-2), ["shift_changes", "time_off"]);
});

test("before service: pre-shift, side work, the open shift and the BEO; no report yet", () => {
  const list = keys(at(16));
  assert.deepEqual(list.slice(0, 4), ["preshift", "sidework", "released", "events"]);
  assert.ok(!list.includes("order") && !list.includes("write_report"));
  const first = needsFrom(base, at(16))[0];
  assert.match(first.sub, /Service starts at 5p · 2 people will read it/);
});

test("after close: write the report, and the pre-shift no longer nags", () => {
  const list = keys(at(22, 30));
  assert.ok(list.includes("write_report"));
  assert.ok(!list.includes("preshift") && !list.includes("sidework"));
  assert.ok(!keys(at(22, 30), {...base, reportToday: true}).includes("write_report"));
});

test("an urgent report always leads, and a quiet day has nothing", () => {
  assert.equal(keys(at(16), {...base, urgent: 1})[0], "urgent");
  const quiet: Facts = {shifts: [], posted: null, sideJobs: null, pending: 0, released: 0, timeOff: 0, positions: 0, retakes: 0, urgent: 0, order: "", reportToday: false, events: []};
  assert.deepEqual(keys(at(16), quiet), []);
});

test("the BEO stops asking once the event has started", () => {
  assert.ok(keys(at(17)).includes("events"));
  assert.ok(!keys(at(18, 30)).includes("events"));
});
