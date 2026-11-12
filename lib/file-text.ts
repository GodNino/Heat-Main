// Reading the text out of a restaurant file (074) so search can find words inside it. Word (.docx) and
// Excel (.xlsx) are zip files of XML, read here with Node's own zlib; PDFs and photos go to Claude in
// the route (app/api/files/text). Pure functions, so the tests can feed them real files.
import { inflateRawSync } from "node:zlib";

// The same cap as lib/file-types.ts and the content column (074).
export const MAX_TEXT = 400_000;

// The entries of a zip file, by name. Enough of the format for Office files: stored or deflated.
export function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("Not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  for (let n = 0; n < count && at + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) files.set(name, raw);
    else if (method === 8) { try { files.set(name, inflateRawSync(raw)); } catch { /* a damaged entry is skipped */ } }
  }
  return files;
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
const tidy = (s: string) => s.split("\n").map(l => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n").slice(0, MAX_TEXT);

// Word: the paragraphs of the body (and of headers and footers), one per line.
export function docxText(buf: Buffer) {
  const zip = unzip(buf);
  const parts = [...zip.keys()].filter(n => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n)).sort((a, b) => (a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b)));
  return tidy(parts.map(p => zip.get(p)!.toString("utf8")
    .replace(/<w:tab\/>/g, " ").replace(/<w:br\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<\/w:tc>/g, " · ")
    .replace(/<[^>]+>/g, "")).map(decode).join("\n"));
}

// Excel: every sheet, one line per row, cells joined with " · ".
export function xlsxText(buf: Buffer) {
  const zip = unzip(buf);
  const shared = [...(zip.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")));
  const sheets = [...zip.keys()].filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const lines: string[] = [];
  for (const name of sheets) {
    const xml = zip.get(name)!.toString("utf8");
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(c => {
        const attrs = c[1], inner = c[2] ?? "";
        if (/t="s"/.test(attrs)) { const v = inner.match(/<v>([\s\S]*?)<\/v>/); return v ? shared[Number(v[1])] ?? "" : ""; }
        if (/t="inlineStr"/.test(attrs)) return decode([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(""));
        const v = inner.match(/<v>([\s\S]*?)<\/v>/); return v ? decode(v[1]) : "";
      }).filter(Boolean);
      if (cells.length) lines.push(cells.join(" · "));
    }
  }
  return tidy(lines.join("\n"));
}

