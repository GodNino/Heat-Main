"use client";
// Employee of the month (067; mockup in docs/mockups/empleado-del-mes.html). A manager with Team
// access nominates 2 to 4 people in front of house and in the kitchen; employees vote once in each,
// anonymously, never for themselves. Managers close the vote, see the count, and announce it: the
// winners then show to everyone, with what their teammates wrote. Past months stay below.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { isKitchen, KITCHEN_POSITIONS } from "@/lib/schedule";
import { Field, Notice, ScreenHeader } from "./ui";
import { notify } from "./notifications";

export type Round = {id: string; month: string; foh: string[]; boh: string[]; closes_at: string; status: "open" | "closed" | "announced"; announced_at: string | null};
type Person = {user_id: string; name: string; role: string};
type Result = {area: "foh" | "boh"; nominee_id: string; votes: number; reasons: string[]};
type Area = "foh" | "boh";
const AREAS: {key: Area; label: string}[] = [{key: "foh", label: "Front of house"}, {key: "boh", label: "Kitchen"}];
const MAX = 4, MIN = 2;

export const monthName = (month: string) => new Date(`${month.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", {month: "long", year: "numeric"});
const closeLabel = (at: string) => new Date(at).toLocaleString("en-US", {weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"});
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase() || "?";
// End of this month at 11 pm, the default closing time, as a value for <input type="datetime-local">.
function defaultClose() {
  const d = new Date(); const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}`;
}
// The top of each area: everyone tied for most votes (with at least one vote).
export function winnersOf(results: Result[], area: Area) {
  const rows = results.filter(r => r.area === area);
  const top = Math.max(0, ...rows.map(r => r.votes));
  return top ? rows.filter(r => r.votes === top) : [];
}

export function useOpenRound(restaurantId: string | undefined) {
  const [round, setRound] = useState<Round | null>(null);
  useEffect(() => {
    if (!supabase || !restaurantId) return;
    let live = true;
    void supabase.from("recognition_rounds").select("id, month, foh, boh, closes_at, status, announced_at").eq("restaurant_id", restaurantId)
      .order("month", {ascending: false}).limit(1).then(({data, error}) => { if (live && !error) setRound(((data ?? [])[0] as Round | undefined) ?? null); });
    return () => { live = false; };
  }, [restaurantId]);
  return round;
}

