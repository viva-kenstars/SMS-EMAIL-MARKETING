# Trezad SMS & Email Marketing

A private SMS, WhatsApp and email marketing workspace for Nigerian businesses and communities. Built with React, Vinext, Cloudflare Workers and D1, with seven server-side SMS provider integrations, Reoon mailbox verification and a separate SMTP sending service.

## Email marketing — 1 November 2026

Open **Email marketing** in the sidebar or use `#marketing`. Create HTML campaigns with a visual editor, full source editing, desktop/mobile preview and six sample templates. Save drafts, send a test to an explicitly entered mailbox, choose verified contact groups and rotate selected SMTP accounts at a configured interval. Campaigns support scheduled starts, pause, resume of pending recipients, cancellation and persistent per-recipient reports.

Add multiple SMTP accounts with independent enable switches, connection tests, daily attempt caps and minimum intervals. Passwords and the sending-service token are encrypted using the existing master key. Import only provider-verified Valid results from completed verifier jobs into new or existing titled groups; existing suppressions and duplicate memberships are preserved.

Generic SMTP requires the included **separate Node sending service** because the private Site runtime cannot open SMTP TCP connections. The service provides strict TLS, durable delivery IDs, public signed unsubscribe pages and a background queue runner. Deploy `services/smtp-relay/` on a host with outbound SMTP and HTTPS, then connect it in **Sending setup**. The private app also includes `/smtp-service-setup.html` and a downloadable service package. These files do not provision a server or prove real-provider delivery.

See [Email marketing guide](docs/email-marketing.md) and [SMTP service deployment](docs/smtp-relay.md) for the complete workflow, security boundaries and installation steps. Unknown SMTP outcomes are retained for review and are not automatically retried. SMTP acceptance is reported separately from inbox delivery. No real campaign or test email is sent by the automated tests.

The recovered original app passes all 364 previous regression checks. The background verification client now honors the configured HTTP/HTTPS proxy; a separate protected hourly task advances only verifier jobs already started by the owner. The SMTP service's own worker controls campaign intervals independently of that hourly task. New release checks are recorded in [release validation](docs/release-validation-2026-11-01.md).

## Email verifier — 29 October 2026

Open **Email verifier** in the sidebar, or use the `#email` link. Add your Reoon API key in **Reoon settings**, save it, and test the connection. The key is encrypted on the server; the interface returns only configuration status and account credits.

Email imports have **no fixed total-record cap**. CSV files and pasted addresses are read incrementally and saved in chunks of up to 500 records, with an independent request-byte limit. Duplicate addresses share one provider verification while every original row remains available in results. Uploads can be resumed by supplying the same source and column settings; the server verifies saved chunk digests before accepting continuation. Importing and checking a provider connection do not submit addresses for paid verification.

After upload, review the unique eligible addresses and select **Start verification**. The queue persists provider task IDs and advances native Reoon bulk batches of at most 2,000 addresses, using smaller batches when credits require it. Small lists below 10 eligible addresses use Power checks. The per-batch limits protect memory and provider contracts; they do not cap the overall imported list. Available credits and hosting storage/quotas still govern eventual capacity.

Results are classified as **Valid**, **Invalid**, **Risky**, **Unknown** or **Pending**. Syntax checks alone never mark an address Valid. Unknown is a recorded result, not an instruction to recheck indefinitely. Paid requests with uncertain outcomes are held for review and are never automatically resubmitted. **Pause**, **Resume**, **Cancel** and existing-task reconciliation preserve saved results.

An authenticated background endpoint can advance jobs after the browser closes. Its current heartbeat appears in the app. Open, visible pages can also advance due work; the same database lease prevents a second submission. Background operation requires the protected runner and a recurring caller described in [Email verification operations](docs/email-verification.md). The app does not claim unattended processing is healthy when that runner is absent or stale.

CSV exports fetch bounded result pages. Browsers with the native save-file API stream the whole report to one file. Other browsers download bounded parts, with a **Download next CSV part** action until the selected results are exhausted. Exported values are protected against spreadsheet formula execution. Wait for a completed job when you need a final, stable category export.

The verifier supplies eligible results to the separate email marketing workflow above. Existing SMS contacts and message-campaign limits remain documented separately below.

### Run the checks

```sh
npm run install:ci
npm test
npm run typecheck
npm run build
```

