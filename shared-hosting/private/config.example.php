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
];