export function EmployeeOfMonth({restaurantId, userId, canManage, canVote}: {restaurantId: string; userId: string; canManage: boolean; canVote: boolean}) {
  const [rounds, setRounds] = useState<Round[] | null>(null);
  const [team, setTeam] = useState<Person[]>([]);
  const [kitchen, setKitchen] = useState<string[] | null>(null);
  const [results, setResults] = useState<Record<string, Result[]>>({});
  const [turnout, setTurnout] = useState<{voted: number; eligible: number} | null>(null);
  const [mine, setMine] = useState<Partial<Record<Area, string>>>({});
  const [pick, setPick] = useState<Partial<Record<Area, string>>>({});
  const [why, setWhy] = useState("");
  const [nominees, setNominees] = useState<Record<Area, string[]>>({foh: [], boh: []});
  const [closes, setCloses] = useState(defaultClose);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!supabase) return;
    const [r, people, settings] = await Promise.all([
      supabase.from("recognition_rounds").select("id, month, foh, boh, closes_at, status, announced_at").eq("restaurant_id", restaurantId).order("month", {ascending: false}).limit(13),
      supabase.rpc("schedule_team", {rid: restaurantId}),
      supabase.from("schedule_settings").select("kitchen_positions").eq("restaurant_id", restaurantId).maybeSingle(),
    ]);
    if (r.error) { setError(/relation|does not exist|schema cache/i.test(r.error.message) ? "Employee of the month isn't set up yet. Run migration 067." : "Couldn't load the vote. Check your connection and try again."); setRounds([]); return; }
    const list = (r.data ?? []) as Round[];
    setRounds(list);
    setTeam((people.data ?? []) as Person[]);
    setKitchen((settings.data as {kitchen_positions?: string[] | null} | null)?.kitchen_positions ?? null);
    const current = list[0];
    // Results we may read: managers once closed, everyone once announced.
    const readable = list.filter(x => x.status === "announced" || (x.status === "closed" && canManage));
    const found = await Promise.all(readable.map(x => supabase!.rpc("recognition_results", {round: x.id}).then(res => [x.id, (res.data ?? []) as Result[]] as const)));
    setResults(Object.fromEntries(found));
    if (current?.status === "open") {
      const [votes, count] = await Promise.all([
        supabase.rpc("my_recognition_votes", {round: current.id}),
        canManage ? supabase.rpc("recognition_turnout", {round: current.id}) : Promise.resolve({data: null}),
      ]);
      setMine(Object.fromEntries(((votes.data ?? []) as {area: Area; nominee_id: string}[]).map(v => [v.area, v.nominee_id])));
      setTurnout(((count.data ?? []) as {voted: number; eligible: number}[])[0] ?? null);
    }
  }, [restaurantId, canManage]);
  useEffect(() => { void load(); }, [load]);

  const nameOf = useCallback((id: string) => team.find(p => p.user_id === id)?.name ?? "Former team member", [team]);
  const roleOf = useCallback((id: string) => team.find(p => p.user_id === id)?.role ?? "", [team]);
  const sides = useMemo(() => {
    const settings = {kitchen_positions: kitchen ?? KITCHEN_POSITIONS};
    const staff = team.filter(p => p.user_id !== userId || !canManage);
    return {foh: staff.filter(p => !isKitchen(p.role ?? "", settings)), boh: staff.filter(p => isKitchen(p.role ?? "", settings))};
  }, [team, kitchen, userId, canManage]);

  async function run(work: () => PromiseLike<{error: {message: string} | null}>, done: string) {
    setBusy(true); setError(""); setMessage("");
    const {error: failed} = await work();
    setBusy(false);
    if (failed) { setError(failed.message); return false; }
    setMessage(done); await load(); return true;
  }
  // A pinned notice in the front-of-house and kitchen chats, which also reaches their phones.
  async function announceInChat(text: string) {
    if (!supabase) return;
    for (const channel of ["foh", "boh"]) {
      const posted = await supabase.from("chat_messages").insert({restaurant_id: restaurantId, channel, user_id: userId, body: text, is_notice: true}).select("id").maybeSingle();
      const id = (posted.data as {id?: string} | null)?.id;
      if (id) { void supabase.rpc("chat_set_pinned", {message_id: id, on_off: true}); notify("chat_message", id); }
    }
  }

  async function start() {
    if (nominees.foh.length < MIN || nominees.boh.length < MIN) return setError("Choose 2 to 4 nominees in each area.");
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
    const ok = await run(() => supabase!.rpc("open_recognition", {rid: restaurantId, for_month: month, foh_ids: nominees.foh, boh_ids: nominees.boh, closes: new Date(closes).toISOString()}),
      "Vote published. The team can vote now.");
    if (ok) { setStarting(false); setNominees({foh: [], boh: []}); void announceInChat(`Vote for employee of the month of ${monthName(month)}: open HEAT and pick one from front of house and one from the kitchen. Voting closes ${closeLabel(new Date(closes).toISOString())}.`); }
  }
  async function vote(round: Round) {
    const areas = AREAS.filter(a => pick[a.key] && !mine[a.key]);
    if (!areas.length) return;
    setBusy(true); setError(""); setMessage("");
    for (const a of areas) {
      const {error: failed} = await supabase!.rpc("cast_recognition_vote", {round: round.id, vote_area: a.key, nominee: pick[a.key], reason: why});
      if (failed) { setBusy(false); setError(failed.message); await load(); return; }
    }
    setBusy(false); setPick({}); setWhy(""); setMessage("Vote sent. Thanks!"); await load();
  }
  async function announce(round: Round) {
    const ok = await run(() => supabase!.rpc("set_recognition_status", {round: round.id, next_status: "announced"}), "Winners announced to the team.");
    if (ok) {
      const res = results[round.id] ?? [];
      const names = (area: Area) => winnersOf(res, area).map(w => nameOf(w.nominee_id)).join(" and ") || "no votes";
      void announceInChat(`Employees of the month, ${monthName(round.month)}: ${names("foh")} (front of house) and ${names("boh")} (kitchen). Congratulations!`);
    }
  }

  if (!rounds) return <section className="mx-auto max-w-3xl"><p className="muted" role="status">Loading…</p></section>;
  const current = rounds[0];
  const thisMonth = new Date().toISOString().slice(0, 7);
  const canStart = canManage && (!current || (current.status === "announced" && current.month.slice(0, 7) !== thisMonth));
  const past = rounds.filter(r => r.status === "announced" && r !== (current?.status === "announced" ? current : undefined));

  const personRow = (id: string, opts: {selected?: boolean; onClick?: () => void; disabled?: boolean; note?: string; role?: "radio" | "checkbox"}) =>
    <button key={id} type="button" className="eotm-person" role={opts.role} aria-checked={opts.role ? !!opts.selected : undefined} aria-pressed={opts.role ? undefined : !!opts.selected}
      disabled={opts.disabled || busy} onClick={opts.onClick}>
      <span className="eotm-avatar" aria-hidden="true">{initials(nameOf(id))}</span>
      <span className="eotm-who"><b>{nameOf(id)}</b><small>{roleOf(id)}{opts.note ? ` · ${opts.note}` : ""}</small></span>
      <span className="eotm-tick" aria-hidden="true">{opts.selected ? <Check size={14} /> : null}</span>
    </button>;

  const winnersCard = (round: Round, big: boolean) => {
    const res = results[round.id] ?? [];
    return <section key={round.id} className={`panel eotm-card${big ? "" : " compact"}`}>
      {!big && <p className="eotm-label">{monthName(round.month)}</p>}
      {AREAS.map(a => {
        const top = winnersOf(res, a.key);
        return <div key={a.key} className="eotm-winner-area">
          <p className="section-chip">{a.label}</p>
          {top.length ? top.map(w => <div key={w.nominee_id} className="eotm-winner">
            <span className="eotm-avatar big" aria-hidden="true">{initials(nameOf(w.nominee_id))}</span>
            <div><b>{nameOf(w.nominee_id)}</b><small>{roleOf(w.nominee_id)}</small></div>
            {big && w.reasons.slice(0, 3).map(r => <p key={r} className="eotm-quote">“{r}”</p>)}
          </div>) : <p className="muted">No votes in this area.</p>}
        </div>;
      })}
    </section>;
  };

  return <section className="mx-auto max-w-3xl eotm">
    <ScreenHeader eyebrow="Team" title="Employee of the month"
      info="Managers pick the nominees. Employees vote once for front of house and once for the kitchen, and the vote is anonymous. Winners are announced to everyone." />
    <Notice text={error} error />
    <Notice text={message} />

    {canStart && !starting && <section className="panel eotm-card">
      <p className="eotm-label">{current ? "Start next month's vote" : "No vote yet"}</p>
      <p className="muted">Pick 2 to 4 nominees for front of house and for the kitchen. The team gets a notice in chat.</p>
      <button type="button" className="btn" onClick={() => { setStarting(true); setError(""); }}>Start a vote</button>
    </section>}

    {starting && <section className="panel eotm-card">
      <p className="eotm-label">{monthName(new Date().toISOString().slice(0, 8) + "01")}</p>
      {AREAS.map(a => <div key={a.key} className="eotm-area">
        <div className="eotm-area-head"><p className="section-chip">{a.label}</p><span className="eotm-count">{nominees[a.key].length} of {MAX}</span></div>
        {sides[a.key].length ? <div className="eotm-people">{sides[a.key].map(p => personRow(p.user_id, {
          selected: nominees[a.key].includes(p.user_id),
          onClick: () => setNominees(n => n[a.key].includes(p.user_id) ? {...n, [a.key]: n[a.key].filter(x => x !== p.user_id)}
            : n[a.key].length >= MAX ? (setError(`Up to ${MAX} nominees per area.`), n) : {...n, [a.key]: [...n[a.key], p.user_id]}),
        }))}</div> : <p className="muted">No one in this area on the team yet.</p>}
      </div>)}
      <Field label="Voting closes"><input id="eotm-close" type="datetime-local" value={closes} onChange={e => setCloses(e.target.value)} /></Field>
      <div className="eotm-actions">
        <button type="button" className="btn" disabled={busy || nominees.foh.length < MIN || nominees.boh.length < MIN} onClick={() => void start()}>Publish vote</button>
        <button type="button" className="btn secondary" disabled={busy} onClick={() => setStarting(false)}>Cancel</button>
      </div>
    </section>}

    {current?.status === "open" && <section className="panel eotm-card">
      <p className="eotm-label">{monthName(current.month)}</p>
      <p className="muted">{new Date(current.closes_at) > new Date() ? `Voting closes ${closeLabel(current.closes_at)}.` : "Voting time is over."}</p>
      {canManage && turnout && <div className="eotm-turnout">
        <div className="eotm-turnout-head"><b>{turnout.voted} of {turnout.eligible} employees voted</b><span>{turnout.eligible ? Math.round(turnout.voted / turnout.eligible * 100) : 0}%</span></div>
        <div className="eotm-bar"><span style={{width: `${turnout.eligible ? Math.min(100, turnout.voted / turnout.eligible * 100) : 0}%`}} /></div>
        <p className="muted">Results show once you close the vote.</p>
      </div>}
      {AREAS.map(a => {
        const list = current[a.key];
        const done = mine[a.key];
        return <div key={a.key} className="eotm-area">
          <p className="section-chip">{a.label}</p>
          <div className="eotm-people" role={canVote && !done ? "radiogroup" : undefined} aria-label={a.label}>
            {list.map(id => personRow(id, canVote && !done && new Date(current.closes_at) > new Date()
              ? {role: "radio", selected: pick[a.key] === id, disabled: id === userId, note: id === userId ? "You" : undefined, onClick: () => setPick(p => ({...p, [a.key]: id}))}
              : {selected: done === id, disabled: true, note: done === id ? "Your vote" : undefined}))}
          </div>
        </div>;
      })}
      {canVote && (!mine.foh || !mine.boh) && new Date(current.closes_at) > new Date() && <>
        <Field label="Why? (optional)"><input id="eotm-why" maxLength={200} value={why} onChange={e => setWhy(e.target.value)} placeholder="A sentence for your teammates" /></Field>
        <p className="muted text-sm">Your vote is anonymous.</p>
        <button type="button" className="btn" disabled={busy || !AREAS.some(a => pick[a.key] && !mine[a.key])} onClick={() => void vote(current)}>Send vote</button>
      </>}
      {canVote && mine.foh && mine.boh && <p className="muted">You voted. Winners are announced after voting closes.</p>}
      {canManage && <div className="eotm-actions"><button type="button" className="btn secondary" disabled={busy}
        onClick={() => void run(() => supabase!.rpc("set_recognition_status", {round: current.id, next_status: "closed"}), "Vote closed. Here are the results.")}>Close the vote now</button></div>}
    </section>}

    {current?.status === "closed" && canManage && <section className="panel eotm-card">
      <p className="eotm-label">Results · {monthName(current.month)}</p>
      <p className="muted">Only managers see this until you announce it.</p>
      {AREAS.map(a => {
        const rows = (results[current.id] ?? []).filter(r => r.area === a.key).sort((x, y) => y.votes - x.votes);
        const total = rows.reduce((s, r) => s + r.votes, 0);
        const top = winnersOf(results[current.id] ?? [], a.key).map(w => w.nominee_id);
        return <div key={a.key} className="eotm-area">
          <p className="section-chip">{a.label}</p>
          {rows.map(r => <div key={r.nominee_id} className="eotm-result">
            <div className="eotm-turnout-head"><b>{nameOf(r.nominee_id)}{top.includes(r.nominee_id) ? " · Wins" : ""}</b><span>{r.votes} {r.votes === 1 ? "vote" : "votes"}</span></div>
            <div className={`eotm-bar${top.includes(r.nominee_id) ? " win" : ""}`}><span style={{width: `${total ? r.votes / total * 100 : 0}%`}} /></div>
            {r.reasons.slice(0, 3).map(q => <p key={q} className="eotm-quote">“{q}”</p>)}
          </div>)}
        </div>;
      })}
      <button type="button" className="btn" disabled={busy} onClick={() => void announce(current)}>Announce winners</button>
    </section>}
    {current?.status === "closed" && !canManage && <section className="panel eotm-card"><p className="eotm-label">{monthName(current.month)}</p><p className="muted">Voting is closed. Winners are announced soon.</p></section>}

    {current?.status === "announced" && <>{winnersCard(current, true)}</>}

    {past.length > 0 && <section className="eotm-past">
      <p className="section-chip">Past months</p>
      {past.map(r => winnersCard(r, false))}
    </section>}
  </section>;
}

