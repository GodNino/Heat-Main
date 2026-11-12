"use client";
// Invite by email (071; mockup "Invitaciones por correo"). On Team, a manager writes the person's
// email, an optional name, their position and the email's language. HEAT saves the invitation and
// emails the join link from "<restaurant> via HEAT"; replies go to the manager. Until email is set up
// in Vercel (RESEND_API_KEY) it opens the manager's own email app with the message written instead.
// Below, every invitation: pending, joined, expired or cancelled, with Resend and Cancel.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { PositionChips } from "./position-chips";
import { currentLang } from "./language";
import { inviteEmail } from "@/lib/invite-email";
import { Field, Notice } from "./ui";

type Invite = {token: string; email: string; name: string; role: string; lang: "en" | "es"; sent_at: string; expires_at: string; accepted_at: string | null; cancelled_at: string | null};
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ago = (at: string) => {
  const days = Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};
export function inviteState(i: Pick<Invite, "accepted_at" | "cancelled_at" | "expires_at">, now = Date.now()) {
  return i.accepted_at ? "joined" : i.cancelled_at ? "cancelled" : new Date(i.expires_at).getTime() <= now ? "expired" : "pending";
}
const LABEL = {pending: "Pending", joined: "Joined", expired: "Expired", cancelled: "Cancelled"} as const;

export function EmailInvites({restaurantId, restaurantName}: {restaurantId: string; restaurantName: string}) {
  const [list, setList] = useState<Invite[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("Server");
  const [typing, setTyping] = useState(false);
  const [lang, setLang] = useState<"en" | "es">(() => (currentLang() === "es" ? "es" : "en"));
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!supabase) return;
    const r = await supabase.from("email_invites").select("token, email, name, role, lang, sent_at, expires_at, accepted_at, cancelled_at").eq("restaurant_id", restaurantId).order("sent_at", {ascending: false}).limit(50);
    if (r.error) { setMissing(/relation|does not exist|schema cache/i.test(r.error.message)); setList([]); return; }
    setList((r.data ?? []) as Invite[]);
  }, [restaurantId]);
  useEffect(() => { void load(); }, [load]);

  // Save (or renew) the invitation, then email it.
  async function send(to: {email: string; name: string; role: string; lang: "en" | "es"}) {
    if (!supabase) return;
    setBusy(true); setError(""); setMessage("");
    const saved = await supabase.rpc("save_email_invite", {rid: restaurantId, invite_email: to.email, invite_name: to.name, invite_role: to.role, invite_lang: to.lang});
    if (saved.error) { setBusy(false); return setError(saved.error.message); }
    const token = saved.data as string;
    const {data: session} = await supabase.auth.getSession();
    const result = await fetch("/api/invite-email", {
      method: "POST",
      headers: {"Content-Type": "application/json", Authorization: `Bearer ${session.session?.access_token ?? ""}`},
      body: JSON.stringify({invite: token}),
    }).then(r => r.json()).catch(() => null) as {sent?: boolean; configured?: boolean; error?: string} | null;
    setBusy(false);
    await load();
    if (result?.sent) { setMessage(`Invite sent to ${to.email}.`); return true; }
    if (result?.configured === false) {
      // No email service yet: the manager's own email app, with the message already written.
      const mail = inviteEmail({restaurant: restaurantName, inviter: to.lang === "es" ? "Tu manager" : "Your manager", name: to.name, role: to.role, lang: to.lang, link: `${window.location.origin}/app?invite=${token}`});
      window.location.href = `mailto:${encodeURIComponent(to.email)}?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.text)}`;
      setMessage("Invitation saved. Your email app opened with the message ready to send.");
      return true;
    }
    setError(result?.error ?? "The invitation was saved but the email didn't go out. Try Resend in a minute.");
    return false;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = email.trim();
    if (!EMAIL.test(clean)) { setBad(true); return; }
    if (!role.trim()) { setError("Choose a position for this person."); return; }
    setBad(false);
    if (await send({email: clean, name: name.trim(), role: role.trim(), lang})) { setEmail(""); setName(""); }
  }
  async function cancel(i: Invite) {
    setError(""); setMessage("");
    const r = await supabase!.rpc("cancel_email_invite", {invite_token: i.token});
    if (r.error) return setError(r.error.message);
    setMessage(`Invitation for ${i.email} cancelled.`); await load();
  }

  if (missing) return null;
  return <section className="panel mt-5 mb-5 p-5 invite-mail">
    <h2 className="text-xl font-semibold">Invite someone by email</h2>
    <p className="muted mt-2 text-sm">We email them a link to join {restaurantName}. It works for 7 days.</p>
    <Notice text={error} error />
    <Notice text={message} />
    <form className="invite-mail-form" onSubmit={e => void submit(e)} noValidate>
      <Field label="Email"><input id="invite-email" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" maxLength={254} value={email} aria-invalid={bad}
        onChange={e => { setEmail(e.target.value); if (bad) setBad(false); }} placeholder="name@email.com" /></Field>
      {bad && <p className="invite-mail-error" role="alert">Write a full email address, like name@gmail.com.</p>}
      <Field label="Name (optional)"><input id="invite-name" maxLength={60} value={name} onChange={e => setName(e.target.value)} placeholder="Lucía" /></Field>
      <fieldset className="invite-mail-position">
        <legend>Position</legend>
        <PositionChips value={role} otherOn={typing} onPick={value => { setTyping(false); setRole(value); }} onOther={() => { setTyping(true); setRole(""); }} />
        {typing && <input id="invite-role" aria-label="Their position" maxLength={40} value={role} onChange={e => setRole(e.target.value)} placeholder="Captain, maître d', expo…" />}
        {role && !typing && <p className="muted text-sm">They join as {role}.</p>}
      </fieldset>
      <div className="invite-mail-lang" role="group" aria-label="Email language">
        <span>Email in</span>
        <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")}>English</button>
        <button type="button" aria-pressed={lang === "es"} onClick={() => setLang("es")}>Español</button>
      </div>
      <button className="btn" disabled={busy || !email.trim()}>{busy ? "Sending…" : "Send invite"}</button>
    </form>
    {list && list.length > 0 && <>
      <p className="section-chip invite-mail-chip">Invitations</p>
      <div className="invite-mail-list">
        {list.map(i => { const state = inviteState(i); return <div key={i.token} className="invite-mail-row">
          <div className="invite-mail-head">
            <span><b>{i.name ? `${i.name} · ` : ""}{i.email}</b><small>{i.role} · {state === "joined" && i.accepted_at ? `Joined ${ago(i.accepted_at)}` : `Sent ${ago(i.sent_at)}`}</small></span>
            <span className={`invite-mail-state ${state}`}>{LABEL[state]}</span>
          </div>
          {state !== "joined" && <div className="invite-mail-actions">
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void send({email: i.email, name: i.name, role: i.role, lang: i.lang})}>Resend</button>
            {state === "pending" && <button type="button" className="btn secondary" disabled={busy} onClick={() => void cancel(i)}>Cancel</button>}
          </div>}
        </div>; })}
      </div>
      <p className="muted mt-3 text-xs">Resend sends a new link and turns off the old one.</p>
    </>}
  </section>;
}
