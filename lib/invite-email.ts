// The invitation email (071; mockup "Invitaciones por correo"). Pure, so the route and the tests share
// it. One sender for every restaurant ("Osaka Miami vía HEAT <invites@heatplatform.io>"), with
// replies going to the manager who invited. Everything a manager typed is escaped before it goes
// into the HTML.
export type InviteEmail = {restaurant: string; inviter: string; name: string; role: string; lang: "en" | "es"; link: string};

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]!));
// A display name can't carry quotes, angle brackets or line breaks into the From header.
const headerSafe = (s: string) => s.replace(/[\r\n"<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

export function inviteSender(restaurant: string, lang: "en" | "es", address = "invites@heatplatform.io") {
  return `${headerSafe(restaurant) || "HEAT"} ${lang === "es" ? "vía" : "via"} HEAT <${address}>`;
}

export function inviteEmail(m: InviteEmail) {
  const es = m.lang === "es";
  const r = escape(m.restaurant), who = escape(m.inviter), role = escape(m.role), name = escape(m.name.trim());
  const T = es ? {
    subject: `${headerSafe(m.inviter)} te invitó a ${headerSafe(m.restaurant)} en HEAT`,
    hi: name ? `Hola, ${name}:` : "Hola:", title: `Te invitaron a unirte al equipo de ${r}`,
    body: "En HEAT vas a ver tus turnos, estudiar el menú con un tutor, recibir el pre-turno y hablar con tu equipo. Todo en tu teléfono.",
    cta: `Unirme a ${r}`, pos: "Posición", from: "Invitado por", exp: "Vence", expv: "en 7 días",
    alt: "Si el botón no funciona, copia este link en tu navegador:",
    foot: `Recibiste este correo porque un manager de ${r} te invitó a HEAT. Si no esperabas esta invitación, puedes ignorarlo.`,
  } : {
    subject: `${headerSafe(m.inviter)} invited you to ${headerSafe(m.restaurant)} on HEAT`,
    hi: name ? `Hi ${name},` : "Hi,", title: `You're invited to join the ${r} team`,
    body: "On HEAT you'll see your shifts, study the menu with a tutor, get the pre-shift and talk with your team. All on your phone.",
    cta: `Join ${r}`, pos: "Position", from: "Invited by", exp: "Expires", expv: "in 7 days",
    alt: "If the button doesn't work, paste this link in your browser:",
    foot: `You got this email because a manager at ${r} invited you to HEAT. If you weren't expecting it, you can ignore it.`,
  };
  const link = escape(m.link);
  const row = (k: string, v: string) => `<tr><td style="padding:10px 0;border-bottom:1px solid #e3e3dd;color:#62645D;font-size:14px">${k}</td><td style="padding:10px 0;border-bottom:1px solid #e3e3dd;text-align:right;font-size:14px;font-weight:700">${v}</td></tr>`;
  const html = `<!doctype html><html lang="${m.lang}"><body style="margin:0;background:#eeeee8;font-family:Helvetica,Arial,sans-serif;color:#1B1C1A">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e3e3dd">
<tr><td style="background:#141414;color:#f3f3f0;padding:20px;font-size:22px;font-weight:700">heat<span style="color:#C7F23A">.</span></td></tr>
<tr><td style="padding:24px 20px">
<p style="margin:0 0 16px;font-size:15px">${T.hi}</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.2">${T.title}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5">${T.body}</p>
<p style="margin:0 0 20px"><a href="${link}" style="display:inline-block;padding:12px 24px;border-radius:999px;background:#C7F23A;color:#1B1C1A;font-weight:700;font-size:15px;text-decoration:none;border:1px solid #1B1C1A">${T.cta}</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e3e3dd;margin-bottom:20px">${row(T.pos, role)}${row(T.from, who)}${row(T.exp, T.expv)}</table>
<p style="margin:0;font-size:12px;color:#62645D;word-break:break-all">${T.alt}<br>${link}</p>
</td></tr>
<tr><td style="padding:16px 20px;background:#f6f6f2;font-size:12px;color:#62645D;line-height:1.5">${T.foot}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [T.hi, "", T.title.replace(/&amp;/g, "&"), "", T.body, "", `${T.pos}: ${m.role}`, `${T.from}: ${m.inviter}`, `${T.exp}: ${T.expv}`, "", m.link, "", T.foot.replace(/&amp;/g, "&")].join("\n");
  return {subject: T.subject, html, text};
}
