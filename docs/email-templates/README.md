# HEAT email templates for Supabase

Each file is the full email for one row in Supabase → Authentication → Emails → Templates. They use the
same look as the HEAT invitation email, with Spanish first and English below, because Supabase sends one
email to everyone and doesn't know each person's language.

How to use one: open the row in Supabase, paste the Subject, replace the whole Message body with the file's
contents, check Preview, then Save changes.

| Supabase row | File | Subject |
| --- | --- | --- |
| Confirm sign up | `confirm-signup.html` | Confirma tu correo en HEAT · Confirm your email on HEAT |
| Invite user | `invite-user.html` | Te invitaron a HEAT · You're invited to HEAT |
| Magic link or OTP | `magic-link.html` | Tu link para entrar a HEAT · Your HEAT sign-in link |
| Change email address | `change-email.html` | Confirma tu correo nuevo en HEAT · Confirm your new HEAT email |
| Reset password | `reset-password.html` | Cambia tu contraseña de HEAT · Reset your HEAT password |
| Reauthentication | `reauthentication.html` | Tu código de HEAT · Your HEAT code |

The emails say links last 1 hour, Supabase's default (Authentication → Providers → Email → Email OTP
Expiration). If that setting changes, change the text too.

HEAT's own team invitations don't use "Invite user": they go out through Resend (`lib/invite-email.ts`).
