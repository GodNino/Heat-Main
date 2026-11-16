// The manager's day on Today (v2, part 2): the timeline of the day and who on the team needs something.
// Pure: it takes what was loaded and the time now, so both can be tested without a database.
import { isKitchen, shortTime, type ScheduleSettings } from "./schedule.ts";

export type DayShift = {user_id: string; starts_at: string; ends_at: string; position: string};
export type DayJob = {user_id: string | null; phase: "opening" | "during" | "closing" | null; done: boolean};
export type DayInput = {
  settings: Pick<ScheduleSettings, "kitchen_positions" | "dinner_starts">;
  shifts: DayShift[];
  board: {posted: boolean; out: string[]; low: string[]} | null;
  jobs: DayJob[] | null;
  sectionsSent: boolean;
  events: {name: string; starts_at: string; guests: number}[];
  reportFiled: boolean;
};
export type Moment = {at: number; title: string; detail: string; tag?: {text: string; tone: "ok" | "bad" | "plain"}; out?: string[]; low?: string[]; state: "done" | "now" | "later"};

const crew = (shifts: DayShift[], settings: DayInput["settings"]) => {
  const people = (list: DayShift[]) => new Set(list.map(s => s.user_id)).size;
  const kitchen = shifts.filter(s => isKitchen(s.position, settings));
  const floor = shifts.filter(s => !isKitchen(s.position, settings));
  return `${people(floor)} on the floor, ${people(kitchen)} in the kitchen`;
};
const tally = (jobs: DayJob[], phase: DayJob["phase"]) => {
  const list = jobs.filter(j => j.phase === phase);
  return {total: list.length, done: list.filter(j => j.done).length};
};

// Managers, chefs and owners lead the shift: they don't set when dinner starts and don't get side work.
export const isLead = (position: string) => /manager|\bgm\b|chef|owner|director|supervisor/i.test(position);
// When most of the crew starts (ties go to the earlier time).
function mostCommonStart(list: DayShift[]) {
  const count = new Map<number, number>();
  for (const s of list) { const t = Date.parse(s.starts_at); count.set(t, (count.get(t) ?? 0) + 1); }
  return [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

export function buildDay(input: DayInput, now: Date): Moment[] {
  const {settings, shifts} = input;
  if (!shifts.length && !input.events.length) return [];
  const starts = shifts.map(s => Date.parse(s.starts_at)), ends = shifts.map(s => Date.parse(s.ends_at));
  const day = new Date(now); day.setHours(settings.dinner_starts ?? 16, 0, 0, 0);
  // Dinner is whoever starts from an hour before the restaurant's dinner hour; lunch is everyone before that.
  const cut = day.getTime() - 3_600_000;
  const lunch = shifts.filter(s => Date.parse(s.starts_at) < cut), dinner = shifts.filter(s => Date.parse(s.starts_at) >= cut);
  const first = starts.length ? Math.min(...starts) : null, last = ends.length ? Math.max(...ends) : null;
  // Dinner starts at the restaurant's own dinner hour when it set one (a cook coming in early doesn't move it),
  // otherwise when the first of the dinner crew starts.
  const dinnerStart = !dinner.length ? null : settings.dinner_starts != null ? day.getTime() : mostCommonStart(dinner.filter(s => !isLead(s.position)).length ? dinner.filter(s => !isLead(s.position)) : dinner);
  const list: Omit<Moment, "state">[] = [];
  const jobs = input.jobs ?? [];
  const opening = tally(jobs, "opening"), closing = tally(jobs, "closing");
  if (first !== null && opening.total) list.push({at: first, title: "Opening side work", detail: "", tag: {text: `${opening.done} of ${opening.total}`, tone: opening.done >= opening.total ? "ok" : "plain"}});
  if (lunch.length) list.push({at: Math.min(...lunch.map(s => Date.parse(s.starts_at))), title: "Lunch", detail: crew(lunch, settings)});
  const service = dinnerStart ?? first;
  if (service !== null && input.board) {
    list.push({at: service - 30 * 60_000, title: "Pre-shift", detail: "", tag: input.board.posted ? {text: "Posted", tone: "ok"} : {text: "Not posted", tone: "bad"},
      out: input.board.out, low: input.board.low});
  }
  if (dinner.length && dinnerStart !== null) {
    const handed = jobs.some(j => j.phase !== "opening");
    const sent = [handed && "side work", input.sectionsSent && "sections"].filter(Boolean).join(" and ");
    list.push({at: dinnerStart, title: "Dinner", detail: crew(dinner, settings), tag: sent ? {text: `${sent[0].toUpperCase()}${sent.slice(1)} sent`, tone: "ok"} : input.jobs ? {text: "No side work yet", tone: "bad"} : undefined});
  }
  for (const e of input.events) list.push({at: Date.parse(e.starts_at), title: e.name, detail: `${e.guests} guests`});
  if (last !== null) list.push({at: last, title: "Closing time", detail: closing.total ? `Closing side work ${closing.done} of ${closing.total}` : "",
    tag: input.reportFiled ? {text: "Report filed", tone: "ok"} : {text: "Report due", tone: now.getTime() >= last - 3_600_000 ? "bad" : "plain"}});
  list.sort((a, b) => a.at - b.at);
  const next = list.findIndex(m => m.at > now.getTime());
  return list.map((m, i) => ({...m, state: next === -1 || i < next ? "done" : i === next ? "now" : "later"}));
}
export const momentTime = (m: Moment) => shortTime(new Date(m.at));

export type Flag = {user_id: string; position: string; time: string; notes: string[]};
// Who on today's schedule needs something: close to overtime this week, no side work when the rest
// have theirs, or no section when sections were sent. Everyone else is "set".
export function flagPeople(input: {
  settings: Pick<ScheduleSettings, "kitchen_positions" | "overtime_weekly">; today: DayShift[]; weekHours: Map<string, number>;
  withJobs: Set<string> | null; inSections: Set<string> | null; sectionPositions: (position: string) => boolean;
}): {flags: Flag[]; all: Flag[]} {
  const limit = input.settings.overtime_weekly ?? 40;
  const byPerson = new Map<string, DayShift[]>();
  for (const s of input.today) byPerson.set(s.user_id, [...(byPerson.get(s.user_id) ?? []), s]);
  const all: Flag[] = [];
  for (const [user_id, shifts] of byPerson) {
    const sorted = [...shifts].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    const position = sorted[0].position;
    const time = sorted.map(s => `${shortTime(new Date(s.starts_at))}–${shortTime(new Date(s.ends_at))}`).join(", ");
    const notes: string[] = [];
    const hours = input.weekHours.get(user_id) ?? 0;
    if (hours > limit) notes.push(`${Math.round(hours * 10) / 10} h this week, over ${limit}`);
    else if (hours >= limit - 2) notes.push(`${Math.round(hours * 10) / 10} h this week`);
    const kitchen = isKitchen(position, input.settings);
    if (!kitchen && !isLead(position) && input.withJobs && input.withJobs.size && !input.withJobs.has(user_id)) notes.push("no side work today");
    if (input.inSections && input.sectionPositions(position) && !input.inSections.has(user_id)) notes.push("no section");
    all.push({user_id, position, time, notes});
  }
  return {flags: all.filter(f => f.notes.length), all};
}
