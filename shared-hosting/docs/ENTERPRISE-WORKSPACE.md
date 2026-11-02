# Sendzad: reusable templates, separate settings and flat workspace

## Scope and release state
This release changes the PHP/shared-hosting edition. It does not automatically
publish the existing TypeScript/Cloudflare Site or migrate its database. No
campaign, recipient, existing verification job or provider credential is changed
by the build. New template storage is additive.

## Build and install
1. Back up the application, database and stable installation key.
2. Import `private/database/migrations/0002_saved_templates.sql` into the existing
   application database through phpMyAdmin or the MySQL command line. This adds
   only `tz_templates` and `tz_template_versions`. Do not re-import schema.sql.
3. Run `python3 shared-hosting/scripts/build_release.py` in a source checkout.
   It produces `workspace-enterprise.js`, template assets and the asset manifest.
   `workspace.js` is the retained base; `enterprise.js` and `build_workspace.py`
   are editable source. The build checks its integration anchors and fails closed
   if a future base changes incompatibly. Do not hand-edit the generated file.
4. Deploy the changed PHP modules, public entry point and all generated/public
   assets together. Preserve private/config.php, installed vendor dependencies,
   the database and application key. PHP DOM and PDO MySQL remain required.
5. Keep private/ outside the web root. Exclude preview.html, demo.js and
   enterprise-demo.js from a production installation.
6. Perform the acceptance tests below before switching traffic.

## Independent areas
- Campaigns: drafts, audience, selection of existing enabled accounts, schedule,
  launch and delivery reports. There is no SMTP-password form in this workflow.
- Templates: Saved templates, Starter designs, Archived. A new template is not a
  campaign and has no audience or sending account.
- Email settings: separate URLs/views for SMTP accounts, Brand & sender details,
  Verification, and Delivery & tracking. Existing #settings/#senders links remain
  aliases. Account creation, authentication tests and toggles remain here.

## Template studio
Text, images, links/buttons, table layout, colour, typography, spacing, headers
and footers can be changed. Visual mode has an element inspector and section
add/move/duplicate/remove controls. HTML mode permits direct body markup editing;
scripts, forms, executable URLs and arbitrary external styles are not permitted.
The server applies the existing HTML sanitizer, retaining supported inline styles
and trusted responsive layout classes. This is not unrestricted web-page HTML.

Save writes an independent database template. It can be reopened, duplicated,
archived/restored, exported as HTML or copied into a campaign. Up to twenty saved
content revisions are retained. Optimistic revision checks reject stale saves;
the interface does not silently overwrite another editor's version. Saving uses
explicit Save / Ctrl-S rather than invisible autosave.

Creating a campaign copies the saved content and creates a DRAFT. It never selects
an audience, enables tracking, sends a test or launches mail. Later template edits
and archives do not change that campaign. A subject is required for this action.

Headers/footers in saved designs are detached from the old locked standard-module
markers. Brand merge fields may still be used. At send time custom footer content
is retained when it visibly includes the signed unsubscribe link and configured
postal address; otherwise a standard fallback footer is added. Deleting required
information in the editor does not defeat unsubscribe suppression. Keep one clear
footer and review the actual final test message to avoid duplicate custom legal text.

## Interface design
White surfaces, neutral grey workspace, fine borders, a single blue action colour,
compact headings, ordinary tables and small corner radii. No decorative gradients,
glass effects, floating metric shadows or marketing hero banner in the application.
Email design colours stay inside isolated previews. Responsive layouts retain keyboard
focus outlines, labelled inputs, navigation and reduced-motion preferences.

## Host acceptance
- Real MySQL: save/reopen/edit, stale revision conflict, duplicate, archive/restore,
  restore an older revision and verify campaign/template independence.
- Authenticated HTTP: unauthenticated reads denied; cross-origin and missing-CSRF
  writes denied; saved HTML sanitized on the PHP server with DOM enabled.
- Real browser: desktop/mobile and no cross-page leakage of SMTP credentials.
- Mail rendering: edited footer, valid signed unsubscribe and business address;
  one controlled test to a mailbox you own before a real campaign.
- Confirm versioned assets load and the host executes the configured queue jobs.

The synthetic demo store is browser-local, contains no private data, and refuses
real campaign operations. Browser demo tests are not substitutes for MySQL/SMTP
or authenticated PHP-host acceptance.

## Research references
Reviewed 2026-11-02. Original UI implementation, not copied vendor design assets.
- SendGrid Design Library: https://www.twilio.com/docs/sendgrid/ui/sending-email/working-with-marketing-campaigns-email-designs
- SendGrid editor: https://www.twilio.com/docs/sendgrid/ui/sending-email/design-editor
- Mailchimp template saving/reuse: https://mailchimp.com/help/save-use-email-template/
- Brevo sender settings: https://help.brevo.com/hc/en-us/articles/208836149-Create-a-new-sender-From-name-and-From-email
