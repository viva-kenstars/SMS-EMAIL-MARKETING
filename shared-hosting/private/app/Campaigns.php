<?php
declare(strict_types=1);
namespace Sendzad;
function save_campaign(array $in): array {
    $id=isset($in['id'])?ident($in['id']):uid();
    $name=text($in['name']??'',120);$subject=text($in['subject']??'',200);
    if(!$name||!$subject)throw new Problem('Add a campaign name and subject.');
    $html=clean_html((string)($in['html']??''));$plain=text($in['text_body']??'',500000,true);
    if(!$html&&!$plain)throw new Problem('Add your message.');
    $preheader=text($in['preheader']??'',250);$opens=($in['track_opens']??false)===true?1:0;$clicks=($in['track_clicks']??false)===true?1:0;
    if(isset($in['id'])){
        $revision=integer($in['revision']??0,1,PHP_INT_MAX);
        $q=query("UPDATE tz_campaigns SET name=?,subject=?,preheader=?,html=?,text_body=?,track_opens=?,track_clicks=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=? AND status='draft'",[$name,$subject,$preheader,$html,$plain,$opens,$clicks,time(),$id,$revision]);
        if(!$q->rowCount())throw new Problem('This draft changed or has already launched. Reload before editing.',409);
    }else query('INSERT INTO tz_campaigns(id,name,subject,preheader,html,text_body,track_opens,track_clicks,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[$id,$name,$subject,$preheader,$html,$plain,$opens,$clicks,time(),time()]);
    return one('SELECT * FROM tz_campaigns WHERE id=?',[$id]);
}
function launch_campaign(array $in): array {
    $id=ident($in['id']??'');$groups=$in['group_ids']??[];$accounts=$in['account_ids']??[];
    if(($in['consent_confirmed']??false)!==true)throw new Problem('Confirm permission to contact this audience.');
    if(!is_array($groups)||!is_array($accounts)||!count($groups)||!count($accounts)||count($groups)>1000||count($accounts)>1000)throw new Problem('Choose contact groups and sending accounts.');
    $groups=array_values(array_unique(array_map(__NAMESPACE__.'\\ident',$groups)));$accounts=array_values(array_unique(array_map(__NAMESPACE__.'\\ident',$accounts)));
    if(!trim(setting('postal_address')))throw new Problem('Add your business postal address in Settings.');
    $interval=integer($in['interval_seconds']??5,1,86400);$due=integer($in['scheduled_at']??time(),0,4102444800);$due=max(time(),$due);
    db()->beginTransaction();
    try{
        $c=one('SELECT * FROM tz_campaigns WHERE id=? FOR UPDATE',[$id]);
        if(!$c||$c['status']!=='draft'||(int)$c['revision']!==(int)($in['revision']??0))throw new Problem('This campaign changed or is already launched.',409);
        assert_campaign_ready($c);
        set_setting('campaign_brand_'.$id,json_encode(brand_config(),JSON_THROW_ON_ERROR));
        foreach($accounts as $position=>$aid){
            $a=one('SELECT * FROM tz_accounts WHERE id=? FOR UPDATE',[$aid]);
            if(!$a||!$a['enabled']||!$a['verified_at'])throw new Problem('Choose only enabled, tested accounts.');
            query('INSERT INTO tz_campaign_accounts(campaign_id,account_id,position,generation) VALUES(?,?,?,?)',[$id,$aid,$position,$a['generation']]);
        }
        $placeholders=implode(',',array_fill(0,count($groups),'?'));
        // Generate a separate random-looking delivery ID in MySQL. Audience is frozen here.
        query("INSERT INTO tz_recipients(id,campaign_id,contact_id,email,name,created_at) SELECT REPLACE(UUID(),'-',''),?,c.id,c.email,c.name,? FROM tz_contacts c WHERE c.verification='valid' AND c.suppressed=0 AND c.consent=1 AND EXISTS(SELECT 1 FROM tz_members m WHERE m.contact_id=c.id AND m.group_id IN ($placeholders))",[$id,time(),...$groups]);
        $total=(int)one('SELECT COUNT(*) n FROM tz_recipients WHERE campaign_id=? AND is_test=0',[$id])['n'];
        if(!$total)throw new Problem('No verified, opted-in contacts are available in those groups.');
        query("UPDATE tz_campaigns SET status=?,interval_seconds=?,due_at=?,started_at=?,updated_at=?,revision=revision+1 WHERE id=?",[$due>time()?'scheduled':'running',$interval,$due,time(),time(),$id]);
        audit('campaign_launch',$id,'admin');db()->commit();
        return ['id'=>$id,'recipients'=>$total,'status'=>$due>time()?'scheduled':'running'];
    }catch(\Throwable $e){db()->rollBack();throw $e;}
}
function control_campaign(array $in): void {
    $id=ident($in['id']??'');$action=$in['action']??'';
    db()->beginTransaction();
    try{
        $c=one('SELECT * FROM tz_campaigns WHERE id=? FOR UPDATE',[$id]);if(!$c)throw new Problem('Campaign not found.',404);
        $allowed=['pause'=>['running','scheduled'],'resume'=>['paused','needs_attention'],'cancel'=>['running','scheduled','paused','needs_attention']];
        if(!isset($allowed[$action])||!in_array($c['status'],$allowed[$action],true))throw new Problem('This action is not available for the campaign.',409);
        $next=['pause'=>'paused','resume'=>'running','cancel'=>'cancelled'][$action];
        query('UPDATE tz_campaigns SET status=?,due_at=?,updated_at=?,revision=revision+1,last_error=NULL WHERE id=?',[$next,time(),time(),$id]);
        if($action==='cancel')query("UPDATE tz_recipients SET status='suppressed',error='Campaign cancelled before submission.' WHERE campaign_id=? AND status='pending'",[$id]);
        audit('campaign_'.$action,$id,'admin');db()->commit();
    }catch(\Throwable $e){db()->rollBack();throw $e;}
}
function with_worker_lock(string $kind,callable $fn): mixed {
    // Advisory locks are connection-owned and released even when PHP exits.
    // Keep the old lock namespace to coordinate mixed-version workers during upgrades.
    $lock='trezad:'.$kind.':'.substr(hash('sha256',config()['db_dsn']),0,16);
    if(!(int)query('SELECT GET_LOCK(?,0)',[$lock])->fetchColumn())return ['advanced'=>0,'busy'=>true];
    try{return $fn();}finally{query('SELECT RELEASE_LOCK(?)',[$lock]);}
}
function advance_campaign(?callable $transport=null): array {
    $transport??=__NAMESPACE__.'\\send_mail';
    return with_worker_lock('sending',function()use($transport){
        set_setting('sending_heartbeat',(string)time());
        // A prior process may have died after submission. Never replay its intent.
        query("UPDATE tz_campaigns SET status='needs_attention',last_error='A previous submission was interrupted. Review its outcome.' WHERE id IN(SELECT campaign_id FROM tz_recipients WHERE status='sending' AND attempted_at<?)",[time()-300]);
        query("UPDATE tz_recipients SET status='unknown',error='Interrupted submission. Automatic replay disabled.' WHERE status='sending' AND attempted_at<?",[time()-300]);
        $c=one("SELECT * FROM tz_campaigns WHERE status IN('running','scheduled') AND due_at<=? ORDER BY due_at,created_at LIMIT 1",[time()]);
        if(!$c)return ['advanced'=>0,'next_at'=>one("SELECT MIN(due_at) due FROM tz_campaigns WHERE status IN('running','scheduled')")['due']??null];
        $r=one("SELECT * FROM tz_recipients WHERE campaign_id=? AND status='pending' AND is_test=0 ORDER BY created_at,id LIMIT 1",[$c['id']]);
        if(!$r){query("UPDATE tz_campaigns SET status='completed',updated_at=? WHERE id=? AND status IN('running','scheduled')",[time(),$c['id']]);return ['advanced'=>0];}
        $pool=rows('SELECT a.*,ca.position,ca.generation AS frozen_generation FROM tz_accounts a JOIN tz_campaign_accounts ca ON ca.account_id=a.id WHERE ca.campaign_id=? ORDER BY ca.position',[$c['id']]);
        $eligible=array_values(array_filter($pool,static fn($a)=>$a['enabled']&&$a['verified_at']&&(int)$a['generation']===(int)$a['frozen_generation']));
        if(!$eligible){query("UPDATE tz_campaigns SET status='needs_attention',last_error='No selected account is enabled with unchanged tested credentials.' WHERE id=?",[$c['id']]);return ['advanced'=>0];}
        $chosen=null;$soon=time()+86400;
        for($i=0;$i<count($eligible);$i++){
            $a=$eligible[((int)$c['cursor_account']+$i)%count($eligible)];
            $used=$a['usage_day']===gmdate('Y-m-d')?(int)$a['used_today']:0;
            if($used>=(int)$a['daily_limit']){$soon=min($soon,(int)strtotime('tomorrow UTC'));continue;}
            if((int)$a['next_at']>time()){$soon=min($soon,(int)$a['next_at']);continue;}
            $chosen=$a;break;
        }
        if(!$chosen){query('UPDATE tz_campaigns SET due_at=? WHERE id=?',[$soon,$c['id']]);return ['advanced'=>0,'next_at'=>$soon];}
        db()->beginTransaction();
        try{
            $fresh=one('SELECT * FROM tz_campaigns WHERE id=? FOR UPDATE',[$c['id']]);
            $acct=one('SELECT * FROM tz_accounts WHERE id=? FOR UPDATE',[$chosen['id']]);
            $contact=one('SELECT * FROM tz_contacts WHERE id=? FOR UPDATE',[$r['contact_id']]);
            if(!in_array($fresh['status'],['running','scheduled'],true)||!$acct['enabled']||!$acct['verified_at']||(int)$acct['generation']!==(int)$chosen['frozen_generation']){db()->rollBack();return ['advanced'=>0];}
            if(!$contact||$contact['suppressed']||!$contact['consent']||$contact['verification']!=='valid'){
                query("UPDATE tz_recipients SET status='suppressed',error='Contact excluded before submission.' WHERE id=? AND status='pending'",[$r['id']]);db()->commit();return ['advanced'=>1];
            }
            $claimed=query("UPDATE tz_recipients SET status='sending',account_id=?,attempted_at=? WHERE id=? AND status='pending'",[$acct['id'],time(),$r['id']]);
            if(!$claimed->rowCount()){db()->rollBack();return ['advanced'=>0];}
            $used=$acct['usage_day']===gmdate('Y-m-d')?(int)$acct['used_today']:0;
            query('UPDATE tz_accounts SET used_today=?,usage_day=?,next_at=? WHERE id=?',[$used+1,gmdate('Y-m-d'),time()+(int)$acct['min_interval'],$acct['id']]);
            query("UPDATE tz_campaigns SET status='running',cursor_account=cursor_account+1,due_at=?,updated_at=? WHERE id=?",[time()+(int)$c['interval_seconds'],time(),$c['id']]);
            db()->commit();
        }catch(\Throwable $e){if(db()->inTransaction())db()->rollBack();throw $e;}
        $r['account_id']=$acct['id'];$r['attempted_at']=time();
        $result=$transport($acct,$c,$r);
        if(!in_array($result['status']??'', ['accepted','failed','unknown'],true))$result=['status'=>'unknown','error'=>'Unrecognized transport result.'];
        query("UPDATE tz_recipients SET status=?,message_id=?,accepted_at=?,error=? WHERE id=? AND status IN('sending','unknown')",[$result['status'],$result['message_id']??null,$result['status']==='accepted'?time():null,$result['error']??null,$r['id']]);
        query('UPDATE tz_accounts SET next_at=GREATEST(next_at,?) WHERE id=?',[time()+(int)$acct['min_interval'],$acct['id']]);
        if($result['status']!=='accepted')query("UPDATE tz_campaigns SET status='needs_attention',last_error=? WHERE id=? AND status IN('running','scheduled')",[$result['error']??'Review the last submission.',$c['id']]);
        else query('UPDATE tz_campaigns SET due_at=GREATEST(due_at,?) WHERE id=?',[time()+(int)$c['interval_seconds'],$c['id']]);
        return ['advanced'=>1,'status'=>$result['status']];
    });
}
function test_campaign(array $in): array {
    $cid=ident($in['id']??'');$aid=ident($in['account_id']??'');$rid=ident($in['request_id']??'');$to=email($in['email']??'');
    if(!$to)throw new Problem('Enter one valid test address.');
    if(!setting('postal_address'))throw new Problem('Add the postal address before sending a test.');
    return with_worker_lock('sending',function()use($cid,$aid,$rid,$to){
        $old=one('SELECT * FROM tz_recipients WHERE id=?',[$rid]);
        if($old){if($old['campaign_id']!==$cid||$old['email']!==$to||$old['account_id']!==$aid)throw new Problem('Test request ID already used.',409);return ['delivery'=>$old];}
        $c=one('SELECT * FROM tz_campaigns WHERE id=?',[$cid]);$a=one('SELECT * FROM tz_accounts WHERE id=?',[$aid]);
        if(!$c||!$a)throw new Problem('Campaign or account not found.',404);
        assert_campaign_ready($c);
        if(!$a['enabled']||!$a['verified_at'])throw new Problem('Enable and test this account first.');
        $contact=one('SELECT * FROM tz_contacts WHERE email=?',[$to]);
        if($contact&&$contact['suppressed'])throw new Problem('This address is suppressed.');
        $used=$a['usage_day']===gmdate('Y-m-d')?(int)$a['used_today']:0;
        if($used>=(int)$a['daily_limit']||(int)$a['next_at']>time())throw new Problem('Account limit or cooldown is active.',429);
        // Distinct positive test discriminator permits multiple intentional tests; request ID handles replay.
        $testOrdinal=(int)one('SELECT COUNT(*) n FROM tz_recipients WHERE campaign_id=? AND email=? AND is_test>0',[$cid,$to])['n']+1;
        if($testOrdinal>120)throw new Problem('Test message limit reached for this campaign/address.',429);
        query("INSERT INTO tz_recipients(id,campaign_id,email,status,account_id,is_test,attempted_at,created_at) VALUES(?,?,?,'sending',?,?,?,?)",[$rid,$cid,$to,$aid,$testOrdinal,time(),time()]);
        query('UPDATE tz_accounts SET usage_day=?,used_today=?,next_at=? WHERE id=?',[gmdate('Y-m-d'),$used+1,time()+(int)$a['min_interval'],$aid]);
        $r=one('SELECT * FROM tz_recipients WHERE id=?',[$rid]);$result=send_mail($a,$c,$r);
        query('UPDATE tz_recipients SET status=?,message_id=?,accepted_at=?,error=? WHERE id=?',[$result['status'],$result['message_id'],$result['status']==='accepted'?time():null,$result['error'],$rid]);
        query('UPDATE tz_accounts SET next_at=GREATEST(next_at,?) WHERE id=?',[time()+(int)$a['min_interval'],$aid]);
        return ['delivery'=>one('SELECT * FROM tz_recipients WHERE id=?',[$rid])];
    });
}
