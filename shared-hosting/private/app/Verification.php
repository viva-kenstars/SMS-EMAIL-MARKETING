<?php
declare(strict_types=1);
namespace Sendzad;
function verification_verdict(array $r,string $address): string {
    if(email($r['email']??'')!==$address)return 'unknown';
    $status=$r['status']??'unknown';
    if(in_array($status,['invalid','disabled'],true))return 'invalid';
    if(in_array($status,['disposable','inbox_full','catch_all','role_account','spamtrap'],true))return 'risky';
    foreach(['is_disposable','is_role_account','has_inbox_full','is_catch_all','is_spamtrap']as $flag)if(($r[$flag]??null)===true)return 'risky';
    if($status!=='safe')return 'unknown';
    foreach(['is_safe_to_send','is_deliverable']as $flag)if(($r[$flag]??null)!==true)return 'unknown';
    foreach(['is_disposable','is_role_account','has_inbox_full','is_catch_all','is_disabled','is_spamtrap']as $flag)if(($r[$flag]??null)!==false)return 'unknown';
    return 'valid';
}
function create_verification(array $in): array {
    $gid=ident($in['group_id']??'');$name=text($in['name']??'',120);
    if(!$name||!one('SELECT id FROM tz_groups WHERE id=?',[$gid]))throw new Problem('Choose a group and name this check.');
    $id=uid();db()->beginTransaction();
    try{
        query('INSERT INTO tz_verification_jobs(id,name,created_at,updated_at) VALUES(?,?,?,?)',[$id,$name,time(),time()]);
        query("INSERT INTO tz_verification_items(job_id,contact_id) SELECT ?,c.id FROM tz_contacts c JOIN tz_members m ON m.contact_id=c.id WHERE m.group_id=? AND c.suppressed=0",[$id,$gid]);
        if(!(int)one('SELECT COUNT(*) n FROM tz_verification_items WHERE job_id=?',[$id])['n'])throw new Problem('This group has no available contacts.');
        db()->commit();return ['id'=>$id,'status'=>'ready'];
    }catch(\Throwable $e){db()->rollBack();throw $e;}
}
function control_verification(array $in): void {
    $id=ident($in['id']??'');$action=$in['action']??'';
    if(!in_array($action,['start','pause','resume'],true))throw new Problem('Unsupported verification action.');
    db()->beginTransaction();
    try{
        $j=one('SELECT * FROM tz_verification_jobs WHERE id=? FOR UPDATE',[$id]);if(!$j)throw new Problem('Check not found.',404);
        if($action==='pause'&&$j['status']==='running')query("UPDATE tz_verification_jobs SET status='paused',updated_at=? WHERE id=?",[time(),$id]);
        elseif($action==='resume'&&$j['status']==='paused')query("UPDATE tz_verification_jobs SET status='running',next_at=0,updated_at=? WHERE id=?",[time(),$id]);
        elseif($action==='start'&&$j['status']==='ready'){
            if(($in['provider_consent']??false)!==true)throw new Problem('Confirm permission to share these addresses with Reoon.');
            $stored=setting('reoon_key');if(!$stored)throw new Problem('Add a Reoon API key in Settings.');
            $key=unseal($stored,'reoon');
            query("UPDATE tz_verification_jobs SET status='running',key_cipher=?,started_at=?,updated_at=?,next_at=0 WHERE id=?",[seal($key,'verification:'.$id),time(),time(),$id]);
        }else throw new Problem('This action is not available. Interrupted submissions require review.',409);
        audit('verification_'.$action,$id,'admin');db()->commit();
    }catch(\Throwable $e){db()->rollBack();throw $e;}
}
function finish_verification_batch(array $j,array $batch,array $items,array $results): void {
    $mapped=[];$duplicates=[];
    foreach($results as $value){if(!is_array($value))continue;$address=email($value['email']??'');if(!$address)continue;if(isset($mapped[$address]))$duplicates[$address]=true;$mapped[$address]=$value;}
    db()->beginTransaction();
    try{
        foreach($items as $item){
            $verdict=isset($duplicates[$item['email']])?'unknown':verification_verdict($mapped[$item['email']]??[],$item['email']);
            query('UPDATE tz_verification_items SET status=?,checked_at=? WHERE id=?',[$verdict,time(),$item['id']]);
            query('UPDATE tz_contacts SET verification=?,verified_at=? WHERE id=?',[$verdict,time(),$item['contact_id']]);
        }
        query("UPDATE tz_verification_batches SET status='completed' WHERE id=?",[$batch['id']]);
        $remaining=(int)one("SELECT COUNT(*) n FROM tz_verification_items WHERE job_id=? AND status IN('pending','processing')",[$j['id']])['n'];
        query("UPDATE tz_verification_jobs SET status=CASE WHEN ?=0 THEN 'completed' ELSE status END,next_at=?,updated_at=? WHERE id=? AND status IN('running','paused')",[$remaining,time()+5,time(),$j['id']]);
        db()->commit();
    }catch(\Throwable $e){db()->rollBack();throw $e;}
}
function advance_verification(?callable $fetcher=null): array {
    $fetcher??=__NAMESPACE__.'\\fetch_json';
    return with_worker_lock('verification',function()use($fetcher){
        set_setting('verification_heartbeat',(string)time());
        $j=one("SELECT * FROM tz_verification_jobs WHERE status='running' AND started_at IS NOT NULL AND next_at<=? ORDER BY updated_at LIMIT 1",[time()]);
        if(!$j)return ['advanced'=>0];
        $key=unseal($j['key_cipher'],'verification:'.$j['id']);$batch=one("SELECT * FROM tz_verification_batches WHERE job_id=? AND status IN('submitting','polling') ORDER BY created_at LIMIT 1",[$j['id']]);
        if($batch&&$batch['status']==='submitting'){
            query("UPDATE tz_verification_jobs SET status='needs_attention',last_error='Submission interrupted. Review the task in Reoon before retrying.',updated_at=? WHERE id=?",[time(),$j['id']]);
            query("UPDATE tz_verification_batches SET status='unknown' WHERE id=?",[$batch['id']]);
            query("UPDATE tz_verification_items SET status='unknown' WHERE batch_id=?",[$batch['id']]);return ['advanced'=>0];
        }
        try{
            if($batch){
                $reply=$fetcher('https://emailverifier.reoon.com/api/v1/get-result-bulk-verification-task/?'.http_build_query(['key'=>$key,'task_id'=>$batch['remote_id']]));$data=$reply['data'];
                if((string)($data['task_id']??'')!==$batch['remote_id'])throw new Problem('The provider returned a different task ID.',502);
                if(($data['status']??'')==='completed'){
                    if(!is_array($data['results']??null))throw new Problem('Verification results were not confirmed.',502);
                    $items=rows('SELECT i.*,c.email FROM tz_verification_items i JOIN tz_contacts c ON c.id=i.contact_id WHERE i.batch_id=?',[$batch['id']]);
                    finish_verification_batch($j,$batch,$items,array_values($data['results']));return ['advanced'=>count($items)];
                }
                if(!in_array($data['status']??'', ['waiting','running','processing'],true))throw new Problem('Verification task needs provider review.',502);
                query('UPDATE tz_verification_jobs SET next_at=?,updated_at=? WHERE id=?',[time()+30,time(),$j['id']]);return ['advanced'=>0];
            }
            $items=rows("SELECT i.*,c.email FROM tz_verification_items i JOIN tz_contacts c ON c.id=i.contact_id WHERE i.job_id=? AND i.status='pending' ORDER BY i.id LIMIT 500",[$j['id']]);
            if(!$items){query("UPDATE tz_verification_jobs SET status='completed',updated_at=? WHERE id=? AND status='running'",[time(),$j['id']]);return ['advanced'=>0];}
            // Bulk minimum is ten. Use Power for a genuinely small remainder.
            if(count($items)<10)$items=array_slice($items,0,1);
            $bid=uid();db()->beginTransaction();
            $fresh=one('SELECT status FROM tz_verification_jobs WHERE id=? FOR UPDATE',[$j['id']]);
            if($fresh['status']!=='running'){db()->rollBack();return ['advanced'=>0];}
            query("INSERT INTO tz_verification_batches(id,job_id,status,created_at) VALUES(?,?,'submitting',?)",[$bid,$j['id'],time()]);
            foreach($items as $item)query("UPDATE tz_verification_items SET batch_id=?,status='processing' WHERE id=? AND status='pending'",[$bid,$item['id']]);
            db()->commit();$batch=['id'=>$bid];
            if(count($items)===1){
                $reply=$fetcher('https://emailverifier.reoon.com/api/v1/verify?'.http_build_query(['key'=>$key,'email'=>$items[0]['email'],'mode'=>'power']));
                if(($reply['data']['verification_mode']??'')!=='power')throw new Problem('Power verification was not confirmed.',502);
                finish_verification_batch($j,$batch,$items,[$reply['data']]);return ['advanced'=>1];
            }
            $reply=$fetcher('https://emailverifier.reoon.com/api/v1/create-bulk-verification-task/',['key'=>$key,'emails'=>array_column($items,'email'),'name'=>'SZ-'.substr($bid,0,20)]);$data=$reply['data'];
            if($reply['status']!==201||($data['status']??'')!=='success'||!preg_match('/^[A-Za-z0-9_-]{1,128}$/D',(string)($data['task_id']??'')))throw new Problem('Task creation was not confirmed. Check Reoon history before retrying.',502);
            query("UPDATE tz_verification_batches SET remote_id=?,status='polling' WHERE id=?",[(string)$data['task_id'],$bid]);
            query('UPDATE tz_verification_jobs SET next_at=?,updated_at=? WHERE id=?',[time()+20,time(),$j['id']]);return ['advanced'=>0,'submitted'=>count($items)];
        }catch(\Throwable $e){
            if(db()->inTransaction())db()->rollBack();
            $message=$e instanceof Problem?$e->getMessage():'Verification paused. Check the saved task and provider account.';
            $last=isset($batch['id'])?one('SELECT status FROM tz_verification_batches WHERE id=?',[$batch['id']]):null;
            // Polling reads can retry without purchasing the same verification again.
            if($last&&$last['status']==='polling')query('UPDATE tz_verification_jobs SET last_error=?,next_at=?,updated_at=? WHERE id=?',[$message,time()+300,time(),$j['id']]);
            else{
                query("UPDATE tz_verification_jobs SET status='needs_attention',last_error=?,updated_at=? WHERE id=?",[$message,time(),$j['id']]);
                if(isset($batch['id'])){query("UPDATE tz_verification_batches SET status='unknown' WHERE id=?",[$batch['id']]);query("UPDATE tz_verification_items SET status='unknown' WHERE batch_id=?",[$batch['id']]);}
            }
            return ['advanced'=>0,'attention'=>$message];
        }
    });
}
function add_verified_to_group(array $in): array {
    $job=ident($in['job_id']??'');$gid=ident($in['group_id']??'');
    if(!one("SELECT id FROM tz_verification_jobs WHERE id=? AND status='completed'",[$job]))throw new Problem('Complete verification before adding valid contacts.');
    if(!one('SELECT id FROM tz_groups WHERE id=?',[$gid]))throw new Problem('Group not found.',404);
    $q=query("INSERT IGNORE INTO tz_members(group_id,contact_id) SELECT ?,i.contact_id FROM tz_verification_items i JOIN tz_contacts c ON c.id=i.contact_id WHERE i.job_id=? AND i.status='valid' AND c.verification='valid' AND c.suppressed=0",[$gid,$job]);
    return ['added'=>$q->rowCount()];
}
