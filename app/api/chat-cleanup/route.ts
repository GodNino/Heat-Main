// Team chat housekeeping (064), once a day from Vercel Cron (vercel.json): messages older than 30 days that
// aren't pinned are deleted, with their photo or voice note, and so are files whose message was deleted.
// The chat already hides those messages after 30 days; this frees the space.
//
// Runs with the server's own Supabase key, so only Vercel Cron may call it: Vercel sends
// "Authorization: Bearer <CRON_SECRET>". Needs CRON_SECRET and SUPABASE_SERVICE_ROLE_KEY in Vercel; until then it
// answers {configured: false} and nothing is deleted.
import { createClient } from "@supabase/supabase-js";

export async function GET(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const secret = process.env.CRON_SECRET;
  if (!url || !serviceKey || !secret) return Response.json({configured: false});
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({error: "Not allowed."}, {status: 401});

  const db = createClient(url, serviceKey, {auth: {persistSession: false, autoRefreshToken: false}});
  let messages = 0, files = 0;
  // A few rounds of up to 500, so a backlog clears over a few days without a long request.
  for (let round = 0; round < 5; round++) {
    const expired = await db.rpc("chat_expired", {max_rows: 500});
    if (expired.error) return Response.json({error: expired.error.message}, {status: 500});
    const rows = (expired.data ?? []) as {id: string; media_path: string | null}[];
    if (!rows.length) break;
    const paths = rows.map(r => r.media_path).filter((p): p is string => !!p);
    if (paths.length) { const gone = await db.storage.from("chat-media").remove(paths); if (!gone.error) files += paths.length; }
    const del = await db.from("chat_messages").delete().in("id", rows.map(r => r.id));
    if (del.error) return Response.json({error: del.error.message}, {status: 500});
    messages += rows.length;
  }
  const orphans = await db.rpc("chat_orphan_media", {max_rows: 500});
  const names = ((orphans.data ?? []) as {name: string}[]).map(o => o.name);
  if (names.length) { const gone = await db.storage.from("chat-media").remove(names); if (!gone.error) files += names.length; }
  return Response.json({messages, files});
}