The current release passes **416 automated checks across 17 test files**, including actual Miniflare/workerd and D1 checks. A complete **20,001-address** mocked verification run finishes all eleven bulk tasks and exports every row exactly once; separate tests stream 50,001 imported records and 51,007 exported rows. All verification tests use synthetic addresses and mock provider responses. Live mailbox accuracy, account billing and throughput require a configured Reoon account and an explicitly started real verification job. The managed preview service was unavailable during this release, so browser layout QA remains unverified.

Use **engineering** for implementation and **staging** for release validation. **main** holds the published source baseline. These branches do not provision separate hosted environments. The public `.openai/hosting.json` retains the D1 binding but intentionally omits the private Site project ID; connect a separate installation to its own authorized hosting project and configure its real application origin. The public UI uses a generic Owner label. All original migrations, including 0008 and 0009, and migration 0010 for email marketing are included. Runtime credentials, D1 databases, uploaded lists, local environment files and generated build directories are excluded. Private hosting access, data and recurring task registrations are not copied by cloning this repository.

## Current activation state

The application supports persistent contacts, typed recipients, campaign drafts, preview validation, templates, campaign reports, exports and encrypted API configuration inside **Provider settings**. Save several provider accounts and choose exactly one active SMS provider. Every account has its own credentials, sender confirmation, balance and optional NGN estimate rate. WhatsApp retains its independent live switch and shared Termii connection. Preview validation never contacts a provider and never claims that a message was delivered.

## Provider selection — reviewed 22 October 2026

The app implements these documented contracts. This is a supported-integration list, not an independently measured uptime or delivery-rate ranking.

| Provider | Credentials | Balance | App submission batch | Final delivery reporting |
| --- | --- | --- | --- | --- |
| Termii | API key and account-specific base URL | Value and currency returned by Termii | 100 recipients, native bulk | In-app polling |
| BulkSMSNigeria | API token | NGN total wallet balance | 100 recipients, direct-refund route | In-app polling |
| SmartSMSSolutions | API token | Provider credits; the scalar API response has no currency | 100 recipients, basic route | Provider dashboard |
| Africa’s Talking | Live application username and API key | Actual account currency | 100 recipients, native bulk | Provider dashboard |
| Twilio | Account SID and Auth Token | Actual account currency | Five separate recipient requests | In-app polling |
| Vonage | API key and API secret | EUR | Five separate recipient requests | Provider dashboard |
| Sendchamp | Live access token | Actual wallet currency | Five separate recipient requests, non-DND route | Provider dashboard |

Sendchamp documents `Sendchamp` as a default sender. Custom senders and destination/account restrictions still require confirmation. Changing providers does not transfer approvals or remove Nigerian network requirements. Termii alone exposes a separate DND/transactional route in this release; other adapters use their documented standard routes. No automatic provider failover is performed.

- Termii messaging API: https://developers.termii.com/messaging-api/
- Account-specific API base URL: https://developers.termii.com/
- Delivery history: https://developers.termii.com/history
- Balance: https://developers.termii.com/balance
- Sender ID retrieval and approval requests: https://developers.termii.com/sender-id/
- BulkSMSNigeria v2: https://www.bulksmsnigeria.com/api
- SmartSMSSolutions: https://developer.smartsmssolutions.com/
- Africa’s Talking official SDK: https://github.com/AfricasTalkingLtd/africastalking-node.js/
- Africa’s Talking sender onboarding: https://help.africastalking.com/en/articles/2257657-how-do-i-get-a-sender-id-in-nigeria
- Twilio SMS: https://www.twilio.com/docs/messaging/api/message-resource
- Twilio balance: https://help.twilio.com/articles/360025294494-Check-Your-Twilio-Project-Balance
- Vonage SMS and account balance: https://developer.vonage.com/en/api/sms and https://developer.vonage.com/en/api/account
- Sendchamp SMS and wallet balance: https://sendchamp.readme.io/reference/send-sms-api and https://sendchamp.readme.io/reference/get-wallet-balance-api

No external provider account was created, no credits purchased, and no live messages sent while building this app.

## Activation

