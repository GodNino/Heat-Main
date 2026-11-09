"use client";
// Team chat: HEAT's own chats instead of WhatsApp groups (migration 064).
//   * FOH, BOH, Servers, S.A. & runners, Bar and Managers, each for the people in that position (managers are in
//     all of them), plus direct messages between two people. Nobody adds anyone: the database decides who is in
//     which chat from their position.
//   * Text, photos and voice notes. A manager can send a message as a notice (it reaches phones) and pin
//     messages; pinned ones stay past the 30 days after which messages go.
// New messages arrive live (Realtime) and, as a fallback, every 20 seconds.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Camera, Mic, Pin, Plus, Search, Send, Square, Trash2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { shrinkPhoto } from "./photos";
import { notify } from "./notifications";

type Msg = {id: string; channel: string; user_id: string; kind: "text" | "photo" | "voice"; body: string; media_path: string | null; duration_s: number | null; is_notice: boolean; pinned: boolean; created_at: string};
type Overview = {channel: string; last_at: string | null; last_user: string | null; last_kind: string | null; last_body: string | null; unread: number};
type Person = {user_id: string; name: string; role: string};

const GROUPS: Record<string, {name: string; short: string; who: string}> = {
  foh: {name: "FOH", short: "FOH", who: "Front of house and managers"},
  servers: {name: "Servers", short: "SRV", who: "Servers and managers"},
  sa: {name: "S.A. & runners", short: "S.A.", who: "S.A.s, runners and managers"},
  bar: {name: "Bar", short: "BAR", who: "Bar and managers"},
  boh: {name: "BOH", short: "BOH", who: "Kitchen and managers"},
  managers: {name: "Managers", short: "MGR", who: "Managers only"},
};
const ORDER = ["foh", "servers", "sa", "bar", "boh", "managers"];
const COLS = "id, channel, user_id, kind, body, media_path, duration_s, is_notice, pinned, created_at";
export const dmKey = (a: string, b: string) => `dm:${[a, b].sort().join(":")}`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"});
const dayOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, {weekday: "long", month: "short", day: "numeric"});

// The unread total, for the chat icon in the header.
export function useChatUnread(restaurantId: string | undefined, active: boolean) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!supabase || !restaurantId) return;
    let live = true;
    const load = () => void supabase!.rpc("chat_overview", {rid: restaurantId}).then(({data, error}) => {
      if (live && !error) setCount(((data ?? []) as Overview[]).reduce((n, c) => n + (c.unread || 0), 0));
    });
    load();
    const timer = window.setInterval(load, active ? 20000 : 60000);
    window.addEventListener("focus", load);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener("focus", load); };
  }, [restaurantId, active]);
  return count;
}

