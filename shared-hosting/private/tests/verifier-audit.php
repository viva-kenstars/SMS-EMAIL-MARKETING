<?php
declare(strict_types=1);
namespace Sendzad;
if(PHP_SAPI!=='cli')exit;
// Isolated contracts. No production config, DB, provider key or live address is used.
final class Problem extends \RuntimeException { public function __construct(string $s,public int $status=400){parent::__construct($s);} }
function config():array{return $GLOBALS['audit_config']??[];}
require __DIR__.'/../app/SelfVerifier.php';
require __DIR__.'/../app/VerifierWorker.php';
$n=0;$failed=0;
function audit_check(string $label,callable $fn):void{global $n,$failed;$n++;try{$fn();echo "PASS $label\n";}catch(\Throwable $e){$failed++;echo "FAIL $label: ".$e->getMessage()."\n";}}
function audit_equal($a,$b):void{if($a!==$b)throw new \RuntimeException('unexpected result');}
function audit_reject(callable $fn,?string $reason=null):void{try{$fn();}catch(Problem|VerifierSetupProblem $e){if($reason!==null)audit_equal($e->reason??null,$reason);return;}throw new \RuntimeException('expected rejection');}
$none=static fn()=>false;$token=str_repeat('t',40);$remote=['self_verifier_url'=>'https://verify.example.test','self_verifier_token'=>$token];
audit_check('blank remote address fails clearly',fn()=>audit_reject(fn()=>verifier_config_values([],$none),'missing_url'));
audit_check('missing token distinguished from missing address',fn()=>audit_reject(fn()=>verifier_config_values(['self_verifier_url'=>'https://verify.example.test'],$none),'missing_token'));
audit_check('local mode uses explicit loopback default',fn()=>audit_equal(verifier_config_values(['self_verifier_mode'=>'local','self_verifier_token'=>$token],$none)['url'],'http://127.0.0.1:8095'));
audit_check('local mode still requires authentication',fn()=>audit_reject(fn()=>verifier_config_values(['self_verifier_mode'=>'local'],$none),'missing_token'));
audit_check('empty PHP values fall back to environment',function()use($token){$env=static fn($k)=>['SENDZAD_VERIFIER_URL'=>'https://verify.example.test','SENDZAD_VERIFIER_TOKEN'=>$token][$k]??false;audit_equal(verifier_config_values(['self_verifier_url'=>'','self_verifier_token'=>''],$env)['token'],$token);});
audit_check('nonempty private config wins over environment',fn()=>audit_equal(verifier_config_values($remote+['self_verifier_mode'=>'remote'],static fn()=> 'ignored')['url'],'https://verify.example.test'));
foreach(['http://127.0.0.2:8095','http://localhost:8095','http://127.0.0.1:22','http://127.0.0.1:8095/path','http://127.0.0.1:8095?x','http://127.0.0.1:8095@evil.test']as $url)audit_check('local destination restricted '.$url,fn()=>audit_reject(fn()=>verifier_config_values(['self_verifier_mode'=>'local','self_verifier_url'=>$url,'self_verifier_token'=>$token],$none)));
foreach(['http://verify.example.test','https://127.0.0.1','https://127.1','https://service.internal','https://user@verify.example.test','https://verify.example.test/path','https://verify.example.test?','https://verify.example.test#','https://verify.example.test:8095',"https://verify.example.test\n"]as $url)audit_check('remote origin rejects '.$url,fn()=>audit_reject(fn()=>verifier_config_values(array_replace($remote,['self_verifier_url'=>$url]),$none)));
audit_check('remote origin canonicalized',fn()=>audit_equal(verifier_config_values(array_replace($remote,['self_verifier_url'=>'https://VERIFY.example.test:443/']),$none)['url'],'https://verify.example.test'));
audit_check('setup response never returns token or fingerprint',function()use($remote,$none,$token){$s=verifier_setup_status($remote,$none);audit_equal($s['configured'],true);audit_equal($s['state'],'configured_unchecked');audit_equal(str_contains(json_encode($s),$token),false);audit_equal(isset($s['hash']),false);audit_equal($s['acceptance_tested'],false);});
audit_check('setup response provides actionable missing field',fn()=>audit_equal(verifier_setup_status([],$none)['issue'],'missing_url'));
audit_check('local proxy is not bypassed',fn()=>audit_equal(verifier_local_proxy_ready(static fn($k)=>$k==='ALL_PROXY'?'http://proxy.invalid':false),false));
audit_check('local proxy exclusion must be explicit',fn()=>audit_equal(verifier_local_proxy_ready(static fn($k)=>['ALL_PROXY'=>'http://proxy.invalid','NO_PROXY'=>'localhost,127.0.0.1'][$k]??false),true));
audit_check('local direct deployment allowed',fn()=>audit_equal(verifier_local_proxy_ready($none),true));
audit_check('bounded JSON response accepted',fn()=>audit_equal(verifier_http_reply(200,'application/json; charset=utf-8','{"engine":"sendzad"}')['data']['engine'],'sendzad'));
foreach([301,302,401,403,429,500]as $code)audit_check('reject HTTP '.$code,fn()=>audit_reject(fn()=>verifier_http_reply($code,'application/json','{"error":"private"}')));
foreach(['{} trailing','[]','null','{"x":'.str_repeat(' ',32768).'}']as $raw)audit_check('reject malformed/oversized response '.strlen($raw),fn()=>audit_reject(fn()=>verifier_http_reply(200,'application/json',$raw)));
audit_check('reject HTML response',fn()=>audit_reject(fn()=>verifier_http_reply(200,'text/html','{}')));
$path=getenv('SENDZAD_AUDIT_FIXTURES');if(!$path||!is_file($path))throw new \RuntimeException('Set SENDZAD_AUDIT_FIXTURES to Go-produced fixtures.');
$fixtures=json_decode(file_get_contents($path),true,32,JSON_THROW_ON_ERROR);
foreach($fixtures['results']as $r)audit_check('actual Go output accepted '.$r['reason'],fn()=>audit_equal(self_results(['engine'=>'sendzad','results'=>[$r]],[$r['email']])[$r['email']]['category'],$r['category']));
$base=$fixtures['results'][0];
foreach(['null_mx','no_mail_route','invalid_syntax']as $reason)audit_check('unsupported negative assertion rejected '.$reason,function()use($base,$reason){$r=array_replace($base,['category'=>'invalid','reason'=>$reason]);audit_reject(fn()=>self_results(['engine'=>'sendzad','results'=>[$r]],[$r['email']]));});
audit_check('legacy invalid syntax spelling accepted narrowly',function()use($fixtures){$r=$fixtures['results'][1];$r['syntax']='invalid_syntax';audit_equal(self_results(['engine'=>'sendzad','results'=>[$r]],[$r['email']])[$r['email']]['syntax'],'invalid');});
foreach(['role_account','catch_all','disposable']as $field)audit_check('invalid field type rejected '.$field,function()use($base,$field){$r=$base;$r[$field]=123;audit_reject(fn()=>self_results(['engine'=>'sendzad','results'=>[$r]],[$r['email']]));});
audit_check('duplicate expected identities rejected',fn()=>audit_reject(fn()=>self_results(['engine'=>'sendzad','results'=>[$base,$base]],[$base['email'],$base['email']])));
audit_check('drain handles multiple self-hosted steps',function(){$calls=0;$now=0.;$r=drain_verification(static function()use(&$calls){$calls++;return ['engine'=>'sendzad','advanced'=>4];},40,4,static function()use(&$now){return $now;},static function($s)use(&$now){$now+=$s;});audit_equal($calls,4);audit_equal($r['advanced'],16);});
audit_check('paid provider stays single-step',function(){$calls=0;drain_verification(static function()use(&$calls){$calls++;return ['advanced'=>100];});audit_equal($calls,1);});
audit_check('budget reserves timeout before next step',function(){$calls=0;$now=0.;drain_verification(static function()use(&$calls,&$now){$calls++;$now+=20;return ['engine'=>'sendzad','advanced'=>4];},40,10,static function()use(&$now){return $now;});audit_equal($calls,1);});
audit_check('long cooldown exits instead of busy loop',function(){$calls=0;$r=drain_verification(static function()use(&$calls){$calls++;return ['engine'=>'sendzad','advanced'=>0,'next_at'=>time()+60];},40);audit_equal($calls,1);});
audit_check('attention propagates for nonzero cron exit',function(){$r=drain_verification(static fn()=>['attention'=>'review','advanced'=>0]);audit_equal($r['attention'],'review');audit_equal($r['steps'],1);});
audit_check('overlap stops without another call',function(){$r=drain_verification(static fn()=>['busy'=>true]);audit_equal($r['steps'],1);});
echo json_encode(['passed'=>$n-$failed,'failed'=>$failed,'scope'=>'isolated contracts and scheduling; no MySQL or cURL network'])."\n";exit($failed?1:0);
