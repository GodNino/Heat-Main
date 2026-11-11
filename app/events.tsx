"use client";
// Private events and their BEO (068; mockup in docs/mockups/eventos-beo.html). Managers with
// Pre-shift access write one sheet per event: times, guests, room, the menu by course with counts,
// the guests' allergies, bar, setup, the run of show, who works it, and (managers only) the money.
// Everyone on the team reads it; the kitchen gets a shorter sheet. When guests, menu, allergies or
// times change, the version goes up and each person is asked to confirm the new one.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { allergenCode } from "@/lib/allergies";
import type { MenuItem } from "@/lib/menu";
import { Field, Notice, ScreenHeader } from "./ui";
import { notify } from "./notifications";

type Dish = {name: string; qty: number; menu_item_id?: string | null};
type Course = {course: string; time: string; items: Dish[]};
type Allergy = {who: string; what: string; plan: string};
type Moment = {time: string; what: string};
export type EventRow = {id: string; restaurant_id: string; name: string; starts_at: string; ends_at: string; guests: number; room: string; contact: string; service_style: string;
  status: "draft" | "confirmed" | "cancelled"; menu: Course[]; allergies: Allergy[]; timeline: Moment[]; bar: string[]; setup: string[]; staff: string[]; notes: string; version: number; updated_at: string};
type Payment = {minimum_spend: number | null; deposit: number | null; deposit_paid: boolean; gratuity: string; notes: string};
type Change = {version: number; fields: string[]; guests_before: number | null; guests_after: number | null; changed_by: string | null; changed_at: string};
type Confirmation = {user_id: string; version: number};
type Person = {user_id: string; name: string; role: string};