export function TeamChat({restaurantId, userId, isManager, onUnread}: {restaurantId: string; userId: string; isManager: boolean; onUnread?: (n: number) => void}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [overview, setOverview] = useState<Overview[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pinned, setPinned] = useState<Msg[]>([]);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [acting, setActing] = useState<string | null>(null);
  const [recording, setRecording] = useState<{started: number} | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const openRef = useRef<string | null>(null);
  openRef.current = open;

  const explain = (e: unknown) => {
    const text = e instanceof Error ? e.message : String((e as {message?: string})?.message ?? e);
    return /chat_|PGRST20|42P01|42883/.test(text) ? "The chat needs database update 064." : text;
  };
  const nameOf = useCallback((id: string | null) => people.find(p => p.user_id === id)?.name ?? "Team member", [people]);
  const roleOf = (id: string) => people.find(p => p.user_id === id)?.role ?? "";
  const title = (ch: string) => ch.startsWith("dm:") ? nameOf(ch.split(":").slice(1).find(id => id !== userId) ?? null) : GROUPS[ch]?.name ?? ch;

  const loadOverview = useCallback(async () => {
    if (!supabase) return;
    const res = await supabase.rpc("chat_overview", {rid: restaurantId});
    if (res.error) { setError(explain(res.error)); return; }
    const rows = (res.data ?? []) as Overview[];
    setOverview(rows);
    onUnread?.(rows.reduce((n, c) => n + (c.channel === openRef.current ? 0 : c.unread || 0), 0));
  }, [restaurantId, onUnread]);

  useEffect(() => {
    if (!supabase) return;
    void supabase.rpc("schedule_team", {rid: restaurantId}).then(({data}) => setPeople((data ?? []) as Person[]));
    void loadOverview();
  }, [restaurantId, loadOverview]);

  const markRead = useCallback(async (channel: string) => {
    await supabase?.from("chat_reads").upsert({restaurant_id: restaurantId, user_id: userId, channel, last_read_at: new Date().toISOString()}, {onConflict: "restaurant_id,user_id,channel"});
  }, [restaurantId, userId]);

  const loadChannel = useCallback(async (channel: string) => {
    if (!supabase) return;
    const [recent, pins] = await Promise.all([
      supabase.from("chat_messages").select(COLS).eq("restaurant_id", restaurantId).eq("channel", channel).order("created_at", {ascending: false}).limit(150),
      supabase.from("chat_messages").select(COLS).eq("restaurant_id", restaurantId).eq("channel", channel).eq("pinned", true).order("created_at", {ascending: false}).limit(10),
    ]);
    if (recent.error) { setError(explain(recent.error)); return; }
    if (openRef.current !== channel) return;
    setMsgs(((recent.data ?? []) as Msg[]).reverse());
    setPinned((pins.data ?? []) as Msg[]);
    await markRead(channel);
    void loadOverview();
  }, [restaurantId, markRead, loadOverview]);

  useEffect(() => { if (open) { setMsgs([]); setPinned([]); setActing(null); setNotice(false); void loadChannel(open); } }, [open, loadChannel]);

  // Live: new and deleted messages; a poll covers a dropped connection.
  useEffect(() => {
    if (!supabase) return;
    const sub = supabase.channel(`chat-${restaurantId}`)
      .on("postgres_changes", {event: "*", schema: "public", table: "chat_messages", filter: `restaurant_id=eq.${restaurantId}`}, payload => {
        const row = (payload.new ?? payload.old) as Partial<Msg>;
        if (row?.channel && row.channel === openRef.current) void loadChannel(row.channel); else void loadOverview();
      }).subscribe();
    const timer = window.setInterval(() => { if (openRef.current) void loadChannel(openRef.current); else void loadOverview(); }, 20000);
    return () => { void supabase!.removeChannel(sub); window.clearInterval(timer); };
  }, [restaurantId, loadChannel, loadOverview]);

  // Signed links for photos and voice notes.
  useEffect(() => {
    const missing = [...msgs, ...pinned].map(m => m.media_path).filter((p): p is string => !!p && !links[p]);
    if (!missing.length || !supabase) return;
    void supabase.storage.from("chat-media").createSignedUrls([...new Set(missing)], 3600).then(({data}) => {
      if (data) setLinks(l => ({...l, ...Object.fromEntries(data.filter(d => d.path && d.signedUrl).map(d => [d.path!, d.signedUrl as string]))}));
    });
  }, [msgs, pinned, links]);

  useEffect(() => { list.current?.scrollTo({top: list.current.scrollHeight}); }, [msgs.length, open]);

  async function post(fields: Partial<Msg>) {
    if (!supabase || !open) return;
    setError("");
    const res = await supabase.from("chat_messages").insert({restaurant_id: restaurantId, channel: open, user_id: userId, is_notice: isManager && notice && !open.startsWith("dm:"), ...fields}).select("id, is_notice, channel").single();
    if (res.error) { setError(explain(res.error)); return false; }
    const made = res.data as {id: string; is_notice: boolean; channel: string};
    // Direct messages and notices reach phones; the rest show as unread.
    if (made.is_notice || made.channel.startsWith("dm:")) notify("chat_message", made.id);
    setNotice(false);
    await loadChannel(open);
    return true;
  }
  async function sendText(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    if (await post({kind: "text", body: text.slice(0, 2000)})) setDraft("");
    setBusy(false);
  }
  async function upload(file: Blob, ext: string, type: string) {
    const path = `${restaurantId}/${open}/${crypto.randomUUID()}.${ext}`;
    const up = await supabase!.storage.from("chat-media").upload(path, file, {contentType: type, cacheControl: "31536000"});
    if (up.error) throw up.error;
    return path;
  }
  async function sendPhoto(file: File | undefined) {
    if (!file || !open || busy) return;
    setBusy(true); setError("");
    try {
      const shrunk = await shrinkPhoto(file);
      const ext = shrunk.type === "image/png" ? "png" : shrunk.type === "image/webp" ? "webp" : "jpg";
      const path = await upload(shrunk, ext, shrunk.type || "image/jpeg");
      await post({kind: "photo", media_path: path, body: draft.trim().slice(0, 2000)});
      setDraft("");
    } catch (e) { setError(explain(e)); }
    finally { setBusy(false); }
  }
  async function startVoice() {
    if (recording || busy) return;
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(t => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) ?? "";
      const rec = new MediaRecorder(stream, type ? {mimeType: type} : undefined);
      chunks.current = [];
      rec.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
      recorder.current = rec;
      rec.start();
      setRecording({started: Date.now()});
      // At most two minutes.
      window.setTimeout(() => { if (recorder.current === rec && rec.state === "recording") void stopVoice(true); }, 120000);
    } catch { setError("The microphone isn't available. Allow it for HEAT in your browser or phone settings."); }
  }
  async function stopVoice(send: boolean) {
    const rec = recorder.current, started = recording?.started ?? Date.now();
    if (!rec) return;
    const done = new Promise<void>(resolve => { rec.onstop = () => resolve(); });
    rec.stop(); rec.stream.getTracks().forEach(t => t.stop());
    await done;
    recorder.current = null; setRecording(null);
    if (!send || !chunks.current.length) return;
    setBusy(true);
    try {
      const type = (rec.mimeType || "audio/webm").split(";")[0];
      const blob = new Blob(chunks.current, {type});
      const path = await upload(blob, type === "audio/mp4" ? "m4a" : "webm", type);
      await post({kind: "voice", media_path: path, duration_s: Math.min(600, Math.round((Date.now() - started) / 1000))});
    } catch (e) { setError(explain(e)); }
    finally { setBusy(false); }
  }
  async function setPin(m: Msg, on: boolean) {
    const res = await supabase!.rpc("chat_set_pinned", {message_id: m.id, on_off: on});
    if (res.error) setError(explain(res.error)); else { setActing(null); await loadChannel(m.channel); }
  }
  async function remove(m: Msg) {
    const res = await supabase!.from("chat_messages").delete().eq("id", m.id);
    if (res.error) setError(explain(res.error)); else { setActing(null); await loadChannel(m.channel); }
  }

  const groups = ORDER.map(k => overview.find(o => o.channel === k)).filter((o): o is Overview => !!o);
  const dms = overview.filter(o => o.channel.startsWith("dm:")).sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? ""));
  const preview = (o: Overview) => !o.last_at ? "No messages yet" : `${o.last_user === userId ? "You" : nameOf(o.last_user)}: ${o.last_kind === "photo" ? "Photo" : o.last_kind === "voice" ? "Voice note" : o.last_body ?? ""}`;
  const others = useMemo(() => people.filter(p => p.user_id !== userId && (!query.trim() || `${p.name} ${p.role}`.toLowerCase().includes(query.trim().toLowerCase()))), [people, userId, query]);
  const canAct = (m: Msg) => m.user_id === userId || (isManager && !m.channel.startsWith("dm:"));

  const row = (o: Overview) => <button key={o.channel} type="button" className="tc-ch" aria-current={open === o.channel} onClick={() => { setPicking(false); setOpen(o.channel); }}>
    <span className={`tc-ico${o.channel.startsWith("dm:") ? " dm" : ""}`} data-no-translate>{o.channel.startsWith("dm:") ? title(o.channel).trim()[0]?.toUpperCase() : GROUPS[o.channel]?.short}</span>
    <span className="tc-what"><b data-no-translate={o.channel.startsWith("dm:") || undefined}>{title(o.channel)}</b><small data-no-translate>{preview(o)}</small></span>
    <span className="tc-meta">{o.last_at ? clock(o.last_at) : ""}{o.unread > 0 && open !== o.channel && <span className="tc-unread">{o.unread}</span>}</span>
  </button>;

  let lastDay = "";
  return <section className={`tc${open || picking ? " opened" : ""}`} aria-label="Team chat">
    <aside className="tc-list" aria-label="Chats">
      <div className="tc-list-head"><h1>Chat</h1>
        <button type="button" className="btn secondary" onClick={() => { setPicking(true); setOpen(null); setQuery(""); }}><Plus size={14} aria-hidden="true" />New message</button></div>
      {error && !open && <p className="notice tc-error" role="alert">{error}</p>}
      {groups.map(row)}
      {dms.length > 0 && <p className="tc-sub">Direct messages</p>}
      {dms.map(row)}
      <p className="tc-note">Messages go after 30 days. Pinned messages stay.</p>
    </aside>

    {picking && !open ? <section className="tc-chat" aria-label="New message">
      <div className="tc-head"><button type="button" className="btn secondary tc-back" onClick={() => setPicking(false)}><ArrowLeft size={14} aria-hidden="true" />Chats</button><b>New message</b></div>
      <div className="tc-pick">
        <label className="tc-search"><Search size={16} aria-hidden="true" /><input id="tc-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search the team" autoComplete="off" /></label>
        {others.map(p => <button key={p.user_id} type="button" className="tc-ch" onClick={() => { setPicking(false); setOpen(dmKey(userId, p.user_id)); }}>
          <span className="tc-ico dm" data-no-translate>{p.name.trim()[0]?.toUpperCase()}</span>
          <span className="tc-what"><b data-no-translate>{p.name}</b><small data-no-translate>{p.role}</small></span>
        </button>)}
      </div>
    </section> : open ? <section className="tc-chat" aria-label={title(open)}>
      <div className="tc-head">
        <button type="button" className="btn secondary tc-back" onClick={() => { setOpen(null); void loadOverview(); }}><ArrowLeft size={14} aria-hidden="true" />Chats</button>
        <span className={`tc-ico${open.startsWith("dm:") ? " dm" : ""}`} data-no-translate>{open.startsWith("dm:") ? title(open).trim()[0]?.toUpperCase() : GROUPS[open]?.short}</span>
        <span className="tc-what"><b data-no-translate={open.startsWith("dm:") || undefined}>{title(open)}</b><small>{open.startsWith("dm:") ? "Direct message" : GROUPS[open]?.who}</small></span>
      </div>
      {pinned.length > 0 && <div className="tc-pins">{pinned.slice(0, 3).map(p => <p key={p.id}><Pin size={13} aria-hidden="true" /><span data-no-translate>{p.kind === "text" ? p.body : p.kind === "photo" ? (p.body || "Photo") : "Voice note"}</span></p>)}</div>}
      <div className="tc-msgs" ref={list} aria-live="polite">
        {!msgs.length && <p className="tc-empty">No messages yet. Say hello.</p>}
        {msgs.map(m => {
          const day = dayOf(m.created_at), showDay = day !== lastDay; lastDay = day;
          const mine = m.user_id === userId, url = m.media_path ? links[m.media_path] : "";
          return <div key={m.id}>
            {showDay && <p className="tc-day" data-no-translate>{day}</p>}
            <div className={`tc-msg${mine ? " me" : ""}`}>
              {!mine && <span className="tc-av" aria-hidden="true" data-no-translate>{nameOf(m.user_id).trim()[0]?.toUpperCase()}</span>}
              <div className={`tc-bubble${m.is_notice ? " notice" : ""}`} onClick={() => canAct(m) || (isManager && !m.channel.startsWith("dm:")) ? setActing(a => a === m.id ? null : m.id) : undefined}>
                {m.is_notice && <span className="tc-kind">Notice</span>}
                {!mine && <p className="tc-from"><b data-no-translate>{nameOf(m.user_id)}</b><span data-no-translate>{roleOf(m.user_id)}</span></p>}
                {m.kind === "photo" && (url ? <img src={url} alt="Photo" className="tc-photo" /> : <span className="tc-loading">Photo</span>)}
                {m.kind === "voice" && (url ? <audio controls preload="none" src={url} className="tc-audio" /> : <span className="tc-loading">Voice note</span>)}
                {m.body && <p className="tc-text" data-no-translate>{m.body}</p>}
                <p className="tc-time">{clock(m.created_at)}{m.pinned ? " · " : ""}{m.pinned && <span>Pinned</span>}{m.kind === "voice" && m.duration_s ? ` · ${m.duration_s}s` : ""}</p>
                {acting === m.id && <div className="tc-actions" onClick={e => e.stopPropagation()}>
                  {isManager && !m.channel.startsWith("dm:") && <button type="button" className="btn secondary" onClick={() => void setPin(m, !m.pinned)}><Pin size={13} aria-hidden="true" />{m.pinned ? "Unpin" : "Pin"}</button>}
                  {canAct(m) && <button type="button" className="btn secondary" onClick={() => void remove(m)}><Trash2 size={13} aria-hidden="true" />Delete</button>}
                </div>}
              </div>
            </div>
          </div>;
        })}
      </div>
      {error && <p className="notice tc-error" role="alert">{error}</p>}
      <form className="tc-composer" onSubmit={sendText}>
        {recording ? <>
          <span className="tc-rec" role="status"><span className="tc-rec-dot" aria-hidden="true" />Recording…</span>
          <button type="button" className="btn secondary" onClick={() => void stopVoice(false)}><X size={14} aria-hidden="true" />Cancel</button>
          <button type="button" className="btn" onClick={() => void stopVoice(true)}><Square size={12} aria-hidden="true" />Send voice note</button>
        </> : <>
          <label className="tc-icon" title="Send a photo" aria-label="Send a photo"><Camera size={20} aria-hidden="true" /><input type="file" accept="image/*" className="sr-only" disabled={busy} onChange={e => { void sendPhoto(e.target.files?.[0]); e.target.value = ""; }} /></label>
          <button type="button" className="tc-icon" title="Record a voice note" aria-label="Record a voice note" disabled={busy} onClick={() => void startVoice()}><Mic size={20} aria-hidden="true" /></button>
          <input id="tc-draft" className="tc-input" value={draft} maxLength={2000} onChange={e => setDraft(e.target.value)} placeholder="Write a message" autoComplete="off" />
          {isManager && !open.startsWith("dm:") && <button type="button" className="tc-notice-chip" aria-pressed={notice} onClick={() => setNotice(n => !n)} title="Notices reach everyone's phone">Notice</button>}
          <button type="submit" className="btn tc-send" aria-label="Send" disabled={busy || !draft.trim()}><Send size={14} aria-hidden="true" /><span className="tc-send-label">Send</span></button>
        </>}
      </form>
    </section> : <section className="tc-chat tc-none" aria-label="No chat open"><p className="muted">Pick a chat, or start a direct message.</p></section>}
  </section>;
}
