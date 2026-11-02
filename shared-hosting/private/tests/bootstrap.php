<?php
declare(strict_types=1);
// Tests never use an existing installation configuration or real provider credentials.
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
$root=dirname(__DIR__);$configFile=$root.'/config.php';
if(is_file($configFile))throw new RuntimeException('Run tests in a clean checkout without private/config.php.');
$dsn=getenv('SENDZAD_TEST_DSN')?:'mysql:host=127.0.0.1;dbname=sendzad_test;charset=utf8mb4';
if(!preg_match('/dbname=[A-Za-z0-9_]*_test(?:;|$)/',$dsn))throw new RuntimeException('Tests require a database name ending in _test.');
$testConfig=['app_url'=>'https://campaigns.example.test','app_key'=>base64_encode(str_repeat('T',32)),'db_dsn'=>$dsn,'db_user'=>getenv('SENDZAD_TEST_DB_USER')?:'root','db_password'=>getenv('SENDZAD_TEST_DB_PASSWORD')?:'','allow_local_http'=>false,'smtp_allowed_hosts'=>[]];
file_put_contents($configFile,'<?php return '.var_export($testConfig,true).';');chmod($configFile,0600);
register_shutdown_function(static function()use($configFile){if(is_file($configFile))unlink($configFile);});
if(is_file($root.'/vendor/autoload.php'))require $root.'/vendor/autoload.php';
foreach(['Core','Templates','Content','Mailer','Campaigns','Reports','Verification','Api'] as $module)require_once $root.'/app/'.$module.'.php';
$checks=0;$failures=0;$skips=0;
function check(string $label,callable $run):void{global $checks,$failures;$checks++;try{$run();echo "PASS $label\n";}catch(Throwable $e){$failures++;echo "FAIL $label: ".$e->getMessage()."\n";}}
function eq(mixed $a,mixed $b):void{if($a!==$b)throw new RuntimeException('Expected '.var_export($b,true).', got '.var_export($a,true));}
function truth(bool $value):void{if(!$value)throw new RuntimeException('Assertion failed');}
function rejects(callable $run,?int $status=null):void{try{$run();}catch(Throwable $e){if($status!==null)eq($e instanceof Sendzad\Problem?$e->status:null,$status);return;}throw new RuntimeException('Expected rejection');}
function result():never{global $checks,$failures,$skips;echo json_encode(['checks'=>$checks,'passed'=>$checks-$failures,'failed'=>$failures,'skipped'=>$skips])."\n";exit($failures?1:0);}
