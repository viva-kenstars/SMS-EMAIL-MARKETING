<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/app/Core.php';
use function Sendzad\{email,query};
fwrite(STDOUT,"Admin email: ");$address=email(trim(fgets(STDIN)));
fwrite(STDOUT,"Password (at least 14 characters; input hidden on Unix): ");
$hidden=function_exists('shell_exec')&&PHP_OS_FAMILY!=='Windows';if($hidden)shell_exec('stty -echo');
try{$password=rtrim(fgets(STDIN),"\r\n");}finally{if($hidden)shell_exec('stty echo');fwrite(STDOUT,"\n");}
if(!$address||strlen($password)<14){fwrite(STDERR,"Use a valid email and at least 14 password characters.\n");exit(1);}
try{query('INSERT INTO tz_admins(email,password_hash,created_at) VALUES(?,?,?)',[$address,password_hash($password,PASSWORD_DEFAULT),time()]);echo "Admin created.\n";}
catch(Throwable){fwrite(STDERR,"Could not create admin. Check configuration or existing account.\n");exit(1);}
