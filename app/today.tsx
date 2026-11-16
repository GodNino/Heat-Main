"use client";

// The top of the manager's Today: three figures for the day, then one compact card with a row for
// Pre-shift, Side work and the last shift report. A row says what it needs in one look:
// a red "Not posted" button, an amber "In progress" button, or a green dot once it is done.
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Pencil } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { formatHours, shiftHours, shortTime } from "@/lib/schedule";
import { serviceDay } from "@/lib/shift-report";
import { Stats } from "./ui";
import type { ShiftBoardResponse } from "./employee-home";

const localDay = (d = new Date()) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

// Today in four numbers: people and hours on today's schedule (hours against the same day last week),
// and last night's covers and sales from the shift reports (against the same night the week before).
// Requests now live in "Needs you". A night without a report says so instead of showing zero.
type NightFigures = {covers: number | null; sales: number | null} | null;
const percentVs = (now: number, before: number) => {
  const p = Math.round((now - before) / before * 100);
  return p === 0 ? "Same as" : `${p > 0 ? "+" : "−"}${Math.abs(p)}% vs`;
};
const weekdayName = (d: Date) => d.toLocaleDateString("en-US", {weekday: "long"});
export function TodayFigures({restaurantId, canReports = false}: {restaurantId: string; canReports?: boolean}) {
  const [figures, setFigures] = useState<{people: number; hours: number; hoursBefore: number; night: NightFigures; nightBefore: NightFigures} | null>(null);
  useEffect(() => {
    const db = supabase;
    if (!db) return;
    let alive = true;
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const day = (offset: number) => { const d = new Date(from); d.setDate(d.getDate() + offset); return d; };
    const quiet = async <T,>(work: () => PromiseLike<T>, fallback: T) => { try { return await work(); } catch { return fallback; } };
    type Row = {user_id: string; starts_at: string; ends_at: string};
    const shifts = (a: Date, b: Date) => quiet(async () => { const {data, error} = await db.from("schedule_shifts").select("user_id,starts_at,ends_at").eq("restaurant_id", restaurantId).gte("starts_at", a.toISOString()).lt("starts_at", b.toISOString()); return error ? [] : (data ?? []) as Row[]; }, [] as Row[]);
    // One night can have a lunch and a dinner report: they add up. No report at all is null, not zero.
    const night = (d: Date): Promise<NightFigures> => canReports ? quiet(async () => {
      const {data, error} = await db.from("shift_reports").select("covers,sales").eq("restaurant_id", restaurantId).eq("service_date", localDay(d));
      const rows = (data ?? []) as {covers: number | null; sales: number | string | null}[];
      if (error || !rows.length) return null;
      const covers = rows.some(r => r.covers != null) ? rows.reduce((sum, r) => sum + (r.covers ?? 0), 0) : null;
      const sales = rows.some(r => r.sales != null && r.sales !== "") ? rows.reduce((sum, r) => sum + Number(r.sales ?? 0), 0) : null;
      return {covers, sales};
    }, null as NightFigures) : Promise.resolve(null);
    void Promise.all([shifts(from, day(1)), shifts(day(-7), day(-6)), night(day(-1)), night(day(-8))]).then(([today, before, last, lastBefore]) => {
      if (alive) setFigures({people: new Set(today.map(s => s.user_id)).size, hours: today.reduce((sum, s) => sum + shiftHours(s), 0),
        hoursBefore: before.reduce((sum, s) => sum + shiftHours(s), 0), night: last, nightBefore: lastBefore});
    });
    return () => {alive = false;};
  }, [restaurantId, canReports]);
  if (!figures) return null;
  const now = new Date(), lastNight = new Date(now.getTime() - 86_400_000);
  const compare = (value: number | null | undefined, before: number | null | undefined, when: Date) =>
    value != null && before ? `${percentVs(value, before)} last ${weekdayName(when)}` : undefined;
  const dollars = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
  const items: {value: string; label: string; note?: string}[] = [
    {value: String(figures.people), label: "Working today"},
    {value: formatHours(figures.hours), label: "Scheduled today", note: compare(figures.hours, figures.hoursBefore, now)},
  ];
  if (canReports) items.push(
    {value: figures.night?.covers != null ? String(figures.night.covers) : "—", label: "Covers last night", note: figures.night ? compare(figures.night.covers, figures.nightBefore?.covers, lastNight) : "No report last night"},
    {value: figures.night?.sales != null ? dollars(figures.night.sales) : "—", label: "Sales last night", note: figures.night ? compare(figures.night.sales, figures.nightBefore?.sales, lastNight) : "No report last night"},
  );
  return <Stats items={items} />;
}

type SideWork = {total: number; done: number};
// A first post stamps both times within a blink; anything past a few seconds apart is a real edit.
const EDIT_GAP = 5000;

function Row({title, sub, dot, right, onClick}: {title: string; sub: string; dot?: boolean; right?: ReactNode; onClick: () => void}) {
  return <li><button type="button" className="today-row" onClick={onClick}>
    <span className="today-row-text"><b>{title}{dot && <i className="today-state on" aria-hidden="true" />}</b><small>{sub}</small></span>
    {right}
  </button></li>;
}

