<?php
declare(strict_types=1);
namespace Sendzad;
// Isolated contract/transition tests. No production configuration, DB or network is opened.
if(PHP_SAPI!=='cli')exit(1);
class Problem extends \RuntimeException{public function __construct(string $m,public int $status=400){parent::__construct($m);}}
$GLOBALS['cfg']=['self_verifier_url'=>'https://verify.example.test','self_verifier_token'=>'test-only-token-not-a-live-secret-123456'];
function config():array{return $GLOBALS['cfg'];}
function ident(mixed $v):string{if(!is_string($v)||!preg_match('/^[a-f0-9]{32}$/D',$v))throw new Problem('Invalid ID');return $v;}
class TestDB{public bool $tx=false;function beginTransaction():void{$this->tx=true;}function inTransaction():bool{return $this->tx;}function commit():void{$this->tx=false;}function rollBack():void{$this->tx=false;}}
function db():TestDB{static $d;return $d??=new TestDB;}
$GLOBALS['queries']=[];$GLOBALS['job']=['id'=>str_repeat('a',32),'status'=>'running','started_at'=>1];$GLOBALS['items']=[];$GLOBALS['pin']='';
function query(string $sql,array $params=[]):object{
 $GLOBALS['queries'][]=[$sql,$params];
 if(str_contains($sql,"status=CASE WHEN status='running' THEN 'needs_attention'"))$GLOBALS['job']['status']='needs_attention';
 if(str_starts_with($sql,'UPDATE tz_verification_items SET status='))$GLOBALS['items']=[];
 return new class{function rowCount():int{return 1;}};
}
function one(string $sql,array $params=[]):?array{
 if(str_contains($sql,'FROM tz_self_verification_jobs'))return ['job_id'=>$GLOBALS['job']['id'],'config_hash'=>$GLOBALS['pin']];
 if(str_contains($sql,'FROM tz_verification_jobs'))return $GLOBALS['job'];
 if(str_contains($sql,'COUNT(*) n'))return ['n'=>count($GLOBALS['items']),'due'=>time()+60];
 throw new \RuntimeException('Unexpected SQL fixture: '.$sql);
}
function rows(string $sql,array $params=[]):array{
 if(str_contains($sql,'FROM tz_verification_items'))return $GLOBALS['items'];
 throw new \RuntimeException('Unexpected rows fixture');
}
function audit(string $a,string $b,string $c='worker'):void{}
require dirname(__DIR__).'/app/SelfVerifier.php';
$pass=0;$fail=0;
function check(string $name,callable $test):void{global $pass,$fail;try{$test();$pass++;echo "PASS $name\n";}catch(\Throwable $e){$fail++;echo 'FAIL '.$name.': '.$e->getMessage()."\n";}}
function eq(mixed $a,mixed $b):void{if($a!==$b)throw new \RuntimeException(var_export($a,true).' != '.var_export($b,true));}
function reject(callable $fn):void{try{$fn();}catch(\Throwable){return;}throw new \RuntimeException('Expected rejection');}
$good=fn($email)=>['email'=>$email,'engine'=>'sendzad','engine_version'=>'1.0.0','category'=>'valid','reason'=>'recipient_accepted_non_catch_all','checked_at'=>time(),'retryable'=>false,'syntax'=>'valid','mail_route'=>'present','smtp'=>'accepted','catch_all'=>false,'role_account'=>false,'disposable'=>'not_assessed','spam_trap'=>'not_assessed','cached'=>false];
$original=$GLOBALS['cfg'];$address='Member+tag@company.test';
check('configuration canonical origin',function()use($original){$GLOBALS['cfg']['self_verifier_url']='https://VERIFY.example.test/';eq(self_config()['url'],'https://verify.example.test');$GLOBALS['cfg']=$original;});
foreach(['http://verify.example.test','https://127.0.0.1','https://verify.internal','https://x:y@verify.example.test','https://verify.example.test/path','https://verify.example.test?token=x','https://verify.example.test:8095'] as $url)check('reject endpoint '.$url,function()use($url,$original){$GLOBALS['cfg']['self_verifier_url']=$url;reject(fn()=>self_config());$GLOBALS['cfg']=$original;});
check('token rotation changes fingerprint',function()use($original){$a=self_config()['hash'];$GLOBALS['cfg']['self_verifier_token'].='x';eq(self_config()['hash']===$a,false);$GLOBALS['cfg']=$original;});
check('private settings never reveal token',function()use($original){$r=self_api_route('self/settings','GET',[]);eq($r['configured'],true);eq(str_contains(json_encode($r),$original['self_verifier_token']),false);});
check('connection check is POST only',fn()=>reject(fn()=>self_api_route('self/check','GET',[])));
check('health uses bearer token and no origin',function(){self_health(function($url,$body,$headers){eq($url,'https://verify.example.test/v1/health');eq($body,null);eq(count($headers),1);eq(str_starts_with($headers[0],'Authorization: Bearer '),true);return ['data'=>['engine'=>'sendzad','smtp_enabled'=>true,'paid_fallback'=>false,'max_batch'=>4,'engine_version'=>'1.0.0']];});});
check('health rejects SMTP disabled',fn()=>reject(fn()=>self_health(fn()=>['data'=>['engine'=>'sendzad','smtp_enabled'=>false,'paid_fallback'=>false,'max_batch'=>4,'engine_version'=>'1.0.0']])));
check('valid evidence accepted exactly',function()use($good,$address){$r=self_results(['engine'=>'sendzad','results'=>[$good($address)]],[$address]);eq($r[$address]['category'],'valid');});
foreach(['catch_all'=>true,'smtp'=>'unknown','spam_trap'=>'safe','reason'=>'<script>','checked_at'=>1,'retry_after_seconds'=>'x','cached'=>null] as $key=>$value)check('reject inconsistent '.$key,function()use($good,$address,$key,$value){$r=$good($address);$r[$key]=$value;reject(fn()=>self_results(['engine'=>'sendzad','results'=>[$r]],[$address]));});
check('missing, duplicate and extra results rejected',function()use($good,$address){foreach([[],[$good($address),$good($address)],[$good('other@company.test')]] as $r)reject(fn()=>self_results(['engine'=>'sendzad','results'=>$r],[$address]));});
check('unknown is not invalid',function()use($good,$address){$r=$good($address);$r['category']='unknown';$r['reason']='temporary_failure';$r['retryable']=true;eq(self_results(['engine'=>'sendzad','results'=>[$r]],[$address])[$address]['category'],'unknown');});
check('bare positive category cannot bypass catch-all evidence',function()use($address){reject(fn()=>self_results(['engine'=>'sendzad','results'=>[['email'=>$address,'category'=>'valid']]],[$address]));});
check('pause needs no network',function(){$GLOBALS['queries']=[];$GLOBALS['job']['status']='running';self_control_verification(['id'=>$GLOBALS['job']['id'],'action'=>'pause'],fn()=>throw new \RuntimeException('Network prohibited'));eq(count($GLOBALS['queries']),1);});
check('start needs explicit permission',fn()=>reject(fn()=>self_control_verification(['id'=>$GLOBALS['job']['id'],'action'=>'start'],fn()=>throw new \RuntimeException('Network prohibited'))));
$setup=function()use($address){$GLOBALS['queries']=[];$GLOBALS['job']['status']='running';$GLOBALS['pin']=self_config()['hash'];$GLOBALS['items']=[['id'=>1,'contact_id'=>2,'email'=>$address,'attempts'=>0,'deferrals'=>0]];};
check('worker persists positive evidence without consent/suppression updates',function()use($setup,$good){$setup();$r=self_advance_locked($GLOBALS['job'],function($url,$body,$headers)use($good){eq($url,'https://verify.example.test/v1/verify');eq(count($body['emails']),1);return ['data'=>['engine'=>'sendzad','results'=>array_map($good,$body['emails'])]];});eq($r['advanced'],1);foreach($GLOBALS['queries'] as [$sql]){eq(str_contains($sql,'suppressed='),false);eq(str_contains($sql,'consent='),false);eq(str_contains($sql,'key_cipher'),false);}});
check('invalid response leaves pending and requests attention',function()use($setup){$setup();$r=self_advance_locked($GLOBALS['job'],fn()=>['data'=>['engine'=>'sendzad','results'=>[]]]);eq($r['advanced'],0);eq(count($GLOBALS['items']),1);eq($GLOBALS['job']['status'],'needs_attention');});
check('changed endpoint cannot receive a saved job',function()use($setup,$original){$setup();$GLOBALS['cfg']['self_verifier_token'].='x';$called=false;self_advance_locked($GLOBALS['job'],function()use(&$called){$called=true;return [];});eq($called,false);eq(count($GLOBALS['items']),1);$GLOBALS['cfg']=$original;});
check('temporary response stores retry rather than invalid result',function()use($setup,$good,$address){$setup();$result=$good($address);$result['category']='unknown';$result['reason']='temporary_failure';$result['retryable']=true;$result['retry_after_seconds']=60;$r=self_advance_locked($GLOBALS['job'],fn()=>['data'=>['engine'=>'sendzad','results'=>[$result]]]);eq($r['advanced'],0);eq(count($GLOBALS['items']),1);});
check('third temporary failure completes as unknown',function()use($setup,$good,$address){$setup();$GLOBALS['items'][0]['attempts']=2;$result=$good($address);$result['category']='unknown';$result['reason']='temporary_failure';$result['retryable']=true;$r=self_advance_locked($GLOBALS['job'],fn()=>['data'=>['engine'=>'sendzad','results'=>[$result]]]);eq($r['advanced'],1);$status=null;foreach($GLOBALS['queries'] as [$sql,$args])if(str_starts_with($sql,'UPDATE tz_verification_items SET status='))$status=$args[0];eq($status,'unknown');});
echo json_encode(['passed'=>$pass,'failed'=>$fail,'scope'=>'contracts and simulated PHP transitions; not MySQL or remote service acceptance'])."\n";
exit($fail?1:0);
