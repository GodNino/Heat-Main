// Reads the text out of a file a manager just uploaded (074), so search finds words inside it.
// It acts as the manager: their sign-in token reads the file row and downloads the file, so the
// database decides. Word and Excel are read here (lib/file-text.ts). PDFs and photos (a handwritten
// recipe) go to Claude to transcribe; until ANTHROPIC_API_KEY is set they're found by name only.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { docxText, xlsxText, MAX_TEXT } from "@/lib/file-text";

const MODEL = "claude-haiku-5-5";
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export async function POST(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const {file} = await request.json().catch(() => ({})) as {file?: string};
  if (!url || !key || !token || !file) return Response.json({error: "Missing file or sign-in."}, {status: 400});

  const db = createClient(url, key, {auth: {persistSession: false, autoRefreshToken: false}, global: {headers: {Authorization: `Bearer ${token}`}}});
  const found = await db.from("restaurant_files").select("id, restaurant_id, path, mime").eq("id", file).maybeSingle();
  const row = found.data as {id: string; restaurant_id: string; path: string; mime: string} | null;
  if (found.error || !row) return Response.json({error: "That file isn't available to you."}, {status: 403});
  const manager = await db.rpc("files_manager", {rid: row.restaurant_id});
  if (manager.data !== true) return Response.json({error: "Only managers can do this."}, {status: 403});

  const download = await db.storage.from("restaurant-files").download(row.path);
  if (download.error || !download.data) return Response.json({error: "The file couldn't be read."}, {status: 502});
  const buf = Buffer.from(await download.data.arrayBuffer());

  let text = "", pages: number | null = null;
  try {
    if (row.mime.includes("wordprocessingml")) text = docxText(buf);
    else if (row.mime.includes("spreadsheetml")) text = xlsxText(buf);
    else if (row.mime === "application/pdf" || (IMAGE_TYPES as readonly string[]).includes(row.mime)) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return Response.json({read: false, reason: "not_configured"});
      if (row.mime === "application/pdf") pages = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length || null;
      const data = buf.toString("base64");
      const source = row.mime === "application/pdf"
        ? {type: "document" as const, source: {type: "base64" as const, media_type: "application/pdf" as const, data}}
        : {type: "image" as const, source: {type: "base64" as const, media_type: row.mime as typeof IMAGE_TYPES[number], data}};
      const client = new Anthropic({apiKey});
      const reply = await client.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        messages: [{role: "user", content: [source, {type: "text", text: "Transcribe all the text in this restaurant file exactly as written, in its own language. Keep one line per line, and for tables one line per row with cells separated by \" · \". Include handwriting. Write only the text, with no comments."}]}],
      }).finalMessage();
      text = reply.content.map(part => part.type === "text" ? part.text : "").join("\n").trim().slice(0, MAX_TEXT);
    } else {
      return Response.json({read: false, reason: "type"});
    }
  } catch {
    return Response.json({read: false, reason: "failed"});
  }

  const saved = await db.from("restaurant_files").update({content: text, pages}).eq("id", row.id);
  if (saved.error) return Response.json({error: "The text couldn't be saved."}, {status: 500});
  return Response.json({read: true, chars: text.length});
}
