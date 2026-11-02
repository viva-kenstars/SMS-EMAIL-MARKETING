<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
$ok=true;foreach(['pdo_mysql','openssl','curl','dom','mbstring']as $ext){$have=extension_loaded($ext);echo ($have?'PASS ':'FAIL ').$ext."\n";$ok=$ok&&$have;}
echo (PHP_VERSION_ID>=80200?'PASS ':'FAIL ').'PHP '.PHP_VERSION."\n";$ok=$ok&&PHP_VERSION_ID>=80200;
$vendor=is_file(dirname(__DIR__).'/vendor/autoload.php');echo ($vendor?'PASS ':'FAIL ')."Composer dependencies\n";
exit($ok&&$vendor?0:1);
