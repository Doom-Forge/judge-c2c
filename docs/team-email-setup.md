# Team invitations and hourly status email

## Unstop team onboarding

A committed Unstop import creates the team roster and lead email. A participant requests a one-time email sign-in code; it expires after ten minutes and D1 stores only its hash. The lead can sign in before choosing a repository, then must finalize exactly one of the four repositories and link a GitHub account before entering the dashboard. After those steps, the lead can reveal a shared team access key for rostered members. Members request their own email sign-in code using the key, then link their own GitHub accounts. The key is HMAC-derived under `ORG_VAULT_KEY`; D1 stores its hash and per-team nonce. Login and invitation logs keep only status and safe error codes.

The same-origin endpoints `POST /api/organization/participant/request-code` and `/verify` issue and consume the one-time email code. Team members also need the lead's access key. Authentication is scoped to the imported roster. GitHub identity is linked in a separate OAuth step and is required for dashboard access; imported CSV data is not treated as OAuth proof.

Email sign-in requires migration `0045_participant_email_login.sql` and the
`TEAM_EMAIL_SENDER` binding. With no sender password provisioned, sign-in codes
cannot currently be delivered; a team access key is not a substitute for email
verification.

The SpaceMail mailbox is SMTP-enabled and the private sender Worker has been deployed. Its password has not been provisioned, and the new `TEAM_EMAIL_SENDER` binding is present in configuration but has not been activated by a Doomforge deployment. Email dispatch remains unavailable until the password is provisioned and Doomforge is deployed with the binding.

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

SpaceMail SMTP is enabled for `technical@180dcvitc.org`. The private sender Worker is deployed; the SMTP password is not in this checkout. No message can be sent from Doomforge until the operator provisions the secret and the main Worker is deployed with its service binding. When those steps are approved:

1. Configure the SpaceMail SMTP account and verified sender address. Keep the
   SMTP host, username, password, and TLS settings out of Doomforge source,
   Wrangler vars, and D1.
2. Provision `SPACEMAIL_SMTP_PASSWORD` to the existing private sender Worker
   using the command in the sender section below.
3. The sender request is JSON with `idempotencyKey`, `to`, `subject`, and
   plain-text `body`. Return success only after the sender has durably accepted
   the email. Persist the key in the sender service so retries after a sender
   acceptance or worker restart cannot produce a duplicate.
4. The `TEAM_EMAIL_SENDER` binding is prepared in `wrangler.matrix.jsonc`.
   Deploy Doomforge only after the secret exists and the configuration is
   verified. No provider-specific package or credential is required in the
   Doomforge Worker.
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

## Private SpaceMail sender Worker

`wrangler.spacemail.jsonc` configures the deployed private Worker with no public route or Workers.dev hostname. It sends through implicit TLS to `mail.spacemail.com:465` as `technical@180dcvitc.org`. A `TEAM_EMAIL_SENDER` service binding is prepared in `wrangler.matrix.jsonc`; it is not active in the deployed Doomforge Worker until a later deployment.

Provision the password as a Worker secret on the existing sender Worker:

```sh
npx wrangler secret put SPACEMAIL_SMTP_PASSWORD --config wrangler.spacemail.jsonc
```

Wrangler prompts for the value. Do not place it in a command argument, shell history, `.env` file, source, or chat. The only credential the sender reads is `SPACEMAIL_SMTP_PASSWORD`; the account and from address are fixed in code.

The existing `/send` contract accepts JSON `{ idempotencyKey, to, subject, body }`. The sender hashes the key to select a Durable Object and stores only a hash of message content, a delivery state, and an attempt token. It does not persist email addresses, message text, or sign-in codes. The same key with changed content is rejected. SMTP waits are bounded to 30 seconds, request bodies to 20 KiB, and message text to 12,000 characters. Header injection is rejected. If SMTP acceptance is uncertain, the idempotency record becomes `UNKNOWN` and the sender will not automatically duplicate the message.

This change does not provision its SMTP password, deploy the Doomforge binding, or send email.
