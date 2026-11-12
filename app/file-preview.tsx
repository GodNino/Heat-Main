"use client";
// Seeing a Word or Excel file inside HEAT (074 files), without sending it anywhere else: the browser
// downloads it through its short-lived link and draws it here. Word with docx-preview (headings, lists,
// bold, tables); Excel as a table per sheet, read with JSZip (values as saved, formulas show their result).
// Older .doc and .xls files can't be drawn; they keep the Download button.
import { useEffect, useRef, useState } from "react";

const MAX_ROWS = 500, MAX_COLS = 40;

export function DocxPreview({url}: {url: string}) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let live = true;
    setState("loading");
    void (async () => {
      try {
        const [{renderAsync}, blob] = await Promise.all([import("docx-preview"), fetch(url).then(r => { if (!r.ok) throw new Error(); return r.blob(); })]);
        if (!live || !box.current) return;
        box.current.innerHTML = "";
        await renderAsync(blob, box.current, box.current, {inWrapper: true, ignoreWidth: false, ignoreHeight: true, breakPages: true, experimental: false, useBase64URL: true});
        if (live) setState("ready");
      } catch { if (live) setState("failed"); }
    })();
    return () => { live = false; };
  }, [url]);
  return <div className="file-view">
    {state === "loading" && <p className="muted p-5" role="status">Opening the document…</p>}
    {state === "failed" && <p className="muted p-5">This document couldn't be shown here. Tap Download to open it.</p>}
    <div ref={box} className="file-view-docx" hidden={state === "failed"} />
  </div>;
}

type Sheet = {name: string; rows: string[][]};
const colName = (i: number) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const colIndex = (ref: string) => { const letters = ref.replace(/[0-9]/g, ""); let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const textOf = (el: Element | null) => el ? [...el.getElementsByTagName("t")].map(t => t.textContent ?? "").join("") : "";

async function readWorkbook(buf: ArrayBuffer): Promise<Sheet[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const xml = async (path: string) => { const f = zip.file(path); return f ? new DOMParser().parseFromString(await f.async("string"), "application/xml") : null; };
  const [book, rels, shared] = await Promise.all([xml("xl/workbook.xml"), xml("xl/_rels/workbook.xml.rels"), xml("xl/sharedStrings.xml")]);
  const strings = shared ? [...shared.getElementsByTagName("si")].map(si => textOf(si)) : [];
  const targets = new Map<string, string>();
  if (rels) for (const r of [...rels.getElementsByTagName("Relationship")]) targets.set(r.getAttribute("Id") ?? "", (r.getAttribute("Target") ?? "").replace(/^\/?(xl\/)?/, "xl/"));
  const sheets: Sheet[] = [];
  for (const s of book ? [...book.getElementsByTagName("sheet")] : []) {
    const rid = s.getAttribute("r:id") ?? [...s.attributes].find(a => a.name.endsWith(":id"))?.value ?? "";
    const doc = await xml(targets.get(rid) ?? "");
    if (!doc) continue;
    const rows: string[][] = [];
    for (const row of [...doc.getElementsByTagName("row")].slice(0, MAX_ROWS)) {
      const r = Number(row.getAttribute("r") ?? rows.length + 1) - 1;
      const cells: string[] = [];
      for (const c of [...row.getElementsByTagName("c")]) {
        const col = colIndex(c.getAttribute("r") ?? "A1");
        if (col >= MAX_COLS) continue;
        const type = c.getAttribute("t"), v = c.getElementsByTagName("v")[0]?.textContent ?? "";
        cells[col] = type === "s" ? strings[Number(v)] ?? "" : type === "inlineStr" ? textOf(c.getElementsByTagName("is")[0] ?? null) : type === "b" ? (v === "1" ? "TRUE" : "FALSE") : v;
      }
      rows[r] = Array.from(cells, x => x ?? "");
    }
    sheets.push({name: s.getAttribute("name") ?? `Sheet ${sheets.length + 1}`, rows: Array.from(rows, x => x ?? [])});
  }
  return sheets;
}

export function XlsxPreview({url}: {url: string}) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState(0);
  useEffect(() => {
    let live = true;
    setSheets(null); setFailed(false); setTab(0);
    void fetch(url).then(r => { if (!r.ok) throw new Error(); return r.arrayBuffer(); }).then(readWorkbook)
      .then(s => { if (live) setSheets(s); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [url]);
  if (failed) return <p className="muted p-5">This spreadsheet couldn't be shown here. Tap Download to open it.</p>;
  if (!sheets) return <p className="muted p-5" role="status">Opening the spreadsheet…</p>;
  if (!sheets.length) return <p className="muted p-5">This spreadsheet is empty.</p>;
  const sheet = sheets[Math.min(tab, sheets.length - 1)];
  const width = Math.max(1, ...sheet.rows.map(r => r.length));
  return <div className="file-view">
    {sheets.length > 1 && <div className="file-view-tabs" role="group" aria-label="Sheets">{sheets.map((s, i) => <button key={s.name + i} type="button" aria-pressed={i === tab} onClick={() => setTab(i)}>{s.name}</button>)}</div>}
    <div className="file-view-table" tabIndex={0} aria-label={sheet.name}>
      <table>
        <thead><tr><th aria-hidden="true" />{Array.from({length: width}, (_, i) => <th key={i}>{colName(i)}</th>)}</tr></thead>
        <tbody>{sheet.rows.map((row, r) => <tr key={r}><th>{r + 1}</th>{Array.from({length: width}, (_, c) => <td key={c}>{row[c] ?? ""}</td>)}</tr>)}</tbody>
      </table>
    </div>
    {sheet.rows.length >= MAX_ROWS && <p className="muted text-sm px-4 pb-3">Showing the first {MAX_ROWS} rows. Download to see everything.</p>}
  </div>;
}