export function TodayStatus({restaurantId, canPreshift, canReports, onPreshift, onSideWork, onReport, doneOnly = false}: {
  restaurantId: string; canPreshift: boolean; canReports: boolean; onPreshift: (edit: boolean) => void; onSideWork: () => void; onReport: () => void;
  // On the v2 Today, "Needs you" already asks for what is missing: show only what is posted or under way.
  doneOnly?: boolean;
}) {
  const [board, setBoard] = useState<ShiftBoardResponse["board"] | undefined>(undefined);
  const [side, setSide] = useState<SideWork | undefined>(undefined);
  const [report, setReport] = useState<{service_date: string; label: string; submitted_at: string; id: string} | null>(null);
  const [writer, setWriter] = useState("");
  useEffect(() => {
    const db = supabase;
    if (!db) return;
    let alive = true;
    if (canPreshift) {
      void db.rpc("get_preshift_board", {rid: restaurantId}).then(({data}) => {
        if (alive) setBoard((data as ShiftBoardResponse | null)?.board ?? null);
      });
      void (async () => {
        try {
          const shifts = await db.from("checklist_shifts").select("id").eq("restaurant_id", restaurantId).eq("shift_date", localDay());
          if (shifts.error || !shifts.data?.length) {if (alive) setSide({total: 0, done: 0});return;}
          const jobs = await db.from("checklist_assignments").select("done_at").in("shift_id", shifts.data.map(row => row.id as string));
          const rows = jobs.error ? [] : (jobs.data ?? []) as {done_at: string | null}[];
          if (alive) setSide({total: rows.length, done: rows.filter(row => !!row.done_at).length});
        } catch {if (alive) setSide({total: 0, done: 0});}
      })();
    }
    if (canReports) {
      const since = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
      void Promise.resolve(db.from("shift_reports").select("id,service_date,label,submitted_at").eq("restaurant_id", restaurantId).gte("service_date", since)
        .order("service_date", {ascending: false}).order("submitted_at", {ascending: false}).limit(1)).then(async ({data}) => {
        const latest = (data?.[0] as {id: string; service_date: string; label: string; submitted_at: string} | undefined) ?? null;
        if (!alive) return;
        setReport(latest);
        if (!latest) return;
        const names = await db.rpc("shift_report_names", {report_id: latest.id});
        if (alive) setWriter((((names.data ?? []) as {written_by: string}[])[0]?.written_by) ?? "");
      }, () => {});
    }
    return () => {alive = false;};
  }, [restaurantId, canPreshift, canReports]);
  const posted = !!board && board.restaurant_id === restaurantId && (!!board.note.trim() || !!board.entries.length || !!board.focus_item_ids?.length || !!board.focus_item_id);
  const edited = posted && !!board?.created_at && !!board?.updated_at && new Date(board.updated_at).getTime() - new Date(board.created_at).getTime() > EDIT_GAP;
  const by = board?.posted_by_name?.trim();
  const when = board?.created_at ? shortTime(new Date(board.created_at)) : "";
  const preSub = posted
    ? `${by ? `Posted by ${by}` : "Posted"}${when ? ` · ${when}` : ""}${edited && board?.updated_at ? ` · Edited ${shortTime(new Date(board.updated_at))}` : ""}`
    : "Your team sees nothing yet";
  const arrow = <ChevronRight size={14} aria-hidden="true" />;
  const sideSub = !side || !side.total ? "No jobs handed out yet" : side.done >= side.total ? `${side.total} ${side.total === 1 ? "job" : "jobs"} · all finished` : `${side.total} ${side.total === 1 ? "job" : "jobs"} · ${side.done} done`;
  const rows: ReactNode[] = [];
  if (canPreshift && board !== undefined && (posted || !doneOnly)) rows.push(<Row key="pre" title="Pre-shift" sub={preSub} dot={posted} onClick={() => onPreshift(posted)}
    right={posted ? <span className="icon-chip" aria-label="Edit today’s pre-shift"><Pencil size={14} aria-hidden="true" /></span> : <span className="today-pill fail">Not posted{arrow}</span>} />);
  if (canPreshift && side && (side.total > 0 || !doneOnly)) rows.push(<Row key="side" title="Side work" sub={sideSub} dot={!!side.total && side.done >= side.total} onClick={onSideWork}
    right={!side.total ? <span className="today-pill fail">Not posted{arrow}</span> : side.done < side.total ? <span className="today-pill warn">In progress{arrow}</span> : undefined} />);
  if (canReports && report && !doneOnly) rows.push(<Row key="report" title="Last shift report" sub={`${serviceDay(report.service_date)} ${report.label}${writer ? ` · Filed by ${writer}` : ""}`} onClick={onReport}
    right={<span className="today-more">{arrow}</span>} />);
  if (!rows.length) return null;
  return <section className="panel today-card today-status" aria-label="Today"><ul>{rows}</ul></section>;
}
