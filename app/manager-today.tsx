"use client";
// The manager's Today, rebuilt around the day (mockup docs/mockups/manager-today.html, v2).
// "Needs you" puts everything waiting on a manager in one numbered list, most urgent first, and it
// changes with the time of day: in the morning, what to order from last night; before service, the
// pre-shift and side work; after close, the night's report. Then last night and the event today.
// Everything is read with the manager's own access; anything that fails to load simply doesn't show.
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { allergenCode } from "@/lib/allergies";
import { ISSUE_KINDS, MOODS, money, serviceDay, type ShiftReport } from "@/lib/shift-report";
import { addDays, readSettings, shiftHours, shortTime, weekStart } from "@/lib/schedule";
import { buildDay, flagPeople, momentTime, type DayInput, type DayJob, type DayShift, type Flag, type Moment } from "@/lib/today-day";
import { needsFrom, type Facts, type NeedTarget } from "@/lib/today-needs";
export type { NeedTarget };

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function NeedsYou({restaurantId, canPreshift, canSchedule, canTeam, canReports, onOpen}: {
  restaurantId: string; canPreshift: boolean; canSchedule: boolean; canTeam: boolean; canReports: boolean; onOpen: (target: NeedTarget) => void;
}) {
  const [facts, setFacts] = useState<Facts | null>(null);
  useEffect(() => {
    const db = supabase;
    if (!db) return;
    let live = true;
    // Anything that fails (an update not run yet, no access) counts as nothing rather than breaking the dashboard.
    const quiet = async <T,>(work: () => PromiseLike<T>, fallback: T): Promise<T> => { try { return await work(); } catch { return fallback; } };
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 1);
    const today = localDay(), yesterday = localDay(new Date(Date.now() - 86_400_000));
    const since = localDay(new Date(Date.now() - 2 * 86_400_000));
    const changes = canSchedule ? quiet(async () => { const {data, error} = await db.rpc("shift_change_list", {rid: restaurantId}); return error ? [] : (data ?? []) as {status: string}[]; }, [] as {status: string}[]) : Promise.resolve([] as {status: string}[]);
    void Promise.all([
      quiet(async () => { const {data, error} = await db.from("schedule_shifts").select("user_id,starts_at,ends_at").eq("restaurant_id", restaurantId).eq("published", true).gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString()); return error ? [] : (data ?? []) as Facts["shifts"]; }, [] as Facts["shifts"]),
      canPreshift ? quiet(async () => { const {data, error} = await db.rpc("get_preshift_board", {rid: restaurantId}); if (error) return null; const b = (data as {board?: {restaurant_id: string; note: string; entries: unknown[]; focus_item_ids?: string[] | null; focus_item_id?: string | null} | null} | null)?.board; return !!b && b.restaurant_id === restaurantId && (!!b.note?.trim() || !!b.entries?.length || !!b.focus_item_ids?.length || !!b.focus_item_id); }, null) : Promise.resolve(null),
      canPreshift ? quiet(async () => { const shifts = await db.from("checklist_shifts").select("id").eq("restaurant_id", restaurantId).eq("shift_date", today); if (shifts.error) return null; if (!shifts.data?.length) return 0; const jobs = await db.from("checklist_assignments").select("id", {count: "exact", head: true}).in("shift_id", shifts.data.map(r => r.id as string)); return jobs.error ? null : jobs.count ?? 0; }, null) : Promise.resolve(null),
      changes,
      canSchedule ? quiet(async () => { const {count, error} = await db.from("time_off_requests").select("id", {count: "exact", head: true}).eq("restaurant_id", restaurantId).eq("status", "pending"); return error ? 0 : count ?? 0; }, 0) : Promise.resolve(0),
      canTeam ? quiet(async () => { const {data, error} = await db.rpc("team_without_position", {rid: restaurantId}); return error ? 0 : (data ?? []).length; }, 0) : Promise.resolve(0),
      quiet(async () => { const {data, error} = await db.rpc("quiz_retake_requests", {rid: restaurantId}); return error ? 0 : (data ?? []).length; }, 0),
      canReports ? quiet(async () => { const {data, error} = await db.from("shift_reports").select("service_date,urgent,low_stock").eq("restaurant_id", restaurantId).gte("service_date", since); return error ? [] : (data ?? []) as {service_date: string; urgent: boolean; low_stock: string}[]; }, [] as {service_date: string; urgent: boolean; low_stock: string}[]) : Promise.resolve([] as {service_date: string; urgent: boolean; low_stock: string}[]),
      quiet(async () => {
        const {data, error} = await db.from("events").select("id,name,starts_at,staff,version,status").eq("restaurant_id", restaurantId).neq("status", "cancelled").gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString());
        if (error || !data?.length) return [];
        const rows = data as {id: string; name: string; starts_at: string; staff: string[]; version: number}[];
        const read = await db.from("event_confirmations").select("event_id,user_id,version").in("event_id", rows.map(r => r.id));
        const done = (read.data ?? []) as {event_id: string; user_id: string; version: number}[];
        return rows.map(r => ({id: r.id, name: r.name, starts_at: r.starts_at, unread: r.staff.filter(id => !done.some(c => c.event_id === r.id && c.user_id === id && c.version === r.version)).length}));
      }, [] as Facts["events"]),
    ]).then(([shifts, posted, sideJobs, list, timeOff, positions, retakes, reports, events]) => {
      if (!live) return;
      const last = reports.filter(r => r.service_date === yesterday && r.low_stock.trim()).map(r => r.low_stock.trim());
      setFacts({shifts, posted, sideJobs, pending: list.filter(c => c.status === "pending").length, released: list.filter(c => c.status === "open").length,
        timeOff, positions, retakes, urgent: reports.filter(r => r.urgent).length, order: last.join(" · "), reportToday: reports.some(r => r.service_date === today), events});
    });
    return () => { live = false; };
  }, [restaurantId, canPreshift, canSchedule, canTeam, canReports]);
  if (!facts) return null;
  const needs = needsFrom(facts, new Date());
  return <section className="panel needs" aria-label="Needs you">
    <div className="needs-head"><p className="section-chip">Needs you</p>{needs.length > 0 && <small>Most urgent first</small>}</div>
    {needs.length ? <ol className="needs-list">{needs.map((n, i) => <li key={`${n.key}-${i}`} className="needs-row">
      <span className={`needs-num${n.hot ? " hot" : ""}`} aria-hidden="true">{i + 1}</span>
      <span className="needs-text"><b>{n.title}</b><small>{n.sub}</small></span>
      <button type="button" className={`btn${i === 0 ? "" : " secondary"}`} onClick={() => onOpen(n.key)}>{n.action}</button>
    </li>)}</ol> : <p className="needs-empty">Nothing is waiting. You're all set for now.</p>}
  </section>;
}

