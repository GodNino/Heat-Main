"use client";
// Restaurant files (074; mockup "Archivos del restaurante"). Managers keep the restaurant's PDFs,
// Word and Excel files and photos in folders, and find them by name or by any word inside. By default
// only managers see them; a folder can be shared with Bar, Kitchen, Front of house or everyone, and a
// single file can be shared on its own. The team sees only what is shared with them, read only.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FolderPlus, Search, Star, Upload, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { checkFile, FILE_TYPES, snippetParts } from "@/lib/file-types";
import { Field, Notice, ScreenHeader } from "./ui";
import { currentLang } from "./language";
import { DocxPreview, XlsxPreview } from "./file-preview";

type Share = "bar" | "boh" | "foh" | "all";
type Folder = {id: string; name: string; share: Share[]};
type FileRow = {id: string; folder_id: string; name: string; path: string; mime: string; size_bytes: number; share: Share[] | null; uploaded_by: string; created_at: string; updated_at: string; content_len?: number};
type Hit = {id: string; name: string; folder_id: string; snippet: string};
const SHARES: {key: Share; label: string; who: string}[] = [
  {key: "bar", label: "Bar", who: "Bartenders and barbacks"},
  {key: "boh", label: "Kitchen", who: "Everyone in the kitchen"},
  {key: "foh", label: "Front of house", who: "Servers, S.A.s, hosts, runners, bar"},
  {key: "all", label: "Everyone", who: "The whole team"},
];
const DEFAULT_FOLDERS = {en: ["Bar recipes", "Kitchen recipes", "Manuals and training", "Vendors", "Events", "Contracts and permits"], es: ["Recetas de bar", "Recetas de cocina", "Manuales y entrenamiento", "Proveedores", "Eventos", "Contratos y permisos"]};
const COLUMNS = "id, folder_id, name, path, mime, size_bytes, share, uploaded_by, created_at, updated_at";
const shareLabel = (list: Share[]) => list.length ? list.map(k => SHARES.find(s => s.key === k)!.label).join(" · ") : "Managers only";
const sizeLabel = (b: number) => b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const when = (at: string) => new Date(at).toLocaleDateString("en-US", {month: "short", day: "numeric"});
const extOf = (mime: string) => FILE_TYPES[mime]?.ext ?? "bin";

function TypeTag({mime}: {mime: string}) {
  const label = FILE_TYPES[mime]?.label ?? "FILE";
  return <span className={`files-type ${label.toLowerCase()}`} aria-hidden="true">{label}</span>;
}

