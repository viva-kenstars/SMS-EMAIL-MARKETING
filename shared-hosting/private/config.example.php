<?php
/** Copy to config.php OUTSIDE the web root. Never commit real values. */
return [
    'app_url' => 'https://campaigns.example.com',
    'app_key' => '', // base64_encode(random_bytes(32)); preserve for the life of this installation.
    'db_dsn' => 'mysql:host=localhost;dbname=cpanel_sendzad;charset=utf8mb4',
    'db_user' => 'cpanel_sendzad',
    'db_password' => '',
    'timezone' => 'Africa/Lagos',
    'worker_seconds' => 40,
    'worker_messages' => 20,
    'verification_max_steps' => 10, // Self-hosted steps per cron, within the time budget.
    'smtp_allowed_hosts' => [], // Optional exact FQDN allowlist. Public DNS + validated TLS always required.
    'allow_local_http' => false, // Development only. Keep false on shared hosting.
    // Default verification provider for NEW jobs is Sendzad, with NO automatic paid fallback.
    // remote: HTTPS origin required. local: blank URL uses 127.0.0.1:8095 on THIS PHP host.
    // The Go service must already be installed; a matching private token is always required.
    'self_verifier_mode' => getenv('SENDZAD_VERIFIER_MODE') ?: 'remote',
    'self_verifier_url' => getenv('SENDZAD_VERIFIER_URL') ?: '',
    'self_verifier_token' => getenv('SENDZAD_VERIFIER_TOKEN') ?: '',
];
