// "Needs you" on the manager's Today (app/manager-today.tsx): what is waiting, most urgent first, and how
// that changes with the time of day. Pure, so the order can be tested without a database.
import { shortTime } from "./schedule.ts";

export type NeedTarget = "urgent" | "order" | "preshift" | "sidework" | "released" | "events" | "write_report"
  | "shift_changes" | "time_off" | "positions" | "retakes";
export type Need = {key: NeedTarget; title: string; sub: string; action: string; hot: boolean};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
// Morning until noon; "close" from an hour before the last shift ends (or 10 PM without a schedule).
export function partOfDay(now: Date, lastEnd: number | null): "morning" | "afternoon" | "close" {
  if (now.getHours() < 12) return "morning";
  if (lastEnd ? now.getTime() >= lastEnd - 3_600_000 : now.getHours() >= 22) return "close";
  return "afternoon";
}

export type Facts = {
  shifts: {user_id: string; starts_at: string; ends_at: string}[];
  posted: boolean | null; sideJobs: number | null;
  pending: number; released: number; timeOff: number; positions: number; retakes: number; urgent: number;
  order: string; reportToday: boolean;
  events: {id: string; name: string; starts_at: string; unread: number}[];
};

// Builds the list from what was loaded. Pure, so the order can be tested.
export function needsFrom(f: Facts, now: Date): Need[] {
  const lastEnd = f.shifts.length ? Math.max(...f.shifts.map(s => Date.parse(s.ends_at))) : null;
  // The next start still ahead (the dinner crew), not a manager who came in earlier.
  const ahead = f.shifts.map(s => Date.parse(s.starts_at)).filter(t => t > now.getTime());
  const firstStart = ahead.length ? Math.min(...ahead) : null;
  const part = partOfDay(now, lastEnd);
  const working = new Set(f.shifts.map(s => s.user_id)).size;
  const serviceLeft = lastEnd !== null && lastEnd > now.getTime();
  const hot: Need[] = [], later: Need[] = [];
  if (f.urgent) hot.push({key: "urgent", title: plural(f.urgent, "urgent shift report", "urgent shift reports"), sub: "An allergy incident or an injury was reported", action: "Open report", hot: true});
  if (part === "morning" && f.order) hot.push({key: "order", title: "Order from last night's report", sub: f.order, action: "Open report", hot: true});
  if (part !== "close" && serviceLeft && f.posted === false) hot.push({key: "preshift", title: "Pre-shift not posted",
    sub: `${firstStart ? `Service starts at ${shortTime(new Date(firstStart))}` : "Service is on"} · ${plural(working, "person", "people")} will read it`, action: "Post pre-shift", hot: true});
  if (part !== "close" && serviceLeft && f.sideJobs === 0) hot.push({key: "sidework", title: "Side work not handed out", sub: "Nobody has a job for tonight yet", action: "Hand out side work", hot: true});
  if (f.released) hot.push({key: "released", title: plural(f.released, "shift nobody has taken", "shifts nobody has taken"), sub: "Someone gave it up and it's still open", action: "Find someone", hot: true});
  for (const e of f.events) if (e.unread && Date.parse(e.starts_at) > now.getTime()) hot.push({key: "events", title: `${plural(e.unread, "person hasn't", "people haven't")} read the BEO`, sub: `${e.name} · ${shortTime(new Date(e.starts_at))}`, action: "Open BEO", hot: true});
  if (part === "close" && working && !f.reportToday) hot.push({key: "write_report", title: "Write tonight's report", sub: "Covers, sales, issues and what to order", action: "Write report", hot: true});
  if (f.pending) later.push({key: "shift_changes", title: plural(f.pending, "shift change to approve", "shift changes to approve"), sub: "Swaps and covers waiting for you", action: "Review", hot: false});
  if (f.timeOff) later.push({key: "time_off", title: plural(f.timeOff, "time off request", "time off requests"), sub: "Waiting for an answer", action: "Review", hot: false});
  if (f.positions) later.push({key: "positions", title: plural(f.positions, "new person needs a position", "new people need a position"), sub: "So they show up in the schedule and side work", action: "Assign", hot: false});
  if (f.retakes) later.push({key: "retakes", title: plural(f.retakes, "quiz retake to approve", "quiz retakes to approve"), sub: "Someone asked to take a quiz again", action: "Review", hot: false});
  return [...hot, ...later];
}