export function Files({restaurantId, userId, isManager}: {restaurantId: string; userId: string; isManager: boolean}) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [stars, setStars] = useState<Set<string>>(new Set());
  const [people, setPeople] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [uploading, setUploading] = useState(false);
  const [sharing, setSharing] = useState<{kind: "folder" | "file"; id: string; picked: Share[]; inherit: boolean} | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!supabase) return;
    const [f, r, s, t] = await Promise.all([
      supabase.from("file_folders").select("id, name, share").eq("restaurant_id", restaurantId).order("name"),
      supabase.from("restaurant_files").select(COLUMNS).eq("restaurant_id", restaurantId).order("updated_at", {ascending: false}).limit(500),
      supabase.from("file_stars").select("file_id"),
      supabase.rpc("schedule_team", {rid: restaurantId}),
    ]);
    if (f.error) { setError(/relation|does not exist|schema cache/i.test(f.error.message) ? "Files aren't set up yet. Run migration 074." : "Couldn't load files. Check your connection and try again."); setFolders([]); return; }
    let list = (f.data ?? []) as Folder[];
    // A manager's first visit starts with the usual folders.
    if (isManager && !list.length) {
      const names = DEFAULT_FOLDERS[currentLang() === "es" ? "es" : "en"];
      const made = await supabase.from("file_folders").insert(names.map(name => ({restaurant_id: restaurantId, name}))).select("id, name, share");
      if (!made.error) list = ((made.data ?? []) as Folder[]).sort((a, b) => a.name.localeCompare(b.name));
    }
    setFolders(list);
    setFiles((r.data ?? []) as FileRow[]);
    setStars(new Set(((s.data ?? []) as {file_id: string}[]).map(x => x.file_id)));
    setPeople(Object.fromEntries(((t.data ?? []) as {user_id: string; name: string}[]).map(p => [p.user_id, p.name])));
  }, [restaurantId, isManager]);
  useEffect(() => { void load(); }, [load]);

  // Search names and the text inside, a moment after typing stops.
  useEffect(() => {
    const q = query.trim();
    if (!q || !supabase) { setHits(null); return; }
    const id = window.setTimeout(() => {
      void supabase!.rpc("search_files", {rid: restaurantId, q}).then(({data, error: failed}) => {
        if (failed) { setHits([]); return; }
        const inside = (data ?? []) as Hit[];
        // Names that match part of a word too (the search above matches word starts).
        const byName = files.filter(f => f.name.toLowerCase().includes(q.toLowerCase()) && !inside.some(h => h.id === f.id)).map(f => ({id: f.id, name: f.name, folder_id: f.folder_id, snippet: ""}));
        setHits([...inside, ...byName]);
      });
    }, 250);
    return () => window.clearTimeout(id);
  }, [query, restaurantId, files]);

  const file = files.find(f => f.id === openFile) ?? null;
  // The file opens through a link that works for an hour.
  useEffect(() => {
    setLink(""); setConfirmDelete(false);
    if (!file || !supabase) return;
    void supabase.storage.from("restaurant-files").createSignedUrl(file.path, 3600).then(({data}) => setLink(data?.signedUrl ?? ""));
  }, [file?.id, file?.path]);

  const folderName = useCallback((id: string) => folders?.find(f => f.id === id)?.name ?? "", [folders]);
  const shareOf = useCallback((f: FileRow) => f.share ?? folders?.find(d => d.id === f.folder_id)?.share ?? [], [folders]);
  const starred = useMemo(() => files.filter(f => stars.has(f.id)), [files, stars]);

  async function toggleStar(f: FileRow) {
    if (!supabase) return;
    const on = stars.has(f.id);
    const next = new Set(stars); if (on) next.delete(f.id); else next.add(f.id); setStars(next);
    const r = on ? await supabase.from("file_stars").delete().eq("file_id", f.id).eq("user_id", userId) : await supabase.from("file_stars").insert({file_id: f.id});
    if (r.error) { setStars(stars); setError("Couldn't change the star. Try again."); }
  }
  async function saveShare() {
    if (!supabase || !sharing) return;
    setBusy(true); setError("");
    const r = sharing.kind === "folder"
      ? await supabase.from("file_folders").update({share: sharing.picked}).eq("id", sharing.id)
      : await supabase.from("restaurant_files").update({share: sharing.inherit ? null : sharing.picked}).eq("id", sharing.id);
    setBusy(false);
    if (r.error) return setError(r.error.message);
    setMessage(sharing.kind === "folder" ? `Folder shared with ${shareLabel(sharing.picked).toLowerCase()}.` : sharing.inherit ? "This file now follows its folder." : `File shared with ${shareLabel(sharing.picked).toLowerCase()}.`);
    setSharing(null); await load();
  }
  async function addFolder() {
    const name = (newFolder ?? "").trim();
    if (!supabase || !name) return;
    const r = await supabase.from("file_folders").insert({restaurant_id: restaurantId, name}).select("id").maybeSingle();
    if (r.error) return setError(r.error.code === "23505" ? "There's already a folder with that name." : r.error.message);
    setNewFolder(null); setMessage("Folder created."); await load();
  }
  async function move(f: FileRow, folderId: string) {
    const r = await supabase!.from("restaurant_files").update({folder_id: folderId}).eq("id", f.id);
    if (r.error) return setError(r.error.message);
    setMessage(`Moved to ${folderName(folderId)}.`); await load();
  }
  async function remove(f: FileRow) {
    setBusy(true);
    const r = await supabase!.from("restaurant_files").delete().eq("id", f.id);
    if (!r.error) await supabase!.storage.from("restaurant-files").remove([f.path]);
    setBusy(false);
    if (r.error) return setError(r.error.message);
    setOpenFile(null); setMessage("File deleted."); await load();
  }
  async function readText(id: string) {
    const {data: session} = await supabase!.auth.getSession();
    return fetch("/api/files/text", {method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${session.session?.access_token ?? ""}`}, body: JSON.stringify({file: id})})
      .then(r => r.json()).catch(() => null) as Promise<{read?: boolean} | null>;
  }
  async function replace(f: FileRow, chosen: File | undefined) {
    if (!chosen || !supabase) return;
    const problem = checkFile(chosen); if (problem) return setError(problem);
    setBusy(true); setError("");
    const path = `${restaurantId}/${crypto.randomUUID()}.${extOf(chosen.type)}`;
    const up = await supabase.storage.from("restaurant-files").upload(path, chosen, {contentType: chosen.type});
    if (up.error) { setBusy(false); return setError("The file didn't upload. Check your connection and try again."); }
    const r = await supabase.from("restaurant_files").update({path, mime: chosen.type, size_bytes: chosen.size, content: "", pages: null}).eq("id", f.id);
    if (r.error) { await supabase.storage.from("restaurant-files").remove([path]); setBusy(false); return setError(r.error.message); }
    await supabase.storage.from("restaurant-files").remove([f.path]);
    await readText(f.id);
    setBusy(false); setMessage("Replaced with the new version."); await load();
  }

  if (!folders) return <section className="mx-auto max-w-3xl"><p className="muted" role="status">Loading…</p></section>;

  const row = (f: FileRow, snippet = "") => <div key={f.id} className="files-row">
    <button type="button" className="files-row-main" onClick={() => { setOpenFile(f.id); setError(""); setMessage(""); }}>
      <TypeTag mime={f.mime} />
      <span className="files-row-text"><b>{f.name}</b><small>{folderName(f.folder_id)} · {people[f.uploaded_by] ?? "Manager"} · {when(f.updated_at)}</small>
        {snippet && <span className="files-hit">{snippetParts(snippet).map((p, i) => p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</span>}
        {isManager && <span className={`files-share${shareOf(f).length ? " on" : ""}`}>{shareLabel(shareOf(f))}{f.share ? "" : ""}</span>}</span>
    </button>
    <button type="button" className="files-star" aria-label={stars.has(f.id) ? "Remove star" : "Star"} aria-pressed={stars.has(f.id)} onClick={() => void toggleStar(f)}><Star size={18} fill={stars.has(f.id) ? "currentColor" : "none"} /></button>
  </div>;

  const shareSheet = sharing && <div className="files-sheet" role="dialog" aria-label="Share">
    <div className="files-sheet-head"><b>{sharing.kind === "folder" ? "Share the folder" : "Share the file"}</b><button type="button" className="files-close" aria-label="Close" onClick={() => setSharing(null)}><X size={18} /></button></div>
    <p className="muted text-sm">{sharing.kind === "folder" ? "Everything in the folder, now and what's uploaded later. Managers always see it." : "Only this file, without opening the whole folder. Managers always see it."}</p>
    <div className="files-options">
      {sharing.kind === "file" && <button type="button" className="files-option" role="checkbox" aria-checked={sharing.inherit} onClick={() => setSharing({...sharing, inherit: true})}><span><b>Like its folder</b><small>{shareLabel(folders.find(d => d.id === files.find(x => x.id === sharing.id)?.folder_id)?.share ?? [])}</small></span><span className="files-tick">{sharing.inherit ? "✓" : ""}</span></button>}
      <button type="button" className="files-option" role="checkbox" aria-checked={!sharing.inherit && !sharing.picked.length} onClick={() => setSharing({...sharing, inherit: false, picked: []})}><span><b>Managers only</b><small>Nobody else</small></span><span className="files-tick">{!sharing.inherit && !sharing.picked.length ? "✓" : ""}</span></button>
      {SHARES.map(s => { const on = !sharing.inherit && sharing.picked.includes(s.key); return <button key={s.key} type="button" className="files-option" role="checkbox" aria-checked={on}
        onClick={() => setSharing({...sharing, inherit: false, picked: on ? sharing.picked.filter(k => k !== s.key) : [...sharing.picked, s.key]})}><span><b>{s.label}</b><small>{s.who}</small></span><span className="files-tick">{on ? "✓" : ""}</span></button>; })}
    </div>
    <div className="files-actions"><button type="button" className="btn" disabled={busy} onClick={() => void saveShare()}>Save</button><button type="button" className="btn secondary" onClick={() => setSharing(null)}>Cancel</button></div>
  </div>;

  // ── One file ──
  if (file) {
    const isPdf = file.mime === "application/pdf", isImage = file.mime.startsWith("image/");
    return <section className="mx-auto max-w-3xl files">
      <button type="button" className="btn secondary files-start" onClick={() => setOpenFile(null)}>Back</button>
      <ScreenHeader eyebrow={folderName(file.folder_id)} title={file.name} />
      <Notice text={error} error /><Notice text={message} />
      <div className="panel files-preview">
        {!link ? <p className="muted p-5" role="status">Loading…</p>
          : isPdf ? <iframe src={link} title={file.name} className="files-frame" />
          : isImage ? <img src={link} alt={file.name} className="files-image" />
          : file.mime.includes("wordprocessingml") ? <DocxPreview url={link} />
          : file.mime.includes("spreadsheetml") ? <XlsxPreview url={link} />
          : <p className="muted p-5">This older Word or Excel format can't be shown here. Tap Download to open it.</p>}
        <dl className="files-meta">
          <div><dt>Uploaded by</dt><dd>{people[file.uploaded_by] ?? "Manager"} · {when(file.created_at)}</dd></div>
          {isManager && <div><dt>Who sees it</dt><dd>{shareLabel(shareOf(file))}{shareOf(file).length ? " · and managers" : ""}{file.share ? "" : " (as the folder)"}</dd></div>}
          <div><dt>Size</dt><dd>{sizeLabel(file.size_bytes)}</dd></div>
        </dl>
      </div>
      <div className="files-actions">
        {link && <a className="btn secondary" href={link} target="_blank" rel="noopener" download={file.name}><Download size={14} />Download</a>}
        {isManager && <>
          <button type="button" className="btn secondary" onClick={() => setSharing({kind: "file", id: file.id, picked: file.share ?? [], inherit: file.share === null})}>Share</button>
          <label className={`btn secondary${busy ? " disabled" : ""}`}><input type="file" hidden accept={Object.keys(FILE_TYPES).join(",")} onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; void replace(file, f); }} />Replace</label>
          <select aria-label="Move to folder" className="files-move" value={file.folder_id} onChange={e => void move(file, e.target.value)}>{folders.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          {!confirmDelete ? <button type="button" className="btn secondary" onClick={() => setConfirmDelete(true)}>Delete</button>
            : <span className="files-confirm">Delete for everyone? <button type="button" className="btn secondary" onClick={() => setConfirmDelete(false)}>Keep it</button><button type="button" className="btn secondary" disabled={busy} onClick={() => void remove(file)}>Delete</button></span>}
        </>}
      </div>
      {shareSheet}
    </section>;
  }

  // ── Upload ──
  if (uploading) return <UploadFile restaurantId={restaurantId} folders={folders} start={openFolder} readText={readText}
    onDone={async (name, folderId) => { setUploading(false); setMessage(`${name} uploaded to ${folderName(folderId)}.`); await load(); }} onCancel={() => setUploading(false)} />;

  const folder = folders.find(f => f.id === openFolder) ?? null;
  const search = <label className="files-search"><Search size={18} aria-hidden="true" /><input id="files-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search names and inside the files" aria-label="Search files" /></label>;

  // ── A folder ──
  if (folder) {
    const inside = files.filter(f => f.folder_id === folder.id);
    return <section className="mx-auto max-w-3xl files">
      <button type="button" className="btn secondary files-start" onClick={() => setOpenFolder(null)}>Back</button>
      <ScreenHeader eyebrow="Files" title={folder.name} action={isManager ? <div className="files-actions"><button type="button" className="btn secondary" onClick={() => setSharing({kind: "folder", id: folder.id, picked: folder.share, inherit: false})}>Share</button><button type="button" className="btn" onClick={() => setUploading(true)}><Upload size={14} />Upload</button></div> : undefined} />
      <Notice text={error} error /><Notice text={message} />
      {isManager && <p className="muted text-sm">{folder.share.length ? `Shared with ${shareLabel(folder.share)}. Managers always see it.` : "Only managers see this folder."}</p>}
      {inside.length ? <div className="files-list">{inside.map(f => row(f))}</div> : <p className="muted">{isManager ? "No files here yet. Tap Upload." : "Nothing here yet."}</p>}
      {shareSheet}
    </section>;
  }

  // ── Home ──
  return <section className="mx-auto max-w-3xl files">
    <ScreenHeader eyebrow={isManager ? "Managers" : "Shared with you"} title="Files"
      info={isManager ? "The restaurant's documents in one place. Only managers see them until you share a folder or a file." : "What your managers shared with you."}
      action={isManager ? <button type="button" className="btn" onClick={() => setUploading(true)}><Upload size={14} />Upload</button> : undefined} />
    <Notice text={error} error /><Notice text={message} />
    {search}
    {hits ? <>
      <p className="muted text-sm">{hits.length ? `${hits.length} ${hits.length === 1 ? "file" : "files"} with “${query.trim()}”` : `Nothing with “${query.trim()}”.`}</p>
      {hits.length > 0 && <div className="files-list">{hits.map(h => { const f = files.find(x => x.id === h.id); return f ? row(f, h.snippet) : null; })}</div>}
    </> : <>
      {starred.length > 0 && <><p className="section-chip">Starred</p><div className="files-list">{starred.map(f => row(f))}</div></>}
      <div className="files-folders-head"><p className="section-chip">Folders</p>{isManager && <button type="button" className="btn secondary" onClick={() => setNewFolder("")}><FolderPlus size={14} />New folder</button>}</div>
      {newFolder !== null && <div className="files-new"><Field label="Folder name"><input id="files-new-folder" maxLength={60} value={newFolder} onChange={e => setNewFolder(e.target.value)} placeholder="Specials 2027" /></Field>
        <div className="files-actions"><button type="button" className="btn secondary" disabled={!newFolder.trim()} onClick={() => void addFolder()}>Create</button><button type="button" className="btn secondary" onClick={() => setNewFolder(null)}>Cancel</button></div></div>}
      {folders.length ? <div className="files-folders">{folders.map(d => { const count = files.filter(f => f.folder_id === d.id).length; return <button key={d.id} type="button" className="files-folder" onClick={() => setOpenFolder(d.id)}>
        <b>{d.name}</b><small>{count} {count === 1 ? "file" : "files"}</small>{isManager && <span className={`files-share${d.share.length ? " on" : ""}`}>{shareLabel(d.share)}</span>}</button>; })}</div>
        : <p className="muted">{isManager ? "No folders yet." : "Nothing has been shared with you yet."}</p>}
      {files.length > 0 && <><p className="section-chip">Recent</p><div className="files-list">{files.slice(0, 5).map(f => row(f))}</div></>}
    </>}
  </section>;
}

function UploadFile({restaurantId, folders, start, readText, onDone, onCancel}: {restaurantId: string; folders: Folder[]; start: string | null; readText: (id: string) => Promise<{read?: boolean} | null>; onDone: (name: string, folderId: string) => void; onCancel: () => void}) {
  const [chosen, setChosen] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [folderId, setFolderId] = useState(start ?? folders[0]?.id ?? "");
  const [step, setStep] = useState<"" | "uploading" | "reading">("");
  const [error, setError] = useState("");
  async function send() {
    if (!supabase || !chosen || !folderId) return;
    const problem = checkFile(chosen); if (problem) return setError(problem);
    setError(""); setStep("uploading");
    const path = `${restaurantId}/${crypto.randomUUID()}.${extOf(chosen.type)}`;
    const up = await supabase.storage.from("restaurant-files").upload(path, chosen, {contentType: chosen.type});
    if (up.error) { setStep(""); return setError("The file didn't upload. Check your connection and try again."); }
    const title = name.trim() || chosen.name;
    const made = await supabase.from("restaurant_files").insert({restaurant_id: restaurantId, folder_id: folderId, name: title.slice(0, 120), path, mime: chosen.type, size_bytes: chosen.size}).select("id").maybeSingle();
    const id = (made.data as {id?: string} | null)?.id;
    if (made.error || !id) { await supabase.storage.from("restaurant-files").remove([path]); setStep(""); return setError(made.error?.message ?? "The file couldn't be saved."); }
    setStep("reading");
    await readText(id);
    onDone(title, folderId);
  }
  const folder = folders.find(f => f.id === folderId);
  return <section className="mx-auto max-w-3xl files">
    <button type="button" className="btn secondary files-start" onClick={onCancel}>Back</button>
    <ScreenHeader eyebrow="Files" title="Upload a file" />
    <Notice text={error} error />
    <div className="panel files-upload">
      <label className="files-pick">
        <input type="file" hidden accept={Object.keys(FILE_TYPES).join(",")} onChange={e => { const f = e.target.files?.[0] ?? null; setError(""); if (f) { const p = checkFile(f); if (p) { setError(p); return; } setName(f.name.replace(/\.[^.]+$/, "")); } setChosen(f); }} />
        {chosen ? <><TypeTag mime={chosen.type} /><span><b>{chosen.name}</b><small>{sizeLabel(chosen.size)}</small></span></> : <><Upload size={20} aria-hidden="true" /><span><b>Choose a file</b><small>PDF, Word, Excel or a photo · up to 25 MB</small></span></>}
      </label>
      <Field label="Name"><input id="files-name" maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Christmas specials 2026" /></Field>
      <div className="field"><p className="files-label">Folder</p><div className="files-chips" role="group" aria-label="Folder">{folders.map(f => <button key={f.id} type="button" aria-pressed={f.id === folderId} onClick={() => setFolderId(f.id)}>{f.name}</button>)}</div></div>
      <p className="muted text-sm">Who sees it: {shareLabel(folder?.share ?? [])}{folder?.share.length ? " and managers" : ""}, like the folder. You can share this file on its own after uploading. HEAT reads the text so it can be found by search.</p>
      <button type="button" className="btn files-start" disabled={!chosen || !folderId || !!step} onClick={() => void send()}>{step === "uploading" ? "Uploading…" : step === "reading" ? "Reading the text…" : "Upload"}</button>
    </div>
  </section>;
}
