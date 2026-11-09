# Team invitations and hourly status email

## Unstop team onboarding

A committed Unstop import with a `team_lead_email` creates one shared 12-character team code and a pending lead-only invitation. The code is valid for seven days and can be used once per imported member email. D1 stores a SHA-256 code hash and a random per-team nonce; the code is deterministically derived with HMAC-SHA-256 under `ORG_VAULT_KEY`, and is never stored in plaintext. A scheduled dispatcher sends pending invitations only when `TEAM_EMAIL_SENDER` is bound. Without the binding, invitations remain pending. Invitation attempt logs contain only status and safe error codes.

The unauthenticated same-origin endpoint `POST /api/organization/participant/verify` accepts an imported email and code. Successful verification creates an authenticated, team-scoped participant identity linked to the imported team member and GitHub ID. Inactive teams or members cannot authenticate, and each imported email can use the code once.

SpaceMail is not configured in this checkout, so invitation dispatch remains dormant. When configured later, use the provider-neutral `TEAM_EMAIL_SENDER` binding and deploy a separate sender Worker. That sender Worker alone must read SpaceMail SMTP host, username, password, and TLS settings from its Cloudflare secrets; never put SMTP credentials in Doomforge vars, D1, or source. The sender must durably accept and deduplicate the stable invitation idempotency key before returning success.

## Hourly team status email

Hourly email is disabled by default. Dispatch requires an active event, an
organizer opt-in, an imported team lead email, and the optional
`TEAM_EMAIL_SENDER` service binding. Each eligible team gets one consolidated
message per UTC hour, addressed only to its imported `lead_email`; member
emails are not used for the hourly schedule.

The organizer settings API is
`/api/organization/manage/team-email`. GET reports the current enablement,
event state, sender-binding state, configured subject/body, and recent
delivery attempts. POST can enable or pause delivery and edit the subject or
body. Templates support only `{{team_name}}`, `{{assigned_track}}`, and
`{{dashboard_link}}`. The organizer API returns recent delivery status and
safe error summaries. The scheduler adds the team's mapped open Matrix PR
numbers and latest run states; it never includes scores, category marks, or
another team's data. PR details are bounded to the 20 most recent entries and
the message is capped at 12,000 characters.

## Configure SpaceMail later

The Round 2 specification uses the existing SpaceMail SMTP service, but this
checkout does not contain SpaceMail credentials or a configured SMTP sender.
No message can be sent until the owner provisions SpaceMail and configures the
sender relay. When those are available:

1. Configure the SpaceMail SMTP account and verified sender address. Keep the
   SMTP host, username, password, and TLS settings out of Doomforge source,
   Wrangler vars, and D1.
2. Deploy a separate sender Worker that reads the SpaceMail SMTP configuration
   from its own secret bindings and implements `POST /send`.
3. The sender request is JSON with `idempotencyKey`, `to`, `subject`, and
   plain-text `body`. Return success only after the sender has durably accepted
   the email. Persist the key in the sender service so retries after a sender
   acceptance or worker restart cannot produce a duplicate.
4. Bind that Worker to Doomforge as `TEAM_EMAIL_SENDER` in the appropriate
   Cloudflare environment. No provider-specific package or credential is
   required in the Doomforge Worker.
5. Apply migrations `0038_team_email.sql`, `0039_team_lead_email.sql`, and
   `0040_team_onboarding.sql` to the isolated organization database (`ORG_DB`),
   not the ordinary judging database. The Unstop CSV must include `team_lead_email`; conflicting lead
   addresses within a team are rejected.
6. Test against a synthetic recipient and confirm that the same team/hour
   retries use the same key. Verify both successful delivery and a safe
   recorded failure before enabling live team mail.
7. Authenticate as an organizer, edit the subject/body with the supported
   placeholders, and explicitly enable email. The API refuses enablement
   until `TEAM_EMAIL_SENDER` exists.

Invitation dispatch uses a stable team ID idempotency key and stops after five logged attempts. Codes expire seven days after import; no invitation renewal endpoint is provided, so arrange sender configuration before importing teams. The hourly status email idempotency key is the UTC hour plus team ID. Doomforge atomically claims
the delivery before calling the sender, keeps attempts and safe error codes,
and retries failed or expired claims with the original key for up to five
attempts within the 24-hour recovery window. Each scheduler invocation sends
at most 100 messages, with a bounded batch and backoff for retries. A team
with no imported lead email is not eligible.

## Pause or roll back

An organizer can pause future dispatch with POST
`{"enabled":false}` to `/api/organization/manage/team-email`. Removing the
`TEAM_EMAIL_SENDER` binding also stops dispatch. A send already accepted by
the external sender may finish while a pause is being applied; the scheduler
rechecks event, team, lead, and enablement before each later send.

Preserve the delivery table during rollback so retries retain their keys.
Keep the migrations applied; disabling email does not require a destructive
schema rollback. After pausing, remove the sender binding and confirm GET
reports delivery disabled and no sender configured.