1. Open **Provider settings → SMS providers**. Choose a provider and select **Add credentials** or **Configure**. Create/fund the account directly with that service when necessary.
2. Paste the requested credentials, then choose **Save & test connection**. Testing reads the balance and sends no message. Credentials can be saved before configuring a sender. Blank secret fields preserve existing values; saved secrets are never returned to the browser.
3. Save the exact sender permitted for that account and Nigerian recipients, and confirm its permission. An optional naira rate is only an estimate; it does not convert or change the provider’s wallet currency. Twilio and Vonage also support a permitted numeric sender in `+international` format.
4. Each provider card shows whether credentials, connection verification and a valid approved sender are complete. Use **Verify & activate** when the sender is ready but the connection has not been tested; otherwise use **Activate SMS** or the **Active** switch. Setup switches lead to the missing step. The server atomically replaces the previous selection. Turning the active switch off pauses SMS. Stored credentials for other providers remain available.
5. For Termii, **Choose approved sender** opens its Sender IDs directly; choose **Use ID** beside an active Nigerian sender. **Configure** opens the retained connection, Sender ID and WhatsApp setup. Its URL must be the account-specific HTTPS origin, without `/api`. New ID requests remain pending until approved. These tools remain Termii-specific.
6. Use **Send messages → Type or paste numbers** to prepare a reviewed test to your own phone before a larger campaign. No test SMS is sent merely by saving or testing credentials.

Changing credentials clears verification and pauses that provider until it is tested and activated again; alternative-provider sender confirmations are cleared on credential replacement. Re-entering an identical Termii key with an unchanged base URL preserves verification, sender approval and campaign bindings. A definitive HTTP 401 from an explicit connection test invalidates only the checked verification, pausing effective use until the account passes a new test; transient errors and background balance failures do not reset it. Delayed failures cannot invalidate newer credentials or a newer successful test. Removing credentials pauses that connection while retaining history. New SMS campaigns freeze the provider and credential generation. An existing campaign can resume only with its original provider active and the same credentials and sender. Duplicate a campaign to review it with a different provider or replacement account. Older drafts created before account generations were recorded also require duplication; historical data is not retroactively relabelled as belonging to the current credentials.

Alphanumeric sender IDs usually do not accept replies. Use a real monitored opt-out method in promotional copy; record opt-outs through the contact suppression control. The SMS channel does not provision an inbound STOP number. Email unsubscribe pages are supplied by the separate SMTP service.

## Dashboard balance and sender IDs

The dashboard and provider cards read each connected account’s real balance independently. Balances refresh manually and every five minutes while the tab is visible, with provider currency or credit unit and WAT timestamp. Termii uses one shared balance reader across the dashboard and settings. Connection tests reuse their returned balance, overlapping requests join the current read, and a 30-second freshness window avoids immediate background duplicates. A failed refresh retains a labelled last-known amount rather than inventing zero. Reads do not send messages or select another provider. Changing or disconnecting credentials clears its browser snapshot, and delayed responses for an older account or an older check are discarded. One provider failure does not hide other provider balances.

Sender IDs are fetched through the documented `GET /api/sender-id`; only a returned `active` record for Nigeria is selectable as verified. A verified selection is bound to the saved credential generation, so replacing the account invalidates that approval. Submission uses `POST /api/sender-id/request` with `sender_id`, `company` and `use_case`. The request ledger prevents concurrent or uncertain submissions of the same ID from being repeated automatically. Explicit provider rejection permits a corrected new submission; uncertain outcomes require checking Termii. The app does not approve IDs itself, promise an approval time, or treat sender registration as DND or WhatsApp approval.

## WhatsApp activation and invitations

1. Complete Termii's WhatsApp Business account/device onboarding and billing. Ask Termii to approve a text template containing your invitation and its variables. A community invitation will generally be marketing; use the category actually approved by the provider.
2. Save and test the shared Termii base URL and API key in **Provider & settings**. The balance check verifies account access; it does not verify WhatsApp device activation or template approval.
3. Under **WhatsApp business & template**, enter the device ID, approved business display name, template ID, approved category and a copy of the approved template body. Use the exact variable keys shown on Termii's Device Subscription page: for example `{{1}}` for key `1`, or `{{invite_link}}` if that is the key Termii assigned. IDs are copied from Termii; this app does not create or list remote devices/templates.
4. Optionally enter the current NGN cost per template message for estimates. Confirm account activation and exact-template approval only after checking them in Termii, then save. These are owner confirmations, not independent approval checks by this app.
5. Enable **WhatsApp live sending** separately. No SMS sender approval or SMS activation is needed. Changing the device, business identity, template ID, reference body or category turns WhatsApp live sending off. Replacing the shared API key or base URL requires a new connection check and WhatsApp activation. SMS-only live changes leave WhatsApp active.
6. Open **Send messages**, choose **WhatsApp**, enter the template variable values and choose saved contacts or typed test numbers. Confirm recipient permission for the named organisation, run a preview, then review and explicitly confirm a real test send. Variable values are shared across all recipients in that campaign; individual name merging is not implemented.