// Last night's report, the part that matters the morning after: the numbers, the issues, what to order
// and what was left for today. Nothing shows when no report came in during the last two days.
export function LastNightCard({restaurantId, onOpen}: {restaurantId: string; onOpen: () => void}) {
  const [report, setReport] = useState<ShiftReport | null | undefined>(undefined);
  useEffect(() => {
    if (!supabase) return;
    let live = true;
    const since = localDay(new Date(Date.now() - 2 * 86_400_000));
    void supabase.from("shift_reports").select("*").eq("restaurant_id", restaurantId).gte("service_date", since).lt("service_date", localDay())
      .order("service_date", {ascending: false}).order("submitted_at", {ascending: false}).limit(1)
      .then(({data, error}) => { if (live) setReport(error ? null : ((data?.[0] as ShiftReport) ?? null)); });
    return () => { live = false; };
  }, [restaurantId]);
  if (!report) return null;
  const notes: [string, string, boolean][] = [
    ...report.issues.slice(0, 2).map(i => ["Issue", `${ISSUE_KINDS[i.kind] ?? i.kind}${i.note ? `: ${i.note}` : ""}`, true] as [string, string, boolean]),
    ["To order", report.low_stock, false], ["For today", report.next_shift, false],
  ];
  const shown = notes.filter(([, text]) => text.trim());
  return <section className="panel last-night" aria-label="Last night">
    <div className="card-row"><b className="text-sm">{`${serviceDay(report.service_date)} · ${report.label}`}</b><button type="button" className="btn secondary" onClick={onOpen}>Full report</button></div>
    <div className="last-night-figures">
      <div><b>{report.covers ?? "—"}</b><span>covers</span></div>
      <div><b>{money(report.sales) ?? "—"}</b><span>sales</span></div>
      <div><b>{MOODS[report.mood] ?? "—"}</b><span>the night</span></div>
    </div>
    {shown.map(([label, text, bad], i) => <p key={i} className={`last-night-note${bad ? " bad" : ""}`}><b>{label}:</b> {text}</p>)}
  </section>;
}

