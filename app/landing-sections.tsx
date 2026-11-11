"use client";
// The landing page's interactive pieces (docs/mockups/landing.html): one Friday night shown two
// ways, a product tour where a list drives the picture beside it, and a role switcher. Each one
// shows a complete state before anyone touches it, so the page reads the same with scripts off.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";

const NIGHT = [
  {time: "2:00 PM", what: "The schedule", today: "Someone asks in the group chat who's working tonight. Nobody answers.", heat: "Everyone already has their shifts on their phone. Changes wait for a manager.", tag: "Schedule"},
  {time: "4:30 PM", what: "Side work", today: "The same names on the whiteboard as last week.", heat: "Side work and sections sent in a few taps. Each person sees theirs.", tag: "Side work"},
  {time: "5:00 PM", what: "Pre-shift", today: "Half the team hears the 86 list. The other half arrives late.", heat: "Tonight's board on the phone of everyone working today.", tag: "Pre-shift"},
  {time: "7:45 PM", what: "An allergy question", today: "“I think it has no sesame.” The server runs to the kitchen.", heat: "Pick the allergies, see what to avoid and what to confirm.", tag: "Allergies"},
  {time: "9:30 PM", what: "A new server", today: "Day three, still reading the binder between tables.", heat: "Studied the raw bar with the tutor before the shift.", tag: "AI tutor"},
  {time: "11:30 PM", what: "Close", today: "The night's story leaves with the closing manager.", heat: "A shift report the owners read from home, urgent ones first.", tag: "Report"},
];

export function NightTimeline() {
  const [mode, setMode] = useState<"today" | "heat">("heat");
  return <div className="lp2-night">
    <div className="lp2-night-head">
      <div>
        <p className="eyebrow muted">One Friday night</p>
        <h2 className="site-heading lp-big">Same restaurant.<br />Two different nights.</h2>
      </div>
      <div className="lp2-toggle" role="group" aria-label="Show the night">
        <button type="button" aria-pressed={mode === "today"} onClick={() => setMode("today")}>Today</button>
        <button type="button" className="heat" aria-pressed={mode === "heat"} onClick={() => setMode("heat")}>With HEAT</button>
      </div>
    </div>
    <ol className={`lp2-timeline ${mode}`}>
      {NIGHT.map(m => <li key={m.time} className="lp2-moment">
        <span className="lp2-time">{m.time}</span>
        <span className="lp2-what">{m.what}</span>
        <div className="lp2-moment-card"><span className="lp2-moment-tag">{mode === "heat" ? m.tag : "Today"}</span><p>{mode === "heat" ? m.heat : m.today}</p></div>
      </li>)}
    </ol>
  </div>;
}

export type TourStop = {title: string; text: string; points: string[]; visual: ReactNode};

export function ProductTour({stops}: {stops: TourStop[]}) {
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Moves on by itself every few seconds while it's on screen, until someone picks a stop.
  useEffect(() => {
    if (paused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let visible = false;
    const watch = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    if (box.current) watch.observe(box.current);
    const id = window.setInterval(() => { if (visible) setCurrent(n => (n + 1) % stops.length); }, 6500);
    return () => { window.clearInterval(id); watch.disconnect(); };
  }, [paused, stops.length]);
  return <div className={`lp2-tour${paused ? " paused" : ""}`} ref={box}>
    <div className="lp2-stops" role="tablist" aria-label="Product">
      {stops.map((s, i) => <button key={s.title} type="button" role="tab" aria-selected={i === current} className="lp2-stop"
        onClick={() => { setCurrent(i); setPaused(true); }}>
        <span className="lp2-stop-num">{String(i + 1).padStart(2, "0")}</span>
        <span className="lp2-stop-body">
          <span className="lp2-stop-title">{s.title}</span>
          {i === current && <span className="lp2-stop-text">{s.text}</span>}
          {i === current && <span className="lp2-stop-points">{s.points.map(p => <span key={p}><Check size={14} aria-hidden="true" />{p}</span>)}</span>}
        </span>
        {/* On a phone the picture sits right under the stop that was tapped, the full width. */}
        {i === current && <span className="lp2-stop-visual lp-scene-visual" aria-hidden="true">{s.visual}</span>}
        {i === current && !paused && <span key={current} className="lp2-stop-progress" aria-hidden="true" />}
      </button>)}
    </div>
    <div className="lp2-tour-visual" role="tabpanel" aria-label={stops[current].title}>
      <div className="lp-scene-visual" aria-hidden="true">{stops[current].visual}</div>
    </div>
  </div>;
}

export type Role = {key: string; label: string; line: string; who: string; items: string[]};

export function RoleSwitch({roles}: {roles: Role[]}) {
  const [current, setCurrent] = useState(0);
  const role = roles[current];
  return <div className="lp2-roles">
    <div className="lp2-role-chips" role="group" aria-label="Your role">
      {roles.map((r, i) => <button key={r.key} type="button" aria-pressed={i === current} onClick={() => setCurrent(i)}>{r.label}</button>)}
    </div>
    <div className="lp2-role-panel" aria-live="polite">
      <div className="lp2-role-big brand-aside"><p>{role.line}</p><small>{role.who}</small></div>
      <ul className="lp2-role-list">{role.items.map(item => <li key={item}><Check size={16} aria-hidden="true" />{item}</li>)}</ul>
    </div>
  </div>;
}