The copied template body is a **local preview reference**. Termii sends its authoritative approved template by ID. Editing the copy does not edit Termii's template, and an outdated or incorrect copy can differ from the actual delivery. Check the exact ID, text and variables in Termii and verify a test message on a handset. A campaign freezes its device, template, variables and reference text; changing the approved setup requires reviewing a new draft before dispatch.

The implementation uses the documented `POST /api/send/template` with one international, digits-only number per request. Up to five requests run in each browser-driven batch, with individual provider IDs and outcomes persisted. The app supports up to 5,000 recipients in one campaign, but account messaging limits and available funding still govern real delivery. Keep the browser tab open. **Pause after this batch** stops subsequent batches; already submitted requests cannot be recalled. Failed or uncertain submissions halt later batches and are never automatically retried or redirected to SMS.

Recipients choose whether to follow the invitation link. The app does not enroll them into a WhatsApp group or detect a group join. Refreshing delivery reports is separate from sending and uses each recipient's provider message ID. This release implements outbound text templates and reporting, not media templates, a two-way inbox, free-form session messages, or automated incoming STOP processing. Use a monitored reply/support channel and record opt-outs in Contacts.

For a 3,000+ audience, confirm the current capacity of your destination group, Community or Channel and your business account’s messaging allowance before dispatch. The app distributes an invitation; it does not provision group capacity or enroll people automatically.

Official references reviewed 22 October 2026:

- Template requests and required variable keys: https://developers.termii.com/templates/
- WhatsApp free-form sessions (not integrated): https://developers.termii.com/whatsapp-freeform
- Permission, templates and customer service windows: https://whatsappbusiness.com/policy/
- Pricing and account/channel charges: https://termii.com/pricing/
- Group size: https://faq.whatsapp.com/7179561392143247/?cms_platform=web
- Community size: https://faq.whatsapp.com/582420703681043
- Channels: https://faq.whatsapp.com/265055289421317/

## Send to numbers without saving contacts

In **Send messages**, choose SMS or WhatsApp, then switch the audience from **Saved contacts** to **Type or paste numbers**. Enter one complete Nigerian number per line, or separate numbers with commas or semicolons. The app accepts the same four local and international formats used in contact imports, normalizes the numbers and removes duplicates. Invalid entries must be corrected before a draft, preview or send can proceed.

Confirm that these are your own test numbers or that you have permission to message them. Direct entry does not add anyone to the address book. Existing suppression or withdrawn permission still applies when a typed number matches one of your contacts, and the server checks this again before submission.

Use preview for validation without sending, or review and explicitly confirm a live send to deliver a real test SMS using the configured sender and account. The confirmation identifies the direct audience and shows the first ten numbers with a count for any remainder. Only the active audience source is included. Your saved-contact selection, message and sender stay available when switching back to **Saved contacts** after testing.

## Sending and delivery semantics