// Home: a card while there's a vote this person still has to cast, or this month's winners.
export function EmployeeOfMonthCard({restaurantId, onOpen}: {restaurantId: string; onOpen: () => void}) {
  const round = useOpenRound(restaurantId);
  const [voted, setVoted] = useState<boolean | null>(null);
  useEffect(() => {
    if (!supabase || !round || round.status !== "open") return;
    void supabase.rpc("my_recognition_votes", {round: round.id}).then(({data}) => setVoted(((data ?? []) as unknown[]).length >= 2));
  }, [round]);
  if (!round) return null;
  const recent = round.status === "announced" && round.announced_at && Date.now() - new Date(round.announced_at).getTime() < 7 * 86_400_000;
  if (round.status === "open" && voted === false && new Date(round.closes_at) > new Date()) return <section className="panel eotm-home">
    <p className="section-chip">Employee of the month</p>
    <b className="eotm-home-title">Vote for employee of the month of {monthName(round.month).split(" ")[0]}</b>
    <p className="muted">Pick one from front of house and one from the kitchen. Voting closes {closeLabel(round.closes_at)}.</p>
    <button type="button" className="btn secondary" onClick={onOpen}>Vote</button>
  </section>;
  if (recent) return <section className="panel eotm-home">
    <p className="section-chip">Employee of the month</p>
    <b className="eotm-home-title">This month's winners are in</b>
    <button type="button" className="btn secondary" onClick={onOpen}>See the winners</button>
  </section>;
  return null;
}
