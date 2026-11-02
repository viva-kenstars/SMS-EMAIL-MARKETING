<?php
declare(strict_types=1);
// Run on your own computer; no database or server connection is required.
// Import the generated SQL through phpMyAdmin, then delete the SQL file.
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
fwrite(STDERR,"Admin email: ");$email=trim((string)fgets(STDIN));
if(!filter_var($email,FILTER_VALIDATE_EMAIL)||strlen($email)>254){fwrite(STDERR,"Invalid email.\n");exit(1);}
fwrite(STDERR,"Password (14+ characters, hidden when a terminal supports it): ");
$hidden=function_exists('stream_isatty')&&stream_isatty(STDIN)&&function_exists('shell_exec')&&PHP_OS_FAMILY!=='Windows';
if($hidden)shell_exec('stty -echo');
try{$password=rtrim((string)fgets(STDIN),"\r\n");}finally{if($hidden)shell_exec('stty echo');fwrite(STDERR,"\n");}
if(strlen($password)<14||strlen($password)>1024){fwrite(STDERR,"Use 14-1024 password characters.\n");exit(1);}
$hash=password_hash($password,PASSWORD_DEFAULT);
// Hex literals avoid SQL-mode-dependent string escaping. Never emit plaintext password.
echo "INSERT INTO tz_admins(email,password_hash,created_at) VALUES(CONVERT(0x".bin2hex($email)." USING utf8mb4),CONVERT(0x".bin2hex($hash)." USING utf8mb4),".time().");\n";
