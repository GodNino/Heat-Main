import { test } from "node:test";
import assert from "node:assert/strict";
import { eventSheet } from "../lib/sheets.ts";

const text = (bytes: Uint8Array) => { let out = ""; for (const b of bytes) out += String.fromCharCode(b); return out; };
const base = {
  name: "Company dinner - Grupo Altamar", startsAt: "2026-12-06T23:00:00Z", day: "Saturday, December 6", time: "6:00 PM - 10:30 PM",
  guests: 45, room: "Private room", contact: "Mariana Ortiz - 305 555 0100", serviceStyle: "Set menu, 4 courses", status: "Confirmed", version: 3,
  menu: [{course: "First course", time: "7:15 PM", items: [{name: "Yellowtail Tiradito", qty: 45, codes: ["FSH", "SOY"]}]}],
  allergies: [{who: "Table 2, seat 4", what: "Shellfish", plan: "Swap the bites", code: "SHL"}],
  timeline: [{time: "6:00 PM", what: "Guests arrive"}], bar: ["Premium package, 4 hours"], setup: ["5 rounds of 9"],
  team: ["Ana, Server"], notes: "Birthday cake at 9.", kitchen: false,
};

test("a printed BEO has the facts, the allergies first, the menu, the run of show and the team", () => {
  const sheet = eventSheet(base, {restaurant: "Osaka - Miami"});
  const body = text(sheet.bytes);
  assert.equal(sheet.filename, "beo-company-dinner-grupo-altamar-2026-12-06.pdf");
  for (const words of ["Company dinner - Grupo Altamar", "45 guaranteed", "Shellfish \\(SHL\\) / Plan: Swap the bites", "Always confirm with the kitchen before serving.",
    "Yellowtail Tiradito", "FSH / SOY", "Guests arrive", "Premium package", "5 rounds of 9", "Ana, Server", "Mariana Ortiz", "Version 3"]) {
    assert.ok(body.includes(words), `missing "${words}"`);
  }
  assert.ok(body.indexOf("allergies and diets") < body.indexOf("Yellowtail Tiradito"), "allergies come before the menu");
});

test("the kitchen copy leaves out the client, the bar and the setup", () => {
  const sheet = eventSheet({...base, kitchen: true}, {restaurant: "Osaka - Miami"});
  const body = text(sheet.bytes);
  assert.ok(sheet.filename.startsWith("kitchen-"));
  assert.ok(body.includes("Yellowtail Tiradito") && body.includes("Shellfish"));
  for (const words of ["Mariana Ortiz", "Premium package", "5 rounds of 9"]) assert.ok(!body.includes(words), `should not print "${words}"`);
});