// Today's private event, with its guests' allergies in the lime box and how many of the team read the latest BEO.
export function EventTodayCard({restaurantId, onOpen}: {restaurantId: string; onOpen: () => void}) {
  const [event, setEvent] = useState<{name: string; starts_at: string; ends_at: string; guests: number; codes: string[]; allergies: number; staff: number; read: number} | null>(null);
  useEffect(() => {
    if (!supabase) return;
    const db = supabase;
    let live = true;
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 1);
    void (async () => {
      const {data, error} = await db.from("events").select("id,name,starts_at,ends_at,guests,allergies,staff,version").eq("restaurant_id", restaurantId).neq("status", "cancelled")
        .gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString()).order("starts_at").limit(1);
      const e = (data?.[0] as {id: string; name: string; starts_at: string; ends_at: string; guests: number; allergies: {what: string}[]; staff: string[]; version: number} | undefined);
      if (error || !e) { if (live) setEvent(null); return; }
      const read = await db.from("event_confirmations").select("user_id,version").eq("event_id", e.id);
      const done = ((read.data ?? []) as {user_id: string; version: number}[]).filter(c => c.version === e.version && e.staff.includes(c.user_id)).length;
      const codes = [...new Set(e.allergies.map(a => allergenCode(a.what)).filter(c => c !== "NOTE" && c !== "NONE"))];
      if (live) setEvent({name: e.name, starts_at: e.starts_at, ends_at: e.ends_at, guests: e.guests, codes, allergies: e.allergies.length, staff: e.staff.length, read: done});
    })();
    return () => { live = false; };
  }, [restaurantId]);
  if (!event) return null;
  return <section className="panel event-today" aria-label="Event today">
    <div className="card-row"><b className="text-sm">Event today</b><button type="button" className="btn secondary" onClick={onOpen}>Open BEO</button></div>
    <p className="event-today-name">{event.name}</p>
    <div className="event-today-facts">
      <div><span>Time</span><b>{`${shortTime(new Date(event.starts_at))} – ${shortTime(new Date(event.ends_at))}`}</b></div>
      <div><span>Guests</span><b>{event.guests}</b></div>
      {event.staff > 0 && <div><span>Read the BEO</span><b>{`${event.read} of ${event.staff}`}</b></div>}
    </div>
    {event.allergies > 0 && <div className="event-today-allergens">
      <b>{plural(event.allergies, "guest allergy", "guest allergies")}</b>
      {event.codes.length > 0 && <span className="event-today-codes">{event.codes.map(c => <span key={c}>{c}</span>)}</span>}
      <span>Confirm with the kitchen before serving.</span>
    </div>}
  </section>;
}

