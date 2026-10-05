# Outreach CRM

Cold email to US shippers with disciplined follow-ups, built so that volume never costs sender reputation.
This is Phase 1 of the roadmap: the sending system.

## What it does

- **Leads:** CSV import with column auto-mapping, de-duplication by email and company domain, and automatic skipping of shared
  mailboxes (info@, sales@), disposable domains, and anyone who ever opted out or bounced. Extra columns (commodity, port, HS code...)
  become `{{fields}}` for personalisation.
- **Verification:** free checks first (syntax, role address, disposable domain, MX records), then MillionVerifier or ZeroBounce.
  First emails only go to addresses verified within 30 days. Catch-all addresses are capped at 10% of a day's sends.
- **Inboxes:** Gmail or Google Workspace connected through OAuth (no passwords stored, refresh tokens encrypted).
  Each inbox has a warm-up ramp (10 a day on its cold start date, plus 2 per business day, up to 40) and spaces its sends 4 to 30
  minutes apart with random jitter.
- **Sequences:** a first email with optional A/B subject, then follow-ups in the same Gmail thread after a set number of business days.
  Sends only Monday to Friday, 9:00 to 16:00 in each recipient's time zone (from their state), skipping US holidays.
  One first email per company per day.
- **Stops on any signal:** a reply (from the contact or anyone at their company domain) or an opt-out stops every sequence at that
  company. A hard bounce suppresses the address. An out-of-office reply holds the sequence 5 business days.
- **Compliance:** every email has the sender's signature, a plain opt-out line with an unsubscribe link, the postal address
  (CAN-SPAM), and `List-Unsubscribe` plus one-click `List-Unsubscribe-Post` headers (Gmail and Yahoo bulk sender rules).
  Unsubscribes are instant and global.
- **Safety switches:** nothing sends until sending is turned on and a postal address is set. An inbox pauses itself when more than 3%
  of its last 100 emails bounce, or when Gmail refuses to send. New and reconnected inboxes start paused.
- **Dashboard:** sent, bounce rate, reply rate and opt-outs per inbox and per sequence, plus the latest replies.

## Set up

1. Create a Supabase project and run `supabase/migrations/0001_init.sql` in its SQL editor.
2. Deploy to Vercel from this repository and set the variables in `.env.example`.
3. In Google Cloud (see the Phase 0 checklist), add `https://YOUR-APP/api/oauth/google/callback` as an authorised redirect URL.
4. Run `supabase/scheduler.sql` in Supabase with your URL, then add your `CRON_SECRET` in Supabase Vault as `cron_secret`, so the app checks inboxes and sends every 5 minutes.
5. Sign in, fill in Settings (company name and postal address), connect each inbox, set its sender name, signature and cold start
   date, then resume it. Import leads, create a sequence, edit its copy, activate it, enroll leads, and turn sending on.

A free @gmail.com account works for testing only if you add it as a test user on the OAuth consent screen. For real outreach, use
Google Workspace inboxes on dedicated outreach domains with SPF, DKIM and DMARC set up.

## Develop

```
npm install
cp .env.example .env.local   # fill in
npm run dev
npm test                     # engine, scheduling, compliance and parsing tests (no network)
npm run lint && npx tsc --noEmit
```

The sending engine (`src/lib/engine`) talks to the database through the `Store` interface, so the tests run it end to end against an
in-memory store and a fake Gmail.

## Not in Phase 1 yet

The import-data scraper and enrichment (Phase 2), the unified reply inbox and quote pipeline (Phase 3), and seed-test inbox placement
monitoring (Phase 4). Spam complaint rates come from Google Postmaster Tools, which the app does not read yet.