const COLUMNS = "id, restaurant_id, name, starts_at, ends_at, guests, room, contact, service_style, status, menu, allergies, timeline, bar, setup, staff, notes, version, updated_at";
const FIELD_NAMES: Record<string, string> = {guests: "Guests", menu: "Menu", allergies: "Allergies", times: "Times", setup: "Setup", bar: "Bar", staff: "Team"};
const STATUS: Record<EventRow["status"], string> = {draft: "Draft", confirmed: "Confirmed", cancelled: "Cancelled"};
const day = (at: string) => new Date(at).toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric"});
const hour = (at: string) => new Date(at).toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit"});
const money = (n: number | null) => n == null ? "—" : `$${Number(n).toLocaleString("en-US", {maximumFractionDigits: 2})}`;
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase() || "?";
const local = (at: string) => { const d = new Date(at); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const lines = (text: string) => text.split("\n").map(l => l.trim()).filter(Boolean).slice(0, 40);
export function allergyCodes(list: Allergy[]) {
  return [...new Set(list.map(a => allergenCode(a.what)).filter(c => c !== "NOTE" && c !== "NONE"))];
}

type Draft = {name: string; starts: string; ends: string; guests: string; room: string; contact: string; service_style: string; status: EventRow["status"];
  menu: Course[]; allergies: Allergy[]; timeline: Moment[]; bar: string; setup: string; staff: string[]; notes: string; pay: Payment};
function blank(): Draft {
  const start = new Date(Date.now() + 7 * 86_400_000); start.setHours(19, 0, 0, 0);
  const end = new Date(start.getTime() + 3 * 3_600_000);
  return {name: "", starts: local(start.toISOString()), ends: local(end.toISOString()), guests: "", room: "", contact: "", service_style: "", status: "draft",
    menu: [{course: "First course", time: "", items: [{name: "", qty: 0}]}], allergies: [], timeline: [], bar: "", setup: "", staff: [], notes: "",
    pay: {minimum_spend: null, deposit: null, deposit_paid: false, gratuity: "", notes: ""}};
}
function toDraft(e: EventRow, pay: Payment | null): Draft {
  return {name: e.name, starts: local(e.starts_at), ends: local(e.ends_at), guests: String(e.guests || ""), room: e.room, contact: e.contact, service_style: e.service_style, status: e.status,
    menu: e.menu.length ? e.menu : [{course: "First course", time: "", items: [{name: "", qty: 0}]}], allergies: e.allergies, timeline: e.timeline,
    bar: e.bar.join("\n"), setup: e.setup.join("\n"), staff: e.staff, notes: e.notes, pay: pay ?? {minimum_spend: null, deposit: null, deposit_paid: false, gratuity: "", notes: ""}};
}

export function Events({restaurantId, userId, canManage, items}: {restaurantId: string; userId: string; canManage: boolean; items: MenuItem[]}) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [team, setTeam] = useState<Person[]>([]);
  const [openId, setOpenId] = useState("");
  const [sheet, setSheet] = useState<"full" | "kitchen">("full");
  const [pay, setPay] = useState<Payment | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [confirms, setConfirms] = useState<Confirmation[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState("");
  const [showPast, setShowPast] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!supabase) return;
    const [list, people] = await Promise.all([
      supabase.from("events").select(COLUMNS).eq("restaurant_id", restaurantId).order("starts_at"),
      supabase.rpc("schedule_team", {rid: restaurantId}),
    ]);
    if (list.error) { setError(/relation|does not exist|schema cache/i.test(list.error.message) ? "Events aren't set up yet. Run migration 068." : "Couldn't load events. Check your connection and try again."); setEvents([]); return; }
    setEvents((list.data ?? []) as EventRow[]);
    setTeam((people.data ?? []) as Person[]);
  }, [restaurantId]);
  useEffect(() => { void load(); }, [load]);

  const open = events?.find(e => e.id === openId) ?? null;
  const loadDetail = useCallback(async (id: string) => {
    if (!supabase || !id) return;
    const [p, c, k] = await Promise.all([
      canManage ? supabase.from("event_payments").select("minimum_spend, deposit, deposit_paid, gratuity, notes").eq("event_id", id).maybeSingle() : Promise.resolve({data: null}),
      supabase.from("event_changes").select("version, fields, guests_before, guests_after, changed_by, changed_at").eq("event_id", id).order("version", {ascending: false}),
      supabase.from("event_confirmations").select("user_id, version").eq("event_id", id),
    ]);
    setPay((p.data ?? null) as Payment | null);
    setChanges((c.data ?? []) as Change[]);
    setConfirms((k.data ?? []) as Confirmation[]);
  }, [canManage]);
  useEffect(() => { void loadDetail(openId); }, [openId, loadDetail]);

  const nameOf = useCallback((id: string | null) => team.find(p => p.user_id === id)?.name ?? "Former team member", [team]);
  const roleOf = useCallback((id: string) => team.find(p => p.user_id === id)?.role ?? "", [team]);
  const itemFor = useCallback((d: Dish) => items.find(i => (d.menu_item_id && i.id === d.menu_item_id) || i.name.trim().toLowerCase() === d.name.trim().toLowerCase()), [items]);
  const now = Date.now();
  const upcoming = useMemo(() => (events ?? []).filter(e => new Date(e.ends_at).getTime() > now - 86_400_000), [events, now]);
  const past = useMemo(() => (events ?? []).filter(e => new Date(e.ends_at).getTime() <= now - 86_400_000).reverse().slice(0, 20), [events, now]);

  async function save() {
    if (!supabase || !draft) return;
    if (!draft.name.trim()) return setError("Give the event a name.");
    const starts = new Date(draft.starts), ends = new Date(draft.ends);
    if (!(ends > starts)) return setError("The event has to end after it starts.");
    const row = {
      name: draft.name.trim(), starts_at: starts.toISOString(), ends_at: ends.toISOString(), guests: Math.max(0, Math.min(5000, Number(draft.guests) || 0)),
      room: draft.room.trim(), contact: draft.contact.trim(), service_style: draft.service_style.trim(), status: draft.status,
      menu: draft.menu.map(c => ({course: c.course.trim(), time: c.time.trim(), items: c.items.filter(i => i.name.trim()).map(i => ({name: i.name.trim(), qty: Math.max(0, Number(i.qty) || 0), menu_item_id: itemFor(i)?.id ?? null}))})).filter(c => c.course || c.items.length),
      allergies: draft.allergies.filter(a => a.who.trim() || a.what.trim()).map(a => ({who: a.who.trim(), what: a.what.trim(), plan: a.plan.trim()})),
      timeline: draft.timeline.filter(t => t.what.trim()).map(t => ({time: t.time.trim(), what: t.what.trim()})),
      bar: lines(draft.bar), setup: lines(draft.setup), staff: draft.staff, notes: draft.notes.trim(),
    };
    setBusy(true); setError(""); setMessage("");
    const saved = editingId
      ? await supabase.from("events").update(row).eq("id", editingId).select("id").maybeSingle()
      : await supabase.from("events").insert({...row, restaurant_id: restaurantId}).select("id").maybeSingle();
    const id = (saved.data as {id?: string} | null)?.id;
    if (saved.error || !id) { setBusy(false); setError(saved.error?.message ?? "The event could not be saved."); return; }
    const p = draft.pay;
    await supabase.from("event_payments").upsert({event_id: id, restaurant_id: restaurantId, minimum_spend: p.minimum_spend, deposit: p.deposit, deposit_paid: p.deposit_paid, gratuity: p.gratuity.trim(), notes: p.notes.trim()});
    setBusy(false); setDraft(null); setEditingId(""); setOpenId(id); setMessage("Event saved."); await load(); await loadDetail(id);
  }
  async function remove(e: EventRow) {
    setBusy(true);
    const {error: failed} = await supabase!.from("events").delete().eq("id", e.id);
    setBusy(false); setConfirmDelete(false);
    if (failed) return setError(failed.message);
    setOpenId(""); setMessage("Event deleted."); await load();
  }
  async function confirmRead(e: EventRow) {
    const {error: failed} = await supabase!.rpc("confirm_event", {event: e.id});
    if (failed) return setError(failed.message);
    setMessage("Confirmed. Thanks!"); await loadDetail(e.id);
  }
  // A pinned notice in the FOH and kitchen chats, which also reaches their phones.
  async function sendToTeam(e: EventRow) {
    if (!supabase) return;
    setBusy(true);
    const text = `${e.name} · ${day(e.starts_at)}, ${hour(e.starts_at)} · ${e.guests} guests. The BEO is in HEAT (Events)${e.version > 1 ? `, version ${e.version}` : ""}. Please read it and confirm.`;
    for (const channel of ["foh", "boh"]) {
      const posted = await supabase.from("chat_messages").insert({restaurant_id: restaurantId, channel, user_id: userId, body: text, is_notice: true}).select("id").maybeSingle();
      const id = (posted.data as {id?: string} | null)?.id;
      if (id) { void supabase.rpc("chat_set_pinned", {message_id: id, on_off: true}); notify("chat_message", id); }
    }
    setBusy(false); setMessage("Sent to the team in chat.");
  }

  if (!events) return <section className="mx-auto max-w-5xl"><p className="muted" role="status">Loading…</p></section>;

  // ── Edit ──
  if (draft) {
    const set = (patch: Partial<Draft>) => setDraft({...draft, ...patch});
    const setCourse = (i: number, patch: Partial<Course>) => set({menu: draft.menu.map((c, n) => n === i ? {...c, ...patch} : c)});
    return <section className="mx-auto max-w-3xl ev">
      <ScreenHeader eyebrow="Events" title={editingId ? "Edit event" : "New event"} />
      <Notice text={error} error />
      <section className="panel ev-card">
        <Field label="Event name"><input id="ev-name" maxLength={120} value={draft.name} onChange={e => set({name: e.target.value})} placeholder="Company dinner · Grupo Altamar" /></Field>
        <div className="ev-grid2">
          <Field label="Starts"><input id="ev-starts" type="datetime-local" value={draft.starts} onChange={e => set({starts: e.target.value})} /></Field>
          <Field label="Ends"><input id="ev-ends" type="datetime-local" value={draft.ends} onChange={e => set({ends: e.target.value})} /></Field>
          <Field label="Guaranteed guests"><input id="ev-guests" inputMode="numeric" value={draft.guests} onChange={e => set({guests: e.target.value.replace(/\D/g, "").slice(0, 4)})} placeholder="45" /></Field>
          <Field label="Room"><input id="ev-room" maxLength={120} value={draft.room} onChange={e => set({room: e.target.value})} placeholder="Private room + terrace" /></Field>
          <Field label="Client contact"><input id="ev-contact" maxLength={200} value={draft.contact} onChange={e => set({contact: e.target.value})} placeholder="Name · phone" /></Field>
          <Field label="Service"><input id="ev-style" maxLength={120} value={draft.service_style} onChange={e => set({service_style: e.target.value})} placeholder="Set menu, 4 courses" /></Field>
        </div>
        <div className="ev-chips" role="group" aria-label="Status">{(["draft", "confirmed", "cancelled"] as const).map(s => <button key={s} type="button" className="ev-chip" aria-pressed={draft.status === s} onClick={() => set({status: s})}>{STATUS[s]}</button>)}</div>
      </section>

      <section className="panel ev-card">
        <p className="ev-label">Menu</p>
        <datalist id="ev-dishes">{items.map(i => <option key={i.id} value={i.name} />)}</datalist>
        {draft.menu.map((c, i) => <div key={i} className="ev-course-edit">
          <div className="ev-grid2">
            <Field label="Course"><input id={`ev-course-${i}`} maxLength={60} value={c.course} onChange={e => setCourse(i, {course: e.target.value})} placeholder="First course" /></Field>
            <Field label="Time"><input id={`ev-ctime-${i}`} maxLength={20} value={c.time} onChange={e => setCourse(i, {time: e.target.value})} placeholder="7:15 PM" /></Field>
          </div>
          {c.items.map((d, j) => <div key={j} className="ev-dish-edit">
            <input aria-label="Dish" list="ev-dishes" maxLength={100} value={d.name} onChange={e => setCourse(i, {items: c.items.map((x, n) => n === j ? {...x, name: e.target.value, menu_item_id: null} : x)})} placeholder="Dish from the library" />
            <input aria-label="How many" inputMode="numeric" className="ev-qty" value={d.qty || ""} onChange={e => setCourse(i, {items: c.items.map((x, n) => n === j ? {...x, qty: Number(e.target.value.replace(/\D/g, "").slice(0, 4))} : x)})} placeholder="Qty" />
            <button type="button" className="ev-icon" aria-label="Remove dish" onClick={() => setCourse(i, {items: c.items.filter((_, n) => n !== j)})}><X size={16} /></button>
          </div>)}
          <div className="ev-actions">
            <button type="button" className="btn secondary" onClick={() => setCourse(i, {items: [...c.items, {name: "", qty: Number(draft.guests) || 0}]})}><Plus size={14} />Add dish</button>
            <button type="button" className="btn secondary" onClick={() => set({menu: draft.menu.filter((_, n) => n !== i)})}>Remove course</button>
          </div>
        </div>)}
        <button type="button" className="btn secondary ev-start" onClick={() => set({menu: [...draft.menu, {course: "", time: "", items: [{name: "", qty: Number(draft.guests) || 0}]}]})}><Plus size={14} />Add course</button>
      </section>

      <section className="panel ev-card">
        <p className="ev-label">Guests' allergies and diets</p>
        {draft.allergies.map((a, i) => <div key={i} className="ev-allergy-edit">
          <input aria-label="Who" maxLength={60} value={a.who} onChange={e => set({allergies: draft.allergies.map((x, n) => n === i ? {...x, who: e.target.value} : x)})} placeholder="Table 2 · seat 4" />
          <input aria-label="Allergy or diet" maxLength={80} value={a.what} onChange={e => set({allergies: draft.allergies.map((x, n) => n === i ? {...x, what: e.target.value} : x)})} placeholder="Shellfish" />
          <input aria-label="Plan" maxLength={120} value={a.plan} onChange={e => set({allergies: draft.allergies.map((x, n) => n === i ? {...x, plan: e.target.value} : x)})} placeholder="Swap the starter" />
          <button type="button" className="ev-icon" aria-label="Remove" onClick={() => set({allergies: draft.allergies.filter((_, n) => n !== i)})}><X size={16} /></button>
        </div>)}
        <button type="button" className="btn secondary ev-start" onClick={() => set({allergies: [...draft.allergies, {who: "", what: "", plan: ""}]})}><Plus size={14} />Add allergy</button>
      </section>

      <section className="panel ev-card">
        <p className="ev-label">Run of show</p>
        {draft.timeline.map((t, i) => <div key={i} className="ev-moment-edit">
          <input aria-label="Time" className="ev-qty" maxLength={20} value={t.time} onChange={e => set({timeline: draft.timeline.map((x, n) => n === i ? {...x, time: e.target.value} : x)})} placeholder="6:00 PM" />
          <input aria-label="What happens" maxLength={120} value={t.what} onChange={e => set({timeline: draft.timeline.map((x, n) => n === i ? {...x, what: e.target.value} : x)})} placeholder="Guests arrive · passed bites" />
          <button type="button" className="ev-icon" aria-label="Remove" onClick={() => set({timeline: draft.timeline.filter((_, n) => n !== i)})}><X size={16} /></button>
        </div>)}
        <button type="button" className="btn secondary ev-start" onClick={() => set({timeline: [...draft.timeline, {time: "", what: ""}]})}><Plus size={14} />Add a moment</button>
        <Field label="Bar (one per line)"><textarea id="ev-bar" rows={3} maxLength={2000} value={draft.bar} onChange={e => set({bar: e.target.value})} placeholder={"Premium package · 4 hours\nProsecco toast at 7 PM"} /></Field>
        <Field label="Setup (one per line)"><textarea id="ev-setup" rows={3} maxLength={2000} value={draft.setup} onChange={e => set({setup: e.target.value})} placeholder={"5 rounds of 9 · black linen\nMic and screen for the toast"} /></Field>
        <Field label="Notes"><textarea id="ev-notes" rows={2} maxLength={2000} value={draft.notes} onChange={e => set({notes: e.target.value})} /></Field>
      </section>

      <section className="panel ev-card">
        <p className="ev-label">Team</p>
        <div className="ev-people-pick">{team.map(p => <button key={p.user_id} type="button" className="ev-chip" aria-pressed={draft.staff.includes(p.user_id)}
          onClick={() => set({staff: draft.staff.includes(p.user_id) ? draft.staff.filter(x => x !== p.user_id) : [...draft.staff, p.user_id]})}>{p.name}{p.role ? ` · ${p.role}` : ""}</button>)}</div>
      </section>

      <section className="panel ev-card">
        <p className="ev-label">Payment · managers only</p>
        <div className="ev-grid2">
          <Field label="Minimum spend ($)"><input id="ev-min" inputMode="decimal" value={draft.pay.minimum_spend ?? ""} onChange={e => set({pay: {...draft.pay, minimum_spend: e.target.value === "" ? null : Number(e.target.value.replace(/[^\d.]/g, "")) || 0}})} /></Field>
          <Field label="Deposit ($)"><input id="ev-dep" inputMode="decimal" value={draft.pay.deposit ?? ""} onChange={e => set({pay: {...draft.pay, deposit: e.target.value === "" ? null : Number(e.target.value.replace(/[^\d.]/g, "")) || 0}})} /></Field>
          <Field label="Gratuity"><input id="ev-grat" maxLength={120} value={draft.pay.gratuity} onChange={e => set({pay: {...draft.pay, gratuity: e.target.value}})} placeholder="20% included" /></Field>
        </div>
        <div className="ev-chips"><button type="button" className="ev-chip" aria-pressed={draft.pay.deposit_paid} onClick={() => set({pay: {...draft.pay, deposit_paid: !draft.pay.deposit_paid}})}>Deposit paid</button></div>
      </section>

      <div className="ev-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save event"}</button>
        <button type="button" className="btn secondary" disabled={busy} onClick={() => { setDraft(null); setEditingId(""); setError(""); }}>Cancel</button>
      </div>
    </section>;
  }

  // ── One event ──
  if (open) {
    const mine = confirms.find(c => c.user_id === userId);
    const onIt = open.staff.includes(userId);
    const sinceMine = mine ? changes.filter(c => c.version > mine.version) : [];
    const kitchen = sheet === "kitchen";
    const codes = allergyCodes(open.allergies);
    return <section className="mx-auto max-w-5xl ev">
      <button type="button" className="btn secondary ev-start" onClick={() => { setOpenId(""); setSheet("full"); setConfirmDelete(false); }}>Back</button>
      <ScreenHeader eyebrow={`BEO · version ${open.version}`} title={open.name} />
      <Notice text={error} error />
      <Notice text={message} />
      <div className="ev-actions">
        <div className="ev-chips" role="group" aria-label="Sheet"><button type="button" className="ev-chip" aria-pressed={!kitchen} onClick={() => setSheet("full")}>Full BEO</button><button type="button" className="ev-chip" aria-pressed={kitchen} onClick={() => setSheet("kitchen")}>Kitchen sheet</button></div>
        {canManage ? <>
          <button type="button" className="btn secondary" onClick={() => { setDraft(toDraft(open, pay)); setEditingId(open.id); setError(""); setMessage(""); }}>Edit</button>
          <button type="button" className="btn" disabled={busy} onClick={() => void sendToTeam(open)}>Send to the team</button>
        </> : (!mine || mine.version < open.version) && <button type="button" className="btn" onClick={() => void confirmRead(open)}>Confirm I read it</button>}
      </div>
      {mine && sinceMine.length > 0 && <section className="panel ev-card ev-changed">
        <p className="ev-label">Changed since you confirmed</p>
        <p>{sinceMine.flatMap(c => c.fields).filter((f, i, all) => all.indexOf(f) === i).map(f => FIELD_NAMES[f] ?? f).join(" · ")}
          {sinceMine.some(c => c.fields.includes("guests")) && ` · Guests ${sinceMine.at(-1)?.guests_before} → ${open.guests}`}</p>
      </section>}
      <section className="panel ev-card"><div className="ev-facts">
        <div><span>Date</span><b>{day(open.starts_at)}</b></div>
        <div><span>Time</span><b>{hour(open.starts_at)} – {hour(open.ends_at)}</b></div>
        <div><span>Guests</span><b>{open.guests} guaranteed</b></div>
        {open.room && <div><span>Room</span><b>{open.room}</b></div>}
        {!kitchen && open.contact && <div><span>Contact</span><b>{open.contact}</b></div>}
        <div><span>Status</span><b>{STATUS[open.status]}</b></div>
      </div></section>
      <div className="ev-columns">
        <div className="ev-stack">
          <section className="panel ev-card">
            <div className="ev-label-row"><p className="ev-label">Menu</p>{open.service_style && <small>{open.service_style}</small>}</div>
            {open.menu.length ? open.menu.map((c, i) => <div key={i} className="ev-rows">
              <p className="ev-course">{c.course}{c.time ? ` · ${c.time}` : ""}</p>
              {c.items.map((d, j) => { const it = itemFor(d); return <div key={j} className="ev-row"><span>{d.name}{it?.allergens.length ? <small>{it.allergens.map(allergenCode).filter(x => x !== "NOTE").join(" · ")}</small> : null}</span><b>{d.qty || "—"}</b></div>; })}
            </div>) : <p className="muted">No menu yet.</p>}
          </section>
          {!kitchen && open.bar.length > 0 && <section className="panel ev-card"><p className="ev-label">Bar</p><div className="ev-rows">{open.bar.map(l => <div key={l} className="ev-row"><span>{l}</span></div>)}</div></section>}
          {!kitchen && open.setup.length > 0 && <section className="panel ev-card"><p className="ev-label">Setup</p><div className="ev-rows">{open.setup.map(l => <div key={l} className="ev-row"><span>{l}</span></div>)}</div></section>}
          {open.notes && <section className="panel ev-card"><p className="ev-label">Notes</p><p>{open.notes}</p></section>}
        </div>
        <div className="ev-stack">
          <section className="ev-allergy" aria-label="Guests' allergies">
            <div className="ev-label-row"><p className="ev-label">Guests' allergies and diets</p><small>{open.allergies.length} {open.allergies.length === 1 ? "note" : "notes"}</small></div>
            {open.allergies.length ? <div className="ev-rows">{open.allergies.map((a, i) => <div key={i} className="ev-row"><span><b>{a.who || "Guest"}</b>{a.plan && <small>{a.plan}</small>}</span><b>{a.what}</b></div>)}</div> : <p>No allergies recorded for this event.</p>}
            {codes.length > 0 && <div className="ev-codes">{codes.map(c => <span key={c}>{c}</span>)}</div>}
            <p className="ev-kitchen-line">Always confirm with the kitchen before serving.</p>
          </section>
          {open.timeline.length > 0 && <section className="panel ev-card"><p className="ev-label">Run of show</p><div className="ev-timeline">{open.timeline.map((t, i) => <div key={i}><b>{t.time}</b><span>{t.what}</span></div>)}</div></section>}
          <section className="panel ev-card">
            <div className="ev-label-row"><p className="ev-label">Team</p><small>{open.staff.filter(id => confirms.some(c => c.user_id === id && c.version === open.version)).length} of {open.staff.length} confirmed</small></div>
            {open.staff.length ? <div className="ev-people">{open.staff.map(id => { const ok = confirms.some(c => c.user_id === id && c.version === open.version); return <span key={id} className={id === userId ? "me" : ""}><i aria-hidden="true">{initials(nameOf(id))}</i>{nameOf(id)}{roleOf(id) ? ` · ${roleOf(id)}` : ""}{ok && <Check size={14} aria-label="confirmed" />}</span>; })}</div> : <p className="muted">No one assigned yet.</p>}
            {onIt && mine?.version === open.version && <p className="muted">You confirmed version {open.version}.</p>}
          </section>
          {canManage && !kitchen && <section className="panel ev-card">
            <div className="ev-label-row"><p className="ev-label">Payment</p><small>Managers only</small></div>
            <div className="ev-rows">
              <div className="ev-row"><span>Minimum spend</span><b>{money(pay?.minimum_spend ?? null)}</b></div>
              <div className="ev-row"><span>Deposit</span><b>{money(pay?.deposit ?? null)}{pay?.deposit != null ? (pay.deposit_paid ? " · paid" : " · not paid") : ""}</b></div>
              {pay?.gratuity && <div className="ev-row"><span>Gratuity</span><b>{pay.gratuity}</b></div>}
            </div>
          </section>}
          {canManage && changes.length > 0 && <section className="panel ev-card"><p className="ev-label">Versions</p><div className="ev-rows">
            {changes.map(c => <div key={c.version} className="ev-row"><span>Version {c.version} · {c.fields.map(f => FIELD_NAMES[f] ?? f).join(", ")}<small>{nameOf(c.changed_by)} · {day(c.changed_at)}</small></span>{c.fields.includes("guests") && <b>{c.guests_before} → {c.guests_after}</b>}</div>)}
          </div></section>}
          {canManage && (confirmDelete
            ? <div className="ev-confirm"><span>Delete this event for everyone?</span><div className="ev-actions"><button type="button" className="btn secondary" onClick={() => setConfirmDelete(false)}>Keep it</button><button type="button" className="btn secondary" disabled={busy} onClick={() => void remove(open)}>Delete</button></div></div>
            : <button type="button" className="btn secondary ev-start" onClick={() => setConfirmDelete(true)}>Delete event</button>)}
        </div>
      </div>
    </section>;
  }

  // ── List ──
  const row = (e: EventRow) => { const d = new Date(e.starts_at); return <button key={e.id} type="button" className="ev-item" onClick={() => { setOpenId(e.id); setError(""); setMessage(""); }}>
    <span className="ev-date" aria-hidden="true"><small>{d.toLocaleDateString("en-US", {month: "short"})}</small><b>{d.getDate()}</b></span>
    <span className="ev-item-text"><b>{e.name}</b><small>{e.guests} guests{e.room ? ` · ${e.room}` : ""} · {hour(e.starts_at)}</small></span>
    <span className={`ev-status${e.status === "confirmed" ? " ok" : ""}`}>{e.staff.includes(userId) ? "You're on it" : STATUS[e.status]}</span>
  </button>; };
  return <section className="mx-auto max-w-3xl ev">
    <ScreenHeader eyebrow="Today" title="Events" info="Private events and large groups, each with its BEO: menu, allergies, run of show and team. The kitchen gets its own sheet."
      action={canManage ? <button type="button" className="btn" onClick={() => { setDraft(blank()); setEditingId(""); setError(""); setMessage(""); }}>New event</button> : undefined} />
    <Notice text={error} error />
    <Notice text={message} />
    <p className="section-chip">Upcoming</p>
    {upcoming.length ? <div className="ev-list">{upcoming.map(row)}</div> : <p className="muted">{canManage ? "No events coming up. Tap New event to write the first BEO." : "No events coming up."}</p>}
    {past.length > 0 && <>
      <button type="button" className="btn secondary ev-start" onClick={() => setShowPast(v => !v)}>{showPast ? "Hide past events" : `Past events (${past.length})`}</button>
      {showPast && <div className="ev-list">{past.map(row)}</div>}
    </>}
  </section>;
}