// ── Part 2: the day's timeline, and who on the team needs something ──
// One load feeds both cards. Every part that fails to load is simply left out.
export function TodayPlan({restaurantId, items, onOpenSchedule}: {restaurantId: string; items: {id: string; name: string}[]; onOpenSchedule: () => void}) {
  const [data, setData] = useState<{moments: Moment[]; flags: Flag[]; all: Flag[]; names: Map<string, string>} | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    const db = supabase;
    if (!db) return;
    let live = true;
    const quiet = async <T,>(work: () => PromiseLike<T>, fallback: T): Promise<T> => { try { return await work(); } catch { return fallback; } };
    void (async () => {
      const saved = await quiet(async () => (await db.from("schedule_settings").select("*").eq("restaurant_id", restaurantId).maybeSingle()).data, null);
      const settings = readSettings(saved);
      const from = new Date(); from.setHours(0, 0, 0, 0);
      const to = new Date(from); to.setDate(to.getDate() + 1);
      const week = weekStart(new Date(), settings.week_start), weekEnd = addDays(week, 7);
      const today = localDay();
      type Row = DayShift & {break_minutes?: number | null};
      const shiftsIn = (a: Date, b: Date) => quiet(async () => { const {data, error} = await db.from("schedule_shifts").select("user_id,starts_at,ends_at,position,break_minutes").eq("restaurant_id", restaurantId).eq("published", true).gte("starts_at", a.toISOString()).lt("starts_at", b.toISOString()); return error ? [] : (data ?? []) as Row[]; }, [] as Row[]);
      const [shifts, weekShifts, team, board, jobs, floor, events, filed] = await Promise.all([
        shiftsIn(from, to), shiftsIn(week, weekEnd),
        quiet(async () => ((await db.rpc("schedule_team", {rid: restaurantId})).data ?? []) as {user_id: string; name: string}[], []),
        quiet(async () => { const {data, error} = await db.rpc("get_preshift_board", {rid: restaurantId}); if (error) return null; const b = (data as {board?: {restaurant_id: string; note: string; entries: {menu_item_id: string; status: string}[]; focus_item_ids?: string[] | null; focus_item_id?: string | null} | null} | null)?.board ?? null;
          const posted = !!b && b.restaurant_id === restaurantId && (!!b.note?.trim() || !!b.entries?.length || !!b.focus_item_ids?.length || !!b.focus_item_id);
          const name = (id: string) => items.find(i => i.id === id)?.name;
          const pick = (status: string) => posted ? b!.entries.filter(e => e.status === status).map(e => name(e.menu_item_id)).filter((n): n is string => !!n) : [];
          return {posted, out: pick("86"), low: pick("low")}; }, null),
        quiet(async () => {
          const s = await db.from("checklist_shifts").select("id").eq("restaurant_id", restaurantId).eq("shift_date", today);
          if (s.error) return null;
          if (!s.data?.length) return [] as DayJob[];
          const a = await db.from("checklist_assignments").select("job_id,user_id,done_at").in("shift_id", s.data.map(r => r.id as string));
          if (a.error) return null;
          const rows = (a.data ?? []) as {job_id: string | null; user_id: string | null; done_at: string | null}[];
          const ids = [...new Set(rows.map(r => r.job_id).filter((x): x is string => !!x))];
          const j = ids.length ? await db.from("checklist_jobs").select("id,phase").in("id", ids) : {data: [], error: null};
          const phase = new Map(((j.data ?? []) as {id: string; phase: DayJob["phase"]}[]).map(r => [r.id, r.phase]));
          return rows.map(r => ({user_id: r.user_id, phase: (r.job_id && phase.get(r.job_id)) || null, done: !!r.done_at}));
        }, null as DayJob[] | null),
        quiet(async () => { const {data, error} = await db.from("floor_plans").select("rows,posted_at").eq("restaurant_id", restaurantId).eq("service_date", today).eq("service", "Dinner").maybeSingle(); return error ? null : data as {rows: {server_id: string | null; sa: {id?: string}[]}[]; posted_at: string | null} | null; }, null),
        quiet(async () => { const {data, error} = await db.from("events").select("name,starts_at,guests").eq("restaurant_id", restaurantId).neq("status", "cancelled").gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString()); return error ? [] : (data ?? []) as DayInput["events"]; }, [] as DayInput["events"]),
        quiet(async () => { const {count, error} = await db.from("shift_reports").select("id", {count: "exact", head: true}).eq("restaurant_id", restaurantId).eq("service_date", today); return !error && (count ?? 0) > 0; }, false),
      ]);
      if (!live) return;
      const sectionsSent = !!floor?.posted_at;
      const moments = buildDay({settings, shifts, board, jobs, sectionsSent, events, reportFiled: filed}, new Date());
      const weekHours = new Map<string, number>();
      for (const s of weekShifts) weekHours.set(s.user_id, (weekHours.get(s.user_id) ?? 0) + shiftHours(s));
      const inSections = sectionsSent ? new Set((floor?.rows ?? []).flatMap(r => [r.server_id, ...(r.sa ?? []).map(h => h.id)]).filter((x): x is string => !!x)) : null;
      const listed = [...(settings.server_positions ?? []), ...(settings.sa_positions ?? [])];
      const sectionPositions = (p: string) => listed.length ? listed.some(x => x.trim().toLowerCase() === p.trim().toLowerCase()) : /server|assistant|s\.?a\.?$/i.test(p);
      const withJobs = jobs ? new Set(jobs.map(j => j.user_id).filter((x): x is string => !!x)) : null;
      const {flags, all} = flagPeople({settings, today: shifts, weekHours, withJobs, inSections, sectionPositions});
      setData({moments, flags, all, names: new Map(team.map(p => [p.user_id, p.name || "Team member"]))});
    })();
    return () => { live = false; };
  }, [restaurantId, items]);
  if (!data || (!data.moments.length && !data.all.length)) return null;
  const name = (id: string) => data.names.get(id) ?? "Team member";
  const initials = (n: string) => n.split(/\s+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  const people = showAll ? data.all : data.flags;
  const set = data.all.length - data.flags.length;
  return <>
    {data.moments.length > 0 && <section className="panel day-card" aria-label="The day">
      <div className="card-row"><b className="text-sm">The day</b><small className="muted">Schedule, board and events</small></div>
      <ol className="day-line">{data.moments.map((m, i) => <li key={i} className={`day-moment ${m.state}`}>
        <span className="day-time">{momentTime(m)}</span><span className="day-rail" aria-hidden="true"><i /></span>
        <span className="day-text"><b>{m.title}</b>{m.detail && <span>{" · "}{m.detail}</span>}
          {m.tag && <span className={`day-tag ${m.tag.tone}`}>{m.tag.text}</span>}
          {(m.out?.length || m.low?.length) ? <span className="day-chips">{m.out?.map(n => <span key={`o-${n}`} className="out" title="86'd">{n}</span>)}{m.low?.map(n => <span key={`l-${n}`}>{n}{" · "}{"Low count"}</span>)}</span> : null}
        </span>
      </li>)}</ol>
    </section>}
    {data.all.length > 0 && <section className="panel working-card" aria-label="Working today">
      <div className="card-row"><b className="text-sm">{`Working today · ${data.all.length}`}</b>
        {data.all.length > data.flags.length && <button type="button" className="btn secondary" onClick={() => setShowAll(v => !v)}>{showAll ? "Only who needs something" : `See all ${data.all.length}`}</button>}</div>
      {people.length > 0 && <ul className="working-list">{people.map(p => <li key={p.user_id}>
        <span className="working-av" aria-hidden="true">{initials(name(p.user_id))}</span>
        <span className="working-text"><b>{name(p.user_id)}</b><small>{p.position}{p.notes.map(n => <span key={n} className="working-flag">{" · "}{n}</span>)}</small></span>
        <span className="working-time">{p.time}</span>
      </li>)}</ul>}
      {!showAll && <p className="muted text-sm working-foot">{data.flags.length ? `The other ${set} ${set === 1 ? "is" : "are"} set: shift, side work and section.` : "Everyone is set: shift, side work and section."}</p>}
      <button type="button" className="btn secondary working-schedule" onClick={onOpenSchedule}>Open the schedule</button>
    </section>}
  </>;
}
