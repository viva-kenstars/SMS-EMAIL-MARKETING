<?php
declare(strict_types=1);
// Change only this path if public/ is copied to a different document root.
$appRoot = getenv('SENDZAD_APP_ROOT') ?: getenv('TREZAD_APP_ROOT') ?: dirname(__DIR__) . '/private';
if(is_file($appRoot.'/vendor/autoload.php'))require $appRoot.'/vendor/autoload.php';
foreach(['Core','Templates','Content','Mailer','Campaigns','Reports','Verification','Api']as $module)require_once $appRoot.'/app/'.$module.'.php';
ini_set('display_errors','0');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Frame-Options: SAMEORIGIN');
header('Cache-Control: no-store');
