# Sendzad implementation and deployment status

Updated 2 November 2026.

## Two runtimes, not two deployments

- `app/`, `worker/`, `drizzle/` and `services/smtp-relay/` contain the existing TypeScript/Cloudflare application. Its private Site has not been republished by this recovery.
- `shared-hosting/` contains the recovered editable Sendzad PHP/MySQL candidate: dashboard, campaign editor, professional photo templates, tracking endpoints, verification queue, SMTP queue, source generators and tests.

The PHP implementation was previously uploaded as Git objects but never connected to a branch. This change attaches those source files to engineering without removing or replacing the existing application. It does not migrate SMS/WhatsApp or existing D1 jobs/data.

## Build before uploading PHP

Run `python3 shared-hosting/scripts/build_release.py`. This generates the template catalog, email layout, browser loader and asset manifest from the maintained source. Do not upload a raw source checkout without those generated assets. See `shared-hosting/README.md`.

The engineering workflow validates and packages source. It is NOT a deployment workflow and does not have hosting credentials. A successful Git commit, workflow or downloadable package is not proof that the private Site is updated.

## Live release gate

A release must be published through authenticated access to the existing Site or the chosen shared host, then verified at the actual URL. No such Site publishing control is available in this session. No live deployment, DNS change, account migration, verification restart or campaign launch is performed by this commit.

Never publish private/config.php, .env files, saved credentials, contact databases or test configuration. Keep the installation key stable and back up data before any real migration.
