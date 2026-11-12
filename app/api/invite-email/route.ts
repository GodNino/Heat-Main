// Emails an invitation the manager just saved (071; save_email_invite). It acts as the manager: their
// sign-in token goes to Supabase, so the database decides whether they can read this invitation.
// One sender for every restaurant ("Osaka Miami vía HEAT <invites@heatplatform.io>"); replies go to
// the manager who invited. Sending uses Resend, like the shift report. Until RESEND_API_KEY is set,
// this answers {configured: false} and the screen offers the manager's own email app instead.
// INVITES_FROM can change the address; it must be on a domain verified in Resend.
import { createClient } from "@supabase/supabase-js";
import { inviteEmail, inviteSender } from "@/lib/invite-email";
import { claimRequest } from "@/lib/request-limit";

export async function POST(request: Request) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return Response.json({sent: false, configured: false});

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const {invite} = await request.json().catch(() => ({})) as {invite?: string};
  if (!url || !key || !token || !invite) return Response.json({error: "Missing invitation or sign-in."}, {status: 400});

  const db = createClient(url, key, {
    auth: {persistSession: false, autoRefreshToken: false},
    global: {headers: {Authorization: `Bearer ${token}`}},
  });
  const me = (await db.auth.getUser(token)).data.user;
  if (!me) return Response.json({error: "Please sign in again."}, {status: 401});
  const found = await db.from("email_invites").select("token, restaurant_id, email, name, role, lang, accepted_at, cancelled_at, expires_at").eq("token", invite).maybeSingle();
  const row = found.data as {token: string; restaurant_id: string; email: string; name: string; role: string; lang: "en" | "es"; accepted_at: string | null; cancelled_at: string | null; expires_at: string} | null;
  if (found.error || !row) return Response.json({error: "That invitation isn't available to you."}, {status: 403});
  if (row.accepted_at || row.cancelled_at || new Date(row.expires_at) <= new Date()) return Response.json({error: "That invitation is no longer open."}, {status: 409});
  // Never from a demo kitchen; the same person not twice in two minutes; a daily limit (071).
  if (!(await claimRequest(db, "invite_email", `${row.restaurant_id}:${row.email}`))) {
    return Response.json({sent: false, configured: true, error: "It was just sent. Wait a couple of minutes before sending it again."}, {status: 429});
  }

  const [place, profile] = await Promise.all([
    db.from("restaurants").select("name").eq("id", row.restaurant_id).maybeSingle(),
    db.from("member_profiles").select("display_name").eq("restaurant_id", row.restaurant_id).eq("user_id", me.id).maybeSingle(),
  ]);
  const restaurant = (place.data?.name as string | undefined) ?? "your restaurant";
  const inviter = ((profile.data?.display_name as string | undefined) || me.email?.split("@")[0] || "Your manager").slice(0, 60);
  const link = `${new URL(request.url).origin}/app?invite=${row.token}`;
  const mail = inviteEmail({restaurant, inviter, name: row.name, role: row.role, lang: row.lang, link});

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
    body: JSON.stringify({
      from: inviteSender(restaurant, row.lang, process.env.INVITES_FROM ?? "invites@heatplatform.io"),
      to: [row.email],
      reply_to: me.email ? [me.email] : undefined,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }),
  });
  if (!response.ok) return Response.json({sent: false, configured: true, error: "The email service didn't accept it. Try again in a minute, or copy the link instead."}, {status: 502});
  return Response.json({sent: true, configured: true});
}