- Up to 20,000 contacts per workspace; 5,000 contacts per import and 5,000 recipients per campaign.
- All four complete Nigerian mobile formats are accepted: `+2347061234567` (recommended), `2347061234567`, `07061234567` and `7061234567`. They normalize to `+2347061234567` for storage and deduplication. Each adapter converts that canonical value into its required wire format. Drop the local leading zero when adding `234`; `+23407061234567` is invalid. Keep CSV phone columns as text. Validation checks number structure, not active SIM ownership.
- Duplicate imports do not overwrite prior consent or suppression choices.
- Campaign creation snapshots the selected eligible recipients and persists all rows before the draft becomes sendable.
- SMS batches follow the provider table above. WhatsApp requests contain one recipient, with up to five requests in each dispatch batch. The browser dispatches consecutive batches and must remain open; returning to a partially submitted campaign permits resuming only unsubmitted batches. SMS and WhatsApp have no background scheduler; email campaigns use the separate SMTP service runner described above.
- Atomic batch claims prevent repeat submissions of the same pending batch. Permission and suppression are checked again just before each submission.
- If the final setup check fails before any provider submission is attempted, only that provably unsent batch returns to pending. Suppressed and concurrently cancelled recipients stay skipped. Once submission starts, an uncertain result cannot be released or replayed.
- Network timeouts, interrupted requests and ambiguous responses are marked **Unknown**. They are not retried automatically. Check provider history first; the provider may already have billed and delivered those messages.
- **Accepted** means the provider acknowledged submission. Only a matching provider delivery report marks a recipient **Delivered**. Reports are matched on message ID and recipient number, and refreshing them never resends a message. Delivered does not establish that the person read an invitation or joined a group.
- A private deployment cannot receive an ordinary unauthenticated public provider webhook. This release polls reports for Termii, BulkSMSNigeria and Twilio. Other integrations expose submission results and direct users to their provider dashboard for final reports.
- Report refresh uses stable pages of up to ten submission IDs, with five parallel reads at a time, and skips groups already fully delivered. A provider rate limit or access rejection stops after the current wave, preserving successful updates and displaying safe guidance. The browser also checks that cursors advance and caps a refresh pass at 500 pages.
- Termii promotional campaigns are permitted in the app between 08:00 and 20:00 Africa/Lagos to avoid its documented MTN quiet hours. Other providers apply their account and network rules. Transactional routing is separate and must not be used to reroute marketing traffic to DND subscribers.
- Cancellation affects only recipients not yet submitted. It cannot recall a message already handed to the provider.

## Segment and cost estimates

The shared segment calculator handles the GSM basic alphabet, two-septet extension characters and Unicode UTF-16 code units. It uses 160/153 GSM units or 70/67 Unicode units for single/multipart messages, preserving extension and surrogate pairs at boundaries. The provider's final encoding, routing, taxes and rate card govern actual charges. Estimates stay blank until the owner supplies a rate; no unsupported fixed Termii price is shown.

WhatsApp estimates use the configured template-message rate multiplied by the recipient count, without SMS segment multiplication. They exclude account subscription fees, other platform charges and taxes. Termii's public pricing on the review date lists USD50 per month per WhatsApp Business Account plus channel charges; use the actual quote for your account and category rather than treating the local estimate as an invoice.

## Data protection and access

Hosted access is owner-private through Sites sign-in. Every API operation also requires the platform user identity. Database reads and writes use that stable user ID. Mutations accept same-origin JSON requests, provider error text is sanitized and exports neutralize spreadsheet formulas. Do not publish this administrative workspace publicly without revisiting roles, membership, operational limits and sending authorization.

Newly entered credentials travel in a same-origin HTTPS request and are encrypted on the server with AES-256-GCM before storage in D1. The authenticated context binds ciphertext to its owner and provider; Termii additionally binds its account-specific base URL. Saved secret fields and ciphertext are never returned by the application API or embedded in frontend bundles. Public identifiers such as an application username or Account SID remain visible for account management. Password visibility applies only to newly typed secrets. Revision checks prevent a stale browser session or delayed connection test from overwriting or verifying newer credentials. Provider hosts are fixed, except for the validated Termii-owned HTTPS origin; redirects are never followed and submissions are never retried automatically.

The hosted app has a protected `SMS_SETTINGS_ENCRYPTION_KEY` runtime secret. For a separate installation, provision a canonical standard Base64 encoding of 32 cryptographically random bytes before using API settings. Keep that master key stable across deployments and protect any operational backup; replacing it without re-encrypting saved credentials makes them unreadable. User API edits do not change this runtime key and do not require redeployment. Legacy `TERMII_API_KEY`, `TERMII_BASE_URL` and `SMS_LIVE_ENABLED` environment configuration is read only until an owner-specific settings row exists. Disconnect keeps an explicit empty row so legacy credentials cannot silently reconnect the account.

The frontend uses the existing Sites authentication boundary; it does not implement a separate password or OAuth system. An unauthenticated internal preview may show the interface while returning 401 for data operations. It must not claim to save changes in that state.

## Development and verification

Use the Sites project's supplied setup, install, preview and build helpers. Schema changes use Drizzle migrations and are applied to hosted D1 by publication. Local D1 is separate. The following pure tests exercise utilities and the adapter without contacting Termii:

```sh
node --experimental-strip-types tests/sms.test.ts
node --experimental-strip-types tests/direct-numbers.test.ts
node --experimental-strip-types tests/termii.test.ts
node --experimental-strip-types tests/nigeria-providers.test.ts
node --experimental-strip-types tests/international-providers.test.ts
node --experimental-strip-types tests/whatsapp.test.ts
node --experimental-strip-types tests/secret-store.test.ts
node tests/server.test.mjs
node tests/termii-worker.test.mjs
node tests/sms-providers-worker.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

The provider adapter tests use mock fetch responses. They establish request/response behavior, not actual telecom delivery. Live network acceptance and handset receipt remain unverified until the owner configures and funds the account and authorizes a real test recipient.

### Verification on 22 October 2026

The activation and reliability update passes **244 targeted checks**: 111 API/database integration tests, 43 Termii adapter tests, 27 Nigeria-provider tests, 26 international-provider tests, and 37 actual Miniflare/workerd checks. Provider responses are mocked. Regression coverage includes identical-key saves, explicit authentication rejection, delayed verification races, sender/routing changes during activation, suppression and cancellation during unsent batch recovery, report rate limits, and report cursor stability. Desktop and 390-pixel mobile UI checks cover verification/activation, failed verification, approved-sender selection and concurrent provider selection; the mobile content fits its viewport without horizontal overflow.

Measured database work in the test harness: a 5,000-contact import uses **21 SQL statements instead of 501**; deletion of 5,000 selected IDs uses **one instead of 63**. A 100-recipient dispatch uses **29 statements for Termii** and **19 for BulkSMSNigeria**. Report pages return bounded records instead of materializing all message IDs on every page; grouped SQL still examines the campaign's recipient rows. Dashboard summaries are limited to the latest 100 campaigns. These are application/database efficiency measurements, not claims about telecom throughput or handset delivery latency. Provider batch limits remain unchanged.

The multi-provider update passes 96 API/database integration tests, 24 Nigeria-provider adapter tests, 26 international adapter tests, and 27 actual Miniflare/workerd checks for the six additional providers. The existing Termii suite remains covered separately. Network requests in all tests are intercepted locally. New tests verify account isolation, encryption context, credential rotation, no balance-triggered sends, concurrent exclusive activation, frozen campaign account versions, partial results, uncertain outcomes without replay, delivery-report identity and independent Termii WhatsApp operation. Native 100-recipient sends and 5,000-recipient previews are checked against the D1 query budget. Desktop and 390-pixel mobile layouts are reviewed using a labelled standalone fixture with simulated data; fixtures are removed before packaging.

The WhatsApp update passes 51 API/database integration tests, including all existing SMS/provider/direct-recipient cases. Added coverage verifies independent channel activation, credential generations, owner/template permissions, immutable snapshots, exact variables, five-plus-one dispatch, individual IDs, mixed rejected/unknown outcomes, no replay or fallback, suppression, and message-scoped reports. A 5,000-number preview check persists every recipient and 1,000 dispatch batches without provider calls and verifies creation stays within 50 executed D1 statements. Recipient inserts use bound JSON with supported D1 SQLite functions; per-batch status queries have a dedicated index. The shared WhatsApp helpers pass 9 tests and the Termii adapter passes 21 tests. These are mocked-provider checks, not live device acceptance or handset delivery.

The direct-recipient update passed all 33 API/database integration checks and 9 direct-number parser checks. The existing utility, adapter and encryption suites cover SMS segments, normalization, provider payloads and credential protection. The API integration suite executes the real request handler against all checked-in migrations in an in-memory SQLite implementation of D1, with a fail-closed provider mock. It covers direct campaigns without saved contacts, audience separation, strict consent, whole-request validation, duplicate handling, suppression before creation and dispatch, owner isolation, encrypted configuration, revision conflicts, verification races, disconnect behavior, preview behavior, live activation gates, 100+1 recipient batching, concurrent submission claims, uncertain/rejected outcomes and delivery-report matching.

A separate smoke check against the actual local D1 preview database verified import, duplicate rejection, persisted contacts and campaigns, preview recipient reports and suppression using a newly created synthetic test identity. No pre-existing data was changed and no SMS send request was made. The dashboard, composer segment counter, template selection and phone preview were inspected in the internal browser. TypeScript checks and the production build passed.
