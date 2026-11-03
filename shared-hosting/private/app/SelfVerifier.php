<?php
declare(strict_types=1);
namespace Sendzad;

/** Only installation-controlled destinations; contacts/browser requests cannot set endpoints. */
function self_config(): array {
    $c=config();
    $url=(string)($c['self_verifier_url']??getenv('SENDZAD_VERIFIER_URL')?:'');
    $token=(string)($c['self_verifier_token']??getenv('SENDZAD_VERIFIER_TOKEN')?:'');
    $u=parse_url($url);
    if(!$u||($u['scheme']??'')!=='https'||empty($u['host'])||isset($u['user'])||isset($u['pass'])||isset($u['query'])||isset($u['fragment'])||(isset($u['port'])&&$u['port']!==443)||!in_array($u['path']??'',['','/'],true)||!preg_match('/^[\x21-\x7e]{32,256}$/D',$token))throw new Problem('Configure the private Sendzad verifier HTTPS URL and token.',409);
    $host=strtolower($u['host']);
    if(!preg_match('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/D',$host)||filter_var($host,FILTER_VALIDATE_IP)||preg_match('/(?:^|\.)(localhost|local|internal)$/D',$host))throw new Problem('Use a dedicated HTTPS verifier hostname.',409);
    $url='https://'.$host;
    return ['url'=>$url,'token'=>$token,'hash'=>hash('sha256',$url."\n".$token)];
}
function self_job(string $id): ?array { return one('SELECT * FROM tz_self_verification_jobs WHERE job_id=?',[$id]); }
function self_request(array $c,string $path,?array $body=null,?callable $fetcher=null): array {
    $fetcher??=__NAMESPACE__.'\\fetch_json';
    // Existing transport preserves configured HTTPS_PROXY/NO_PROXY, verifies TLS,
    // refuses redirects and never forwards a browser Origin or cookie.
    return $fetcher($c['url'].$path,$body,['Authorization: Bearer '.$c['token']]);
}
function self_health(?callable $fetcher=null): array {
    $r=self_request(self_config(),'/v1/health',null,$fetcher)['data'];
    if(($r['engine']??'')!=='sendzad'||($r['smtp_enabled']??false)!==true||($r['paid_fallback']??true)!==false||($r['max_batch']??0)!==4||!preg_match('/^[0-9]+\.[0-9]+\.[0-9]+$/D',(string)($r['engine_version']??'')))throw new Problem('The Sendzad verifier is not ready for SMTP checks. No paid fallback was used.',409);
    return ['engine'=>'sendzad','configured'=>true,'version'=>$r['engine_version'],'paid_fallback'=>false,'acceptance_tested'=>false];
}
function self_results(array $reply,array $expected): array {
    if(($reply['engine']??'')!=='sendzad'||!is_array($reply['results']??null)||count($reply['results'])!==count($expected))throw new Problem('Incomplete self-verifier response.',502);
    $mapped=[];
    foreach($reply['results'] as $r){
        if(!is_array($r)||!is_string($r['email']??null)||!in_array($r['email'],$expected,true)||isset($mapped[$r['email']]))throw new Problem('Mismatched or duplicate result identities.',502);
        if(($r['engine']??'')!=='sendzad'||!preg_match('/^[0-9]+\.[0-9]+\.[0-9]+$/D',(string)($r['engine_version']??''))||!in_array($r['category']??'', ['valid','invalid','risky','unknown'],true)||!is_bool($r['retryable']??null)||!is_bool($r['cached']??null)||!preg_match('/^[a-z_]{1,100}$/D',(string)($r['reason']??''))||!is_int($r['checked_at']??null)||$r['checked_at']>time()+300||$r['checked_at']<time()-86400||($r['spam_trap']??'')!=='not_assessed')throw new Problem('Invalid self-verifier evidence.',502);
        if(isset($r['retry_after_seconds'])&&(!is_int($r['retry_after_seconds'])||$r['retry_after_seconds']<0||$r['retry_after_seconds']>3600))throw new Problem('Invalid retry interval.',502);
        if($r['category']==='valid'&&(($r['syntax']??'')!=='valid'||($r['mail_route']??'')!=='present'||($r['smtp']??'')!=='accepted'||($r['catch_all']??null)!==false||($r['role_account']??null)!==false||!in_array($r['disposable']??'', ['not_listed','not_assessed'],true)||$r['reason']!=='recipient_accepted_non_catch_all'||$r['retryable']))throw new Problem('Positive result lacks mailbox evidence.',502);
        if($r['category']==='invalid'&&(!in_array($r['reason'],['invalid_syntax','null_mx','no_mail_route','recipient_rejected'],true)||($r['reason']==='invalid_syntax'&&($r['syntax']??'')!=='invalid')||($r['reason']==='recipient_rejected'&&(($r['stage']??'')!=='rcpt_to'||($r['smtp']??'')!=='absent'||!is_int($r['smtp_code']??null)||$r['smtp_code']<500||$r['smtp_code']>=600))))throw new Problem('Permanent failure was not established.',502);
        if($r['category']!=='unknown'&&$r['retryable'])throw new Problem('Contradictory result.',502);
        $mapped[$r['email']]=$r;
    }
    foreach($expected as $address)if(!isset($mapped[$address]))throw new Problem('Missing result.',502);
    return $mapped;
}
function self_control_verification(array $in,?callable $fetcher=null): void {
    $id=ident($in['id']??'');$action=$in['action']??'';
    if(!self_job($id))throw new Problem('Self-hosted job not found.',404);
    if(!in_array($action,['start','resume','pause'],true))throw new Problem('Unsupported verification action.');
    if($action!=='pause'){
        if($action==='start'&&($in['provider_consent']??false)!==true)throw new Problem('Confirm permission to verify this list on your server.');
        $cfg=self_config();self_health($fetcher);
        if($action==='resume'&&!hash_equals(self_job($id)['config_hash']??'',$cfg['hash']))throw new Problem('Verifier connection changed. Restore it or create a new job.',409);
    }
    db()->beginTransaction();
    try{
        $j=one('SELECT * FROM tz_verification_jobs WHERE id=? FOR UPDATE',[$id]);if(!$j)throw new Problem('Job not found.',404);
        if($action==='pause'&&$j['status']==='running')query("UPDATE tz_verification_jobs SET status='paused',updated_at=? WHERE id=?",[time(),$id]);
        elseif($action==='start'&&$j['status']==='ready'){
            query('UPDATE tz_self_verification_jobs SET config_hash=? WHERE job_id=?',[$cfg['hash'],$id]);
            query("UPDATE tz_verification_jobs SET status='running',started_at=?,updated_at=?,next_at=0,last_error=NULL WHERE id=?",[time(),time(),$id]);
        }elseif($action==='resume'&&$j['started_at']!==null&&in_array($j['status'],['paused','needs_attention'],true))query("UPDATE tz_verification_jobs SET status='running',next_at=0,updated_at=?,last_error=NULL WHERE id=?",[time(),$id]);
        else throw new Problem('This action is not available.',409);
        audit('self_verification_'.$action,$id,'admin');db()->commit();
    }catch(\Throwable $e){if(db()->inTransaction())db()->rollBack();throw $e;}
}
/** The existing verification advisory lock is held by the caller. */
function self_advance_locked(array $j,?callable $fetcher=null): array {
    $id=$j['id'];
    try{
        $cfg=self_config();if(!hash_equals(self_job($id)['config_hash']??'',$cfg['hash']))throw new Problem('Verifier connection changed.',409);
        $items=rows("SELECT i.*,c.email,COALESCE(s.attempts,0) attempts,COALESCE(s.deferrals,0) deferrals FROM tz_verification_items i JOIN tz_contacts c ON c.id=i.contact_id LEFT JOIN tz_self_verification_results s ON s.item_id=i.id WHERE i.job_id=? AND i.status='pending' AND COALESCE(s.next_at,0)<=? ORDER BY i.id LIMIT 4",[$id,time()]);
        if(!$items){
            $left=one("SELECT COUNT(*) n,MIN(s.next_at) due FROM tz_verification_items i LEFT JOIN tz_self_verification_results s ON s.item_id=i.id WHERE i.job_id=? AND i.status='pending'",[$id]);
            if(!(int)$left['n'])query("UPDATE tz_verification_jobs SET status='completed',updated_at=?,last_error=NULL WHERE id=? AND status='running'",[time(),$id]);
            else query('UPDATE tz_verification_jobs SET next_at=?,updated_at=? WHERE id=?',[(int)$left['due'],time(),$id]);
            return ['advanced'=>0];
        }
        if((one('SELECT status FROM tz_verification_jobs WHERE id=?',[$id])['status']??'')!=='running')return ['advanced'=>0];
        $reply=self_request($cfg,'/v1/verify',['emails'=>array_column($items,'email')],$fetcher);
        $results=self_results($reply['data'],array_column($items,'email'));
        db()->beginTransaction();$fresh=one('SELECT status FROM tz_verification_jobs WHERE id=? FOR UPDATE',[$id]);
        if(!$fresh||!in_array($fresh['status'],['running','paused'],true)){db()->rollBack();return ['advanced'=>0];}
        $finished=0;
        foreach($items as $item){
            $r=$results[$item['email']];$cooldown=$r['reason']==='provider_cooldown';
            $attempts=(int)$item['attempts']+($cooldown?0:1);$deferrals=(int)$item['deferrals']+($cooldown?1:0);
            $retry=$r['retryable']&&$attempts<3&&$deferrals<30;$next=$retry?time()+max(60,$r['retry_after_seconds']??60):0;
            query('INSERT INTO tz_self_verification_results(item_id,attempts,deferrals,next_at,reason,evidence) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE attempts=VALUES(attempts),deferrals=VALUES(deferrals),next_at=VALUES(next_at),reason=VALUES(reason),evidence=VALUES(evidence)',[$item['id'],$attempts,$deferrals,$next,$r['reason'],json_encode($r,JSON_THROW_ON_ERROR)]);
            if(!$retry){
                query("UPDATE tz_verification_items SET status=?,checked_at=? WHERE id=? AND status='pending'",[$r['category'],$r['checked_at'],$item['id']]);
                query('UPDATE tz_contacts SET verification=?,verified_at=? WHERE id=? AND (verified_at IS NULL OR verified_at<=?)',[$r['category'],$r['checked_at'],$item['contact_id'],$r['checked_at']]);$finished++;
            }
        }
        $remaining=(int)one("SELECT COUNT(*) n FROM tz_verification_items WHERE job_id=? AND status='pending'",[$id])['n'];
        query("UPDATE tz_verification_jobs SET status=CASE WHEN ?=0 THEN 'completed' ELSE status END,next_at=?,last_error=NULL,updated_at=? WHERE id=? AND status IN('running','paused')",[$remaining,time()+2,time(),$id]);db()->commit();return ['advanced'=>$finished];
    }catch(\Throwable){
        if(db()->inTransaction())db()->rollBack();
        $message='Self-verification paused. Check the service and saved progress. No Reoon credits were used.';
        query("UPDATE tz_verification_jobs SET status=CASE WHEN status='running' THEN 'needs_attention' ELSE status END,last_error=?,updated_at=? WHERE id=?",[$message,time(),$id]);return ['advanced'=>0,'attention'=>$message];
    }
}
/** Invoked only after existing administrator authentication and CSRF verification. */
function self_api_route(string $route,string $method,array $in): ?array {
    if($route==='self/settings'&&$method==='GET'){
        try{$cfg=self_config();$url=$cfg['url'];$ready=true;}catch(Problem){$url='';$ready=false;}
        return ['engine'=>'sendzad','configured'=>$ready,'service_url'=>$url,'default_engine'=>'sendzad','paid_fallback'=>false];
    }
    if($route==='self/check'){
        if($method!=='POST')throw new Problem('Use POST.',405);
        return self_health();
    }
    if($route==='jobs'&&$method==='GET'){
        $jobs=job_list();$ids=array_column($jobs,'id');$self=[];
        if($ids){$r=rows('SELECT job_id FROM tz_self_verification_jobs WHERE job_id IN ('.implode(',',array_fill(0,count($ids),'?')).')',$ids);$self=array_fill_keys(array_column($r,'job_id'),true);}
        foreach($jobs as &$j)$j['engine']=isset($self[$j['id']])?'sendzad':'reoon';unset($j);
        return ['items'=>$jobs];
    }
    return null;
}
