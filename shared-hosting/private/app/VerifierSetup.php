<?php
declare(strict_types=1);
namespace Sendzad;

/** Administrator-only connection configuration; never accepts contact or browser input. */
final class VerifierSetupProblem extends \RuntimeException {
    public function __construct(public string $reason, string $message, public int $status=409) { parent::__construct($message); }
}
function verifier_config_values(array $c, ?callable $environment=null): array {
    $environment??=static fn(string $name)=>getenv($name);
    $value=static function(string $key,string $env,string $default='')use($c,$environment): string {
        $v=$c[$key]??'';
        if(!is_string($v))throw new VerifierSetupProblem('invalid_configuration','Verifier configuration values must be strings.');
        if($v===''){$v=$environment($env);if($v===false||$v===null||$v==='')$v=$default;}
        if(!is_string($v))throw new VerifierSetupProblem('invalid_configuration','Verifier configuration values must be strings.');
        return $v;
    };
    $mode=$value('self_verifier_mode','SENDZAD_VERIFIER_MODE','remote');
    if(!in_array($mode,['remote','local'],true))throw new VerifierSetupProblem('invalid_mode','Choose local or remote for the private verifier mode.');
    $url=$value('self_verifier_url','SENDZAD_VERIFIER_URL');
    if($mode==='local'){
        // Explicit same-machine mode only. No hostname lookup, alternate port or LAN address.
        if($url==='')$url='http://127.0.0.1:8095';
        if(!in_array($url,['http://127.0.0.1:8095','http://127.0.0.1:8095/'],true))throw new VerifierSetupProblem('invalid_local_url','Local mode accepts only http://127.0.0.1:8095. Use remote mode for another server.');
        $url='http://127.0.0.1:8095';
    }else{
        if($url==='')throw new VerifierSetupProblem('missing_url','Set SENDZAD_VERIFIER_URL for a remote server, or explicitly choose local mode on a compatible PHP server.');
        if(!preg_match('~^https://([a-z0-9.-]+)(?::443)?/?$~iD',$url,$m))throw new VerifierSetupProblem('invalid_url','Use a dedicated HTTPS verifier origin without credentials, paths, query strings or fragments.');
        $host=strtolower($m[1]);
        if(strlen($host)>253||!preg_match('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/D',$host)||preg_match('/^[0-9.]+$/D',$host)||preg_match('/(?:^|\.)(localhost|local|internal)$/D',$host))throw new VerifierSetupProblem('invalid_url','Use a dedicated HTTPS verifier hostname.');
        $url='https://'.$host;
    }
    $token=$value('self_verifier_token','SENDZAD_VERIFIER_TOKEN');
    if($token==='')throw new VerifierSetupProblem('missing_token','Set the private SENDZAD_VERIFIER_TOKEN to match the Go service token.');
    if(!preg_match('/^[\x21-\x7e]{32,256}$/D',$token))throw new VerifierSetupProblem('invalid_token','The private verifier token must contain 32 to 256 printable characters without spaces.');
    return ['mode'=>$mode,'url'=>$url,'token'=>$token,'hash'=>hash('sha256',$url."\n".$token)];
}
/** No credentials or fingerprints are returned to the UI or diagnostics. */
function verifier_setup_status(array $c, ?callable $environment=null): array {
    $out=['engine'=>'sendzad','configured'=>false,'service_url'=>'','default_engine'=>'sendzad','paid_fallback'=>false,'state'=>'setup_required','acceptance_tested'=>false];
    try{$cfg=verifier_config_values($c,$environment);return array_replace($out, ['configured'=>true,'service_url'=>$cfg['url'],'mode'=>$cfg['mode'],'state'=>'configured_unchecked','message'=>'Connection configured; test the service, then run controlled mailbox acceptance.']);}
    catch(VerifierSetupProblem $e){$out['issue']=$e->reason;$out['message']=$e->getMessage();return $out;}
}
/** Fail closed rather than silently routing a loopback token through a proxy. */
function verifier_local_proxy_ready(?callable $environment=null): bool {
    $environment??=static fn(string $name)=>getenv($name);
    $proxy=false;foreach(['http_proxy','HTTP_PROXY','all_proxy','ALL_PROXY'] as $name)if($environment($name))$proxy=true;
    if(!$proxy)return true;
    $noProxy=$environment('no_proxy')?:$environment('NO_PROXY')?:'';
    foreach(explode(',',(string)$noProxy)as $entry)if(in_array(trim($entry),['127.0.0.1','*'],true))return true;
    return false;
}
function verifier_http_reply(int $status,string $type,string $raw): array {
    if($status===401||$status===403)throw new VerifierSetupProblem('authentication_failed','Verifier authentication failed. Check the matching private token.',502);
    if($status===429)throw new VerifierSetupProblem('rate_limited','Verifier rate limit reached. Pending work is retained; no paid fallback was used.',503);
    if($status<200||$status>=300)throw new VerifierSetupProblem('http_failure','Verifier request failed or redirected. No results were accepted.',502);
    if(strtolower(trim(explode(';',$type,2)[0]))!=='application/json'||strlen($raw)>32768)throw new VerifierSetupProblem('invalid_response','Verifier returned an invalid or oversized response.',502);
    try{$data=json_decode($raw,true,32,JSON_THROW_ON_ERROR);}catch(\Throwable){throw new VerifierSetupProblem('invalid_response','Verifier returned invalid JSON.',502);}
    if(!is_array($data)||array_is_list($data))throw new VerifierSetupProblem('invalid_response','Verifier must return a JSON object.',502);
    return ['status'=>$status,'data'=>$data];
}
function verifier_http(array $c,string $path,?array $body=null): array {
    // Revalidate at the final boundary. Redirects and contacts cannot change the target.
    $c=verifier_config_values(['self_verifier_mode'=>$c['mode']??'remote','self_verifier_url'=>$c['url']??'','self_verifier_token'=>$c['token']??''],static fn()=>false);
    if(!in_array($path,['/v1/health','/v1/verify'],true)||($path==='/v1/health')!==($body===null))throw new VerifierSetupProblem('invalid_request','Unsupported verifier operation.');
    if(!extension_loaded('curl'))throw new VerifierSetupProblem('missing_curl','Enable the PHP cURL extension on the application server.',503);
    if($c['mode']==='local'&&!verifier_local_proxy_ready())throw new VerifierSetupProblem('local_proxy_policy','Local mode requires an approved NO_PROXY entry for 127.0.0.1. Existing proxy settings were not changed.',503);
    $payload=$body===null?null:json_encode($body,JSON_THROW_ON_ERROR);
    if($payload!==null&&strlen($payload)>4096)throw new VerifierSetupProblem('request_too_large','Use bounded verifier batches.',413);
    $raw='';$ch=curl_init($c['url'].$path);
    curl_setopt_array($ch,[CURLOPT_RETURNTRANSFER=>false,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>25,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_PROTOCOLS=>$c['mode']==='local'?CURLPROTO_HTTP:CURLPROTO_HTTPS,CURLOPT_HTTPHEADER=>array_merge(['Accept: application/json','Authorization: Bearer '.$c['token']],$body===null?[]:['Content-Type: application/json']),CURLOPT_WRITEFUNCTION=>static function($ch,string $chunk)use(&$raw):int{if(strlen($raw)+strlen($chunk)>32768)return 0;$raw.=$chunk;return strlen($chunk);}]);
    // libcurl retains HTTP(S)_PROXY / ALL_PROXY / NO_PROXY; no proxy is disabled here.
    if($payload!==null){curl_setopt($ch,CURLOPT_POST,true);curl_setopt($ch,CURLOPT_POSTFIELDS,$payload);}
    $ok=curl_exec($ch);$error=curl_errno($ch);$status=(int)curl_getinfo($ch,CURLINFO_RESPONSE_CODE);$type=(string)curl_getinfo($ch,CURLINFO_CONTENT_TYPE);curl_close($ch);
    if($ok===false){
        if($error===CURLE_OPERATION_TIMEDOUT)throw new VerifierSetupProblem('timeout','Verifier timed out. Pending work is retained.',503);
        if($error===CURLE_PEER_FAILED_VERIFICATION)throw new VerifierSetupProblem('tls_failed','Verifier TLS certificate validation failed.',503);
        throw new VerifierSetupProblem('unreachable','Verifier connection failed. Check the service and network; no paid fallback was used.',503);
    }
    return verifier_http_reply($status,$type,$raw);
}
