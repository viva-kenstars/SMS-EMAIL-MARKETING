# Email marketing guide

## What is included

The private Trezad workspace now includes a visual email editor, full HTML source editing, a sandboxed desktop/mobile preview, six sample templates, saved campaign drafts, verified contact groups, multiple SMTP accounts, per-campaign account rotation, intervals, scheduled starts, test messages and persistent recipient reports.

The app stores SMTP passwords and the sending-service API token as authenticated encrypted values in D1 using the existing `SMS_SETTINGS_ENCRYPTION_KEY`. The browser receives configuration status, not saved secrets. Existing SMS, WhatsApp and Reoon verification records retain their original tables and settings.

## Connect the sending service

The private app's hosting runtime supports HTTPS requests but does not open generic SMTP connections. Deploy the included Node SMTP companion on a server with outbound SMTP access and HTTPS, then open **Email marketing → Sending setup**. The same service supplies public unsubscribe pages and an optional background queue runner.

The app includes a private **service setup** page and downloadable service package. Deployment details are in [SMTP service operations](smtp-relay.md). Provisioning an external host/domain and entering real account credentials remain installation steps; a successful app deployment alone does not prove live SMTP delivery.

Save the service URL, service API token and your business postal address. Select **Test service**. Then open **SMTP accounts**, add the account's hostname, port, TLS mode, username, password or provider app password, From details, daily limit and minimum interval. Select **Test connection**, then enable the accounts you want available for campaigns.

There is no fixed total account-count limit. Account, group and campaign lists use pagination. Each campaign accepts up to 1,000 selected accounts and 1,000 selected groups to keep an individual launch request bounded. Hosting storage, provider quotas and execution limits still apply.

Connection testing checks SMTP connectivity, TLS and authentication without sending an email. The provider may separately restrict which From addresses it accepts; use a single-address campaign test to verify the complete submission path. Accounts that require an OAuth-only flow need a compatible SMTP credential or a future OAuth integration; this release accepts SMTP username/password authentication.

## Filter addresses into a group

1. Open **Email verifier**, import a CSV/text file or paste addresses, and complete the saved upload.
2. Configure Reoon, review its credit requirement and start verification. The verifier retains the existing uncapped, chunked import and recovery workflow.
3. Once the job is completed, open **Email marketing → Contact groups → Add verified contacts**.
4. Select the completed verification job. Create a group with a title or choose an existing group.
5. Import the verified results. The app moves only provider-classified **Valid** results, in pages of up to 500. Duplicate memberships are skipped and an existing suppression is preserved.

Invalid, Risky and Unknown results remain in the verification report. Syntax checks alone never qualify an address for the sending group. A valid result is a time-specific provider finding, not a guarantee that a mailbox will stay available or that a campaign will reach the inbox. Contact groups can overlap; launch deduplicates the campaign audience.

This verifier retains email addresses and source-row references. It does not retain arbitrary CSV business metadata. Personalization supports `{{email}}`, `{{name}}` and `{{first_name}}`; missing names use “there”.

## Create and save a campaign

Choose a sample template or start from scratch. Enter a campaign name, subject and optional preview text. Use the visual editor for text formatting, links, images, tables and buttons; use **HTML source** for the complete layout. The preview can show a desktop or mobile email width.

Save the draft before testing or launching. The server removes executable scripts, forms, event handlers and unsafe markup while retaining the supported inline email styles. Include a plain-text alternative or generate it from the HTML. Email-client rendering differs, so an actual test in the intended inbox remains useful.

Choose **Send test**, enter a single intended mailbox and select a tested SMTP account. The operation sends the saved campaign, labels the subject as a test and records a stable request ID. A repeated acknowledgement check cannot send the same test again. Starting an intentional new test requires a new test action.

## Launch and control delivery

Select a saved draft, its contact groups and the enabled SMTP accounts to rotate. Set the interval between campaign emails in seconds and optionally a start time in **West Africa Time (UTC+1)**. Review the audience and permission acknowledgement, then launch.

The launch stores a fixed audience, content, account credential generations and sending-service generation. Later contact imports do not add recipients to an already launched campaign. SMTP account changes cannot silently redirect an existing campaign to a different connection. Accounts can be disabled immediately for new submissions.

The persistent queue rotates through the selected available accounts. It respects both the campaign interval and each account's minimum interval and daily attempt cap. Daily caps reset at 00:00 UTC, labelled in the account interface. A slower SMTP operation, an account cooldown or an exhausted daily allowance can lengthen the actual interval. It never substitutes an account you did not select.

Use **Pause**, **Resume pending only** and **Cancel** to control remaining work. An email already submitted cannot be recalled. Duplicate a launched campaign to create a new editable draft; review the intended audience again before launching a copy.

## Background processing

The companion's queue runner advances explicitly launched campaigns while the browser is closed. Its heartbeat is shown in Sending setup. It obtains no permission to create a campaign, change its recipients or launch a draft.

When the email workspace is open and visible, it can also advance already launched work. Database leases and account reservations coordinate this with the background runner. Closing the page stops this browser fallback. A missing or stale heartbeat is displayed; the interface does not claim unattended sending is connected without a recent successful callback.

The existing mailbox verifier has a separate hourly cloud task. That task advances only previously started verification jobs; it does not send campaigns. Its scheduling cadence does not determine the SMTP campaign interval. A deployed companion may advance verification more frequently through its optional independent verifier loop.

## Reports and recovery

| Status | Meaning |
|---|---|
| Pending | Not yet submitted |
| Sending | A persisted submission attempt is in progress |
| Accepted | The SMTP provider confirmed acceptance; inbox delivery is not implied |
| Failed | The operation was rejected or a known configuration failure prevented submission |
| Unknown | The outcome was not confirmed; automatic replay is disabled |
| Suppressed | The recipient was excluded before submission |

The app and relay store durable delivery IDs before SMTP submission. A timeout or process restart does not authorize replay. Unknown outcomes require reviewing provider history. The generic relay records SMTP acceptance and failure; it does not claim bounce, open, click or inbox-delivery events that the provider has not supplied.

Every message contains a signed unsubscribe link and business address. The public unsubscribe service suppresses that address across the owner's SMTP accounts. The app also supports manual suppression. Preserve the relay database and its stable signing key so earlier unsubscribe links and duplicate protection remain effective.

## Development and verification

The migration `0010_email_marketing.sql` adds separate marketing tables and must ship with its Drizzle metadata. Keep migrations 0000–0009; existing records are not rebuilt. Run the app test suite, TypeScript check, production build and the separate SMTP service tests before release.

Automated tests use synthetic addresses and controlled provider/SMTP fixtures. They verify software behavior, not real-provider credentials, billable account capacity or actual inbox placement. Do not describe a deployment as live-tested SMTP unless a real configured account and explicitly selected test recipient have completed that test.