// Home: the next event this person works, in the next two weeks.
export function NextEventCard({restaurantId, userId, onOpen}: {restaurantId: string; userId: string; onOpen: () => void}) {
  const [next, setNext] = useState<Pick<EventRow, "id" | "name" | "starts_at" | "guests"> | null>(null);
  useEffect(() => {
    if (!supabase) return;
    let live = true;
    const soon = new Date(Date.now() + 14 * 86_400_000).toISOString();
    void supabase.from("events").select("id, name, starts_at, guests").eq("restaurant_id", restaurantId).contains("staff", [userId]).neq("status", "cancelled")
      .gte("ends_at", new Date().toISOString()).lte("starts_at", soon).order("starts_at").limit(1)
      .then(({data, error}) => { if (live && !error) setNext(((data ?? [])[0] as typeof next) ?? null); });
    return () => { live = false; };
  }, [restaurantId, userId]);
  if (!next) return null;
  return <section className="panel ev-home">
    <p className="section-chip">Event</p>
    <b className="ev-home-title">{next.name}</b>
    <p className="muted">{day(next.starts_at)} · {hour(next.starts_at)} · {next.guests} guests. Read the BEO before you come in.</p>
    <button type="button" className="btn secondary" onClick={onOpen}>Open the BEO</button>
  </section>;
}
