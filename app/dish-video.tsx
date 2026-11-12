"use client";
// A card's video (069, 070; mockup in docs/mockups, "Videos de platos"). The top of the dish card
// becomes a small slider: the photo first, the video second. Swipe on it, use its arrows, or tap
// "Photo" / "Video". The video's link is only asked for when someone opens it, and leaving the
// video pauses it. Swiping on the slider never changes the dish (the card's own swipe does that).
// Managers with Library access add, replace or remove the video from the dish editor.
import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { ChevronLeft, ChevronRight, Play, Video } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { validateVideo, videoPath, type MenuItem } from "@/lib/menu";

export const videoLength = (seconds: number | null | undefined) => {
  const s = Math.max(0, Math.round(seconds ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function DishMedia({item, photo}: {item: MenuItem; photo: ReactNode}) {
  const [onVideo, setOnVideo] = useState(false);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const player = useRef<HTMLVideoElement>(null);
  const touch = useRef<{x: number; y: number} | null>(null);
  // A different card starts on its photo again.
  useEffect(() => { setOnVideo(false); setUrl(""); setFailed(false); }, [item.id, item.video_path]);
  useEffect(() => {
    if (!onVideo) { player.current?.pause(); return; }
    if (url || !item.video_path || !supabase) return;
    let live = true;
    void supabase.storage.from("menu-videos").createSignedUrl(item.video_path, 3600).then(({data, error}) => {
      if (!live) return;
      if (error || !data?.signedUrl) setFailed(true); else setUrl(data.signedUrl);
    });
    return () => { live = false; };
  }, [onVideo, url, item.video_path]);
  if (!item.video_path) return <>{photo}</>;

  const length = videoLength(item.video_seconds);
  // A wine without a photo still gets a cover to tap.
  const cover = photo ?? <button type="button" className="dish-media-empty" onClick={() => setOnVideo(true)}><Play size={20} aria-hidden="true" />Watch the video</button>;
  // Swipes here stay here: stopping them keeps the card's own swipe from moving to another dish.
  const swipe = {
    onTouchStart: (event: TouchEvent) => { event.stopPropagation(); const t = event.touches[0]; touch.current = event.touches.length === 1 ? {x: t.clientX, y: t.clientY} : null; },
    onTouchMove: (event: TouchEvent) => event.stopPropagation(),
    onTouchEnd: (event: TouchEvent) => {
      event.stopPropagation();
      const start = touch.current, end = event.changedTouches[0];
      touch.current = null;
      if (!start || !end) return;
      const across = end.clientX - start.x;
      if (Math.abs(across) > 50 && Math.abs(across) > Math.abs(end.clientY - start.y) * 1.5) setOnVideo(across < 0);
    },
  };
  return <div className="dish-media">
    <div className="dish-media-stage" aria-roledescription="carousel" aria-label="Photo and video" {...swipe}>
      {onVideo
        ? <div className="dish-media-video">
            {failed ? <p className="dish-media-msg">The video couldn't load. Check your connection and try again.</p>
              : url ? <video ref={player} src={url} controls playsInline autoPlay preload="metadata" aria-label={`${item.name} video`} />
              : <p className="dish-media-msg" role="status">Loading the video…</p>}
            {item.video_by && <span className="dish-media-by">{item.video_by}</span>}
          </div>
        : <div className="dish-media-photo">{cover}<span className="dish-media-length"><Play size={12} aria-hidden="true" />Video · {length}</span></div>}
      <button type="button" className="dish-media-arrow prev" aria-label="Show the photo" hidden={!onVideo} onClick={() => setOnVideo(false)}><ChevronLeft size={20} /></button>
      <button type="button" className="dish-media-arrow next" aria-label="Show the video" hidden={onVideo} onClick={() => setOnVideo(true)}><ChevronRight size={20} /></button>
    </div>
    <div className="dish-media-tabs" role="group" aria-label="Photo or video">
      <button type="button" aria-pressed={!onVideo} onClick={() => setOnVideo(false)}>Photo</button>
      <button type="button" aria-pressed={onVideo} onClick={() => setOnVideo(true)}><Play size={12} aria-hidden="true" />Video {length}</button>
    </div>
  </div>;
}

// How long a chosen file runs, read by the browser without uploading anything.
function readLength(file: File) {
  return new Promise<number | undefined>(resolve => {
    const probe = document.createElement("video");
    const link = URL.createObjectURL(file);
    const done = (seconds?: number) => { URL.revokeObjectURL(link); resolve(seconds); };
    probe.preload = "metadata";
    probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? probe.duration : undefined);
    probe.onerror = () => done(undefined);
    probe.src = link;
  });
}

// In the dish editor: add, replace or remove the video, and say who explains it. Saves on its own,
// separate from the dish form, so a long upload never holds the rest of the edit.
export function DishVideoEditor({item, onChanged}: {item: MenuItem; onChanged: (patch: Pick<MenuItem, "video_path" | "video_seconds" | "video_by">) => void}) {
  const [by, setBy] = useState(item.video_by ?? "");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const busy = progress !== null;

  async function choose(file: File | undefined) {
    if (!file || !supabase) return;
    setError(""); setNote("");
    const seconds = await readLength(file);
    const problem = validateVideo(file, seconds);
    if (problem) return setError(problem);
    const path = videoPath(item.restaurant_id, item.id, file.type);
    setProgress(10);
    // The storage client has no progress events; the bar moves while it works and fills when done.
    const tick = window.setInterval(() => setProgress(p => p === null ? null : Math.min(90, p + 5)), 700);
    const up = await supabase.storage.from("menu-videos").upload(path, file, {contentType: file.type, cacheControl: "31536000"});
    window.clearInterval(tick);
    if (up.error) { setProgress(null); return setError("The video didn't upload. Check your connection and try again."); }
    const patch = {video_path: path, video_seconds: seconds ? Math.max(1, Math.min(600, Math.round(seconds))) : null, video_by: by.trim() || null};
    const saved = await supabase.from("menu_items").update(patch).eq("id", item.id);
    if (saved.error) {
      await supabase.storage.from("menu-videos").remove([path]);
      setProgress(null); return setError(saved.error.message);
    }
    // The old file goes, so nobody pays to keep a video no one can open.
    if (item.video_path && item.video_path !== path) await supabase.storage.from("menu-videos").remove([item.video_path]);
    setProgress(null); setNote("Video saved.");
    onChanged(patch);
  }
  async function saveBy() {
    if (!supabase || !item.video_path || (item.video_by ?? "") === by.trim()) return;
    const saved = await supabase.from("menu_items").update({video_by: by.trim() || null}).eq("id", item.id);
    if (saved.error) return setError(saved.error.message);
    setNote("Saved."); onChanged({video_path: item.video_path, video_seconds: item.video_seconds ?? null, video_by: by.trim() || null});
  }
  async function remove() {
    if (!supabase || !item.video_path) return;
    setConfirmRemove(false);
    const saved = await supabase.from("menu_items").update({video_path: null}).eq("id", item.id);
    if (saved.error) return setError(saved.error.message);
    await supabase.storage.from("menu-videos").remove([item.video_path]);
    setBy(""); setNote("Video removed.");
    onChanged({video_path: null, video_seconds: null, video_by: null});
  }

  return <div className="dish-video-editor">
    <p className="dish-video-label">Video (optional)</p>
    <div className="dish-video-box">
      {item.video_path
        ? <div className="dish-video-current"><Video size={18} aria-hidden="true" /><span><b>Video · {videoLength(item.video_seconds)}</b><small>{item.video_by ? `Explained by ${item.video_by}` : "No name yet"}</small></span></div>
        : <p className="muted text-sm">Record a minute or two: what it is, how it's made, its allergens and how to sell it. MP4 or MOV, up to 100 MB.</p>}
      {busy && <div className="dish-video-progress" role="progressbar" aria-label="Uploading the video" aria-valuenow={progress}><span style={{width: `${progress}%`}} /></div>}
      {error && <p className="dish-video-error" role="alert">{error}</p>}
      {note && !error && <p className="muted text-sm" role="status">{note}</p>}
      <div className="dish-video-actions">
        <label className={`btn secondary${busy ? " disabled" : ""}`}>
          <input type="file" accept="video/mp4,video/quicktime,video/webm" capture="environment" hidden disabled={busy}
            onChange={event => { const f = event.target.files?.[0]; event.target.value = ""; void choose(f); }} />
          Record video
        </label>
        <label className={`btn secondary${busy ? " disabled" : ""}`}>
          <input type="file" accept="video/mp4,video/quicktime,video/webm" hidden disabled={busy}
            onChange={event => { const f = event.target.files?.[0]; event.target.value = ""; void choose(f); }} />
          {item.video_path ? "Replace video" : "Choose from gallery"}
        </label>
        {item.video_path && !confirmRemove && <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove video</button>}
      </div>
      {confirmRemove && <div className="dish-video-confirm"><span>Remove this video for everyone?</span><div className="dish-video-actions"><button type="button" className="btn secondary" onClick={() => setConfirmRemove(false)}>Keep it</button><button type="button" className="btn secondary" onClick={() => void remove()}>Remove</button></div></div>}
    </div>
    <label htmlFor={`video-by-${item.id}`} className="dish-video-label">Who explains it (optional)</label>
    <input id={`video-by-${item.id}`} maxLength={60} value={by} onChange={e => setBy(e.target.value)} onBlur={() => void saveBy()} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void saveBy(); } }} placeholder="Chef Kenji" />
  </div>;
}
