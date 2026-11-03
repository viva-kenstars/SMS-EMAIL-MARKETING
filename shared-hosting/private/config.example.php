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
    'smtp_allowed_hosts' => [], // Optional exact FQDN allowlist. Public DNS + validated TLS always required.
    'allow_local_http' => false, // Development only. Keep false on shared hosting.
    // Default verification provider for NEW jobs is Sendzad, with NO automatic paid fallback.
    // Use your private HTTPS service origin (no /v1 path) and the matching bearer token.
    'self_verifier_url' => getenv('SENDZAD_VERIFIER_URL') ?: '',
    'self_verifier_token' => getenv('SENDZAD_VERIFIER_TOKEN') ?: '',
];
