"use client";
// Choosing a position in two short groups, FOH and BOH, plus "Other" for whatever a restaurant calls
// the job. Shared by the invite link (042), the team member editor and invite by email (071).
import type { ReactNode } from "react";
import { useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { FOH_POSITIONS, KITCHEN_POSITIONS } from "@/lib/schedule";

export const POSITION_GROUPS = [
  {key: "foh", label: "FOH", title: "Front of house", positions: FOH_POSITIONS},
  {key: "boh", label: "BOH", title: "Kitchen", positions: KITCHEN_POSITIONS},
] as const;
export const samePosition = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Positions in two short groups: FOH and BOH. Tapping one shows its positions; the group holding the
// chosen position starts open and says which one it is. "Other" is for whatever this restaurant calls the job.
export function PositionChips({value, otherOn, onPick, onOther, before}: {value: string; otherOn: boolean; onPick: (position: string) => void; onOther: () => void; before?: ReactNode}) {
  const holder = POSITION_GROUPS.find(g => g.positions.some(p => samePosition(p, value)));
  const [open, setOpen] = useState<"foh" | "boh" | null>(holder?.key ?? null);
  const shown = POSITION_GROUPS.find(g => g.key === open);
  return <>
    <div className="word-chips">
      {before}
      {POSITION_GROUPS.map(group => {
        const picked = group.positions.find(p => samePosition(p, value));
        return <button key={group.key} type="button" className="word-chip position-group" aria-expanded={open === group.key} aria-pressed={!!picked && !otherOn} title={group.title}
          onClick={() => setOpen(open === group.key ? null : group.key)}>
          <b>{group.label}</b>{picked && !otherOn ? <span>{` · ${picked}`}</span> : <small>{group.title}</small>}<ChevronDown size={14} aria-hidden="true" className={open === group.key ? "rotate-180" : ""} />
        </button>;
      })}
      <button type="button" className="word-chip" aria-pressed={otherOn} onClick={onOther}><Plus size={14} />Other</button>
    </div>
    {shown && <div className="word-chips position-list" role="group" aria-label={shown.title}>
      {shown.positions.map(position => <button key={position} type="button" className="word-chip" aria-pressed={!otherOn && samePosition(position, value)} onClick={() => onPick(position)}>{position}</button>)}
    </div>}
  </>;
}

