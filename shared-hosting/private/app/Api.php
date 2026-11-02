<?php
declare(strict_types=1);
namespace Sendzad;
function group_list(): array {
    return rows("SELECT g.*,COUNT(m.contact_id) contacts,COALESCE(SUM(c.verification='valid' AND c.suppressed=0 AND c.consent=1),0) ready FROM tz_groups g LEFT JOIN tz_members m ON m.group_id=g.id LEFT JOIN tz_contacts c ON c.id=m.contact_id GROUP BY g.id,g.name,g.created_at ORDER BY g.created_at DESC");
}
function job_list(): array {
    return rows("SELECT j.id,j.name,j.status,j.started_at,j.created_at,j.updated_at,j.last_error,COUNT(i.id) total,COALESCE(SUM(i.status='valid'),0) valid,COALESCE(SUM(i.status='invalid'),0) invalid,COALESCE(SUM(i.status='risky'),0) risky,COALESCE(SUM(i.status='unknown'),0) unknown,COALESCE(SUM(i.status IN('pending','processing')),0) remaining FROM tz_verification_jobs j LEFT JOIN tz_verification_items i ON i.job_id=j.id GROUP BY j.id,j.name,j.status,j.started_at,j.created_at,j.updated_at,j.last_error ORDER BY j.created_at DESC LIMIT 100");
}
function save_account(array $in): array {
    $id=isset($in['id'])?ident($in['id']):uid();$old=one('SELECT * FROM tz_accounts WHERE id=?',[$id]);
    $c=$in['config']??[];if(!is_array($c))throw new Problem('Invalid account settings.');
    $provider=$in['provider']??'smtp';if(!in_array($provider,['smtp','sendgrid'],true))throw new Problem('Unsupported SMTP provider.');
    $from=email($c['from_email']??'');$reply=trim($c['reply_to']??'');
    if(!$from||$reply&&!email($reply))throw new Problem('Enter valid sender addresses.');
    $oldConfig=$old?account_config($old):[];
    $password=$c['password']??'';if($password==='')$password=$oldConfig['password']??'';
    if(!is_string($password)||strlen($password)>4096||$password===''||preg_match('/[\r\n\x00]/',$password))throw new Problem('Enter an SMTP password or app password.');
    $host=strtolower(text($c['host']??'',253));$port=integer($c['port']??587,1,65535);$security=$c['security']??'starttls';
    if(!in_array($port,[465,587,2525],true)||!in_array($security,['tls','starttls'],true)||$port===465&&$security!=='tls'||$port===587&&$security!=='starttls')throw new Problem('Use port 465 with TLS or port 587/2525 with STARTTLS.');
    if(!preg_match('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iD',$host))throw new Problem('Enter the SMTP hostname without a URL or port.');
    if($old&&($oldConfig['host']??'')!==$host&&empty($c['password']))throw new Problem('Re-enter the password when changing the SMTP host.');
    $cfg=['host'=>$host,'port'=>$port,'security'=>$security,'username'=>text($c['username']??'',512),'password'=>$password,'from_email'=>$from,'from_name'=>text($c['from_name']??'',120),'reply_to'=>$reply,'webhook_public_key'=>text($c['webhook_public_key']??'',4000,true)];
    if(!$cfg['username'])throw new Problem('Enter the SMTP username.');
    $label=text($in['label']??'',120);if(!$label)throw new Problem('Name this account.');
    $limit=integer($in['daily_limit']??100,1,1000000);$interval=integer($in['min_interval']??5,1,86400);
    $changed=$old&&($oldConfig!==$cfg||$old['provider']!==$provider);
    if($old)query('UPDATE tz_accounts SET label=?,provider=?,config_cipher=?,daily_limit=?,min_interval=?,generation=generation+?,enabled=?,verified_at=?,last_error=NULL WHERE id=?',[$label,$provider,seal(json_encode($cfg,JSON_THROW_ON_ERROR),'account:'.$id),$limit,$interval,$changed?1:0,$changed?0:$old['enabled'],$changed?null:$old['verified_at'],$id]);
    else query('INSERT INTO tz_accounts(id,label,provider,config_cipher,daily_limit,min_interval,created_at) VALUES(?,?,?,?,?,?,?)',[$id,$label,$provider,seal(json_encode($cfg,JSON_THROW_ON_ERROR),'account:'.$id),$limit,$interval,time()]);
    return public_account(one('SELECT * FROM tz_accounts WHERE id=?',[$id]));
}
/** Bounded bulk insert; existing consent, verification and opt-outs are never overwritten. */
function import_contacts(array $in): array {
    $gid=ident($in['group_id']??'');$data=$in['rows']??[];
    if(!one('SELECT id FROM tz_groups WHERE id=?',[$gid]))throw new Problem('Group not found.',404);
    if(!is_array($data)||count($data)>500)throw new Problem('Import at most 500 rows per chunk.');
    $consent=($in['consent']??false)===true?1:0;$valid=[];$invalid=0;$validCount=0;
    foreach($data as $row){
        if(!is_array($row)){$invalid++;continue;}
        $address=email($row['email']??'');if(!$address){$invalid++;continue;}
        $name=text((string)($row['name']??''),120);$validCount++;
        if(!isset($valid[$address]))$valid[$address]=$name;
    }
    if(!$valid)return ['added'=>0,'invalid'=>$invalid,'duplicates'=>0];
    $params=[];$values=[];$now=time();
    foreach($valid as $address=>$name){$values[]='(?,?,?,?)';array_push($params,$address,$name,$consent,$now);}
    db()->beginTransaction();
    try{
        $insert=query('INSERT IGNORE INTO tz_contacts(email,name,consent,created_at) VALUES '.implode(',',$values),$params);
        $added=$insert->rowCount();$addresses=array_keys($valid);$marks=implode(',',array_fill(0,count($addresses),'?'));
        query('INSERT IGNORE INTO tz_members(group_id,contact_id) SELECT ?,id FROM tz_contacts WHERE email IN ('.$marks.')',array_merge([$gid],$addresses));
        db()->commit();
    }catch(\Throwable $e){if(db()->inTransaction())db()->rollBack();throw $e;}
    return ['added'=>$added,'invalid'=>$invalid,'duplicates'=>$validCount-$added];
}
function api_route(string $route,string $method,array $in): array {
    $page=max(1,(int)($_GET['page']??1));$offset=($page-1)*50;
    $search=substr((string)($_GET['search']??''),0,120);
    switch($route){
        case 'overview':
            $days=integer($_GET['days']??30,7,365);$since=time()-$days*86400;
            $m=metrics(null,$since);
            $series=rows("SELECT FLOOR(accepted_at/86400)*86400 day,COUNT(*) accepted,COALESCE(SUM(delivered_at IS NOT NULL),0) delivered FROM tz_recipients WHERE is_test=0 AND accepted_at>=? GROUP BY FLOOR(accepted_at/86400) ORDER BY day",[$since]);
            $recent=rows("SELECT c.id,c.name,c.subject,c.status,c.updated_at,COUNT(r.id) audience,COALESCE(SUM(r.status='accepted'),0) accepted,COALESCE(SUM(r.opened_at IS NOT NULL),0) opened,COALESCE(SUM(r.delivered_at IS NOT NULL),0) delivered FROM (SELECT id,name,subject,status,updated_at FROM tz_campaigns ORDER BY updated_at DESC,id DESC LIMIT 5) c LEFT JOIN tz_recipients r ON r.campaign_id=c.id AND r.is_test=0 GROUP BY c.id,c.name,c.subject,c.status,c.updated_at ORDER BY c.updated_at DESC,c.id DESC");
            return ['metrics'=>$m,'series'=>$series,'campaigns'=>$recent,'contacts'=>(int)one('SELECT COUNT(*) n FROM tz_contacts')['n'],'ready_contacts'=>(int)one("SELECT COUNT(*) n FROM tz_contacts WHERE verification='valid' AND suppressed=0 AND consent=1")['n'],'enabled_accounts'=>(int)one('SELECT COUNT(*) n FROM tz_accounts WHERE enabled=1')['n'],'sending_heartbeat'=>(int)setting('sending_heartbeat','0'),'verification_heartbeat'=>(int)setting('verification_heartbeat','0'),'activity'=>rows('SELECT action,object_id,created_at FROM tz_audit ORDER BY id DESC LIMIT 5')];
        case 'campaigns':
            if($method==='POST')return ['campaign'=>save_campaign($in)];
            $filter=(string)($_GET['status']??'');$where='c.name LIKE ?';$params=['%'.$search.'%'];
            if($filter){$where.=' AND c.status=?';$params[]=$filter;}
            $total=(int)one("SELECT COUNT(*) n FROM tz_campaigns c WHERE $where",$params)['n'];
            return ['items'=>rows("SELECT c.id,c.name,c.subject,c.status,c.revision,c.track_opens,c.created_at,c.updated_at,COUNT(r.id) audience,COALESCE(SUM(r.status='accepted'),0) accepted,COALESCE(SUM(r.delivered_at IS NOT NULL),0) delivered,COALESCE(SUM(r.opened_at IS NOT NULL),0) opened FROM (SELECT c.id,c.name,c.subject,c.status,c.revision,c.track_opens,c.created_at,c.updated_at FROM tz_campaigns c WHERE $where ORDER BY c.created_at DESC,c.id DESC LIMIT 50 OFFSET $offset) c LEFT JOIN tz_recipients r ON r.campaign_id=c.id AND r.is_test=0 GROUP BY c.id,c.name,c.subject,c.status,c.revision,c.track_opens,c.created_at,c.updated_at ORDER BY c.created_at DESC,c.id DESC",$params),'total'=>$total,'page'=>$page];
        case 'campaign':
            $id=ident($_GET['id']??$in['id']??'');$c=one('SELECT * FROM tz_campaigns WHERE id=?',[$id]);if(!$c)throw new Problem('Campaign not found.',404);
            return ['campaign'=>$c,'metrics'=>metrics($id)];
        case 'campaign/launch':return launch_campaign($in);
        case 'campaign/control':control_campaign($in);return ['ok'=>true];
        case 'campaign/test':return test_campaign($in);
        case 'campaign/duplicate':
            $old=one('SELECT * FROM tz_campaigns WHERE id=?',[ident($in['id']??'')]);if(!$old)throw new Problem('Campaign not found.',404);
            unset($old['id']);$old['name']=substr($old['name'],0,110).' (copy)';$old['track_opens']=(bool)$old['track_opens'];$old['track_clicks']=(bool)$old['track_clicks'];return ['campaign'=>save_campaign($old)];
        case 'recipients':
            $id=ident($_GET['id']??'');$filter=$_GET['status']??'';$where='campaign_id=? AND is_test=0 AND email LIKE ?';$params=[$id,'%'.$search.'%'];
            $filters=['delivered'=>'delivered_at IS NOT NULL','opened'=>'opened_at IS NOT NULL','clicked'=>'clicked_at IS NOT NULL','bounced'=>'bounced_at IS NOT NULL','unsubscribed'=>'unsubscribed_at IS NOT NULL','machine'=>'machine_opened_at IS NOT NULL'];
            if(isset($filters[$filter]))$where.=' AND '.$filters[$filter];elseif($filter){$where.=' AND status=?';$params[]=$filter;}
            return ['items'=>rows("SELECT * FROM tz_recipients WHERE $where ORDER BY email,id LIMIT 50 OFFSET $offset",$params),'total'=>(int)one("SELECT COUNT(*) n FROM tz_recipients WHERE $where",$params)['n'],'page'=>$page];
        case 'recipient/events':return ['events'=>rows('SELECT source,kind,machine,occurred_at FROM tz_events WHERE recipient_id=? ORDER BY occurred_at DESC LIMIT 100',[ident($_GET['id']??'')])];
        case 'groups':
            if($method==='POST'){$name=text($in['name']??'',120);if(!$name)throw new Problem('Name this group.');$id=uid();query('INSERT INTO tz_groups(id,name,created_at) VALUES(?,?,?)',[$id,$name,time()]);return ['group'=>['id'=>$id,'name'=>$name]];}
            return ['items'=>group_list()];
        case 'contacts':
            $where='(c.email LIKE ? OR c.name LIKE ?)';$params=['%'.$search.'%','%'.$search.'%'];
            if(!empty($_GET['group'])){$where.=' AND EXISTS(SELECT 1 FROM tz_members m WHERE m.contact_id=c.id AND m.group_id=?)';$params[]=ident($_GET['group']);}
            $status=$_GET['status']??'';
            if($status==='suppressed')$where.=' AND c.suppressed=1';elseif($status){$where.=' AND c.verification=?';$params[]=$status;}
            return ['items'=>rows("SELECT c.* FROM tz_contacts c WHERE $where ORDER BY c.id DESC LIMIT 50 OFFSET $offset",$params),'total'=>(int)one("SELECT COUNT(*) n FROM tz_contacts c WHERE $where",$params)['n'],'page'=>$page];
        case 'contacts/import':return import_contacts($in);
        case 'contacts/suppress':query('UPDATE tz_contacts SET suppressed=1 WHERE id=?',[integer($in['id']??0,1,PHP_INT_MAX)]);return ['ok'=>true];
        case 'jobs':return $method==='POST'?create_verification($in):['items'=>job_list()];
        case 'jobs/control':control_verification($in);return ['ok'=>true];
        case 'jobs/add-valid':return add_verified_to_group($in);
        case 'accounts':
            if($method==='POST')return with_worker_lock('sending',fn()=>['account'=>save_account($in)]);
            return ['items'=>array_map(__NAMESPACE__.'\\public_account',rows('SELECT * FROM tz_accounts ORDER BY created_at DESC'))];
        case 'accounts/test':
            return with_worker_lock('sending',function()use($in){
                $id=ident($in['id']??'');$a=one('SELECT * FROM tz_accounts WHERE id=?',[$id]);if(!$a)throw new Problem('Account not found.',404);
                try{check_smtp($a);}catch(Problem $e){query('UPDATE tz_accounts SET verified_at=NULL,enabled=0,last_error=? WHERE id=?',[$e->getMessage(),$id]);throw $e;}
                query('UPDATE tz_accounts SET verified_at=?,last_error=NULL WHERE id=?',[time(),$id]);return ['ok'=>true];
            });
        case 'accounts/toggle':
            return with_worker_lock('sending',function()use($in){
                $id=ident($in['id']??'');$enabled=($in['enabled']??false)===true?1:0;$a=one('SELECT * FROM tz_accounts WHERE id=?',[$id]);if(!$a)throw new Problem('Account not found.',404);
                if($enabled&&!$a['verified_at'])throw new Problem('Test this SMTP account before enabling it.');
                query('UPDATE tz_accounts SET enabled=? WHERE id=?',[$enabled,$id]);return ['ok'=>true];
            });
        case 'campaign/preflight':
            $c=one('SELECT * FROM tz_campaigns WHERE id=?',[ident($_GET['id']??'')]);if(!$c)throw new Problem('Campaign not found.',404);
            return campaign_preflight($c,brand_for_campaign($c));
        case 'settings':
            if($method==='POST'){
                if(isset($in['brand'])&&!is_array($in['brand']))throw new Problem('Brand settings must be an object.');
                $changes=[];
                if(isset($in['brand']))$changes['email_brand']=json_encode(validate_brand($in['brand']),JSON_THROW_ON_ERROR);
                if(isset($in['postal_address']))$changes['postal_address']=text($in['postal_address'],1000,true);
                if(!empty($in['reoon_key']))$changes['reoon_key']=seal(text($in['reoon_key'],2048),'reoon');
                db()->beginTransaction();
                try{foreach($changes as $key=>$value)set_setting($key,$value);audit('settings_saved','workspace','admin');db()->commit();}
                catch(\Throwable $e){if(db()->inTransaction())db()->rollBack();throw $e;}
            }
            return ['brand'=>brand_config(),'postal_address'=>setting('postal_address'),'reoon_configured'=>setting('reoon_key')!=='','app_url'=>config()['app_url'],'sending_heartbeat'=>(int)setting('sending_heartbeat','0'),'verification_heartbeat'=>(int)setting('verification_heartbeat','0'),'transport_installed'=>class_exists('PHPMailer\\PHPMailer\\PHPMailer'),'runtime'=>'PHP / MySQL'];
        default:throw new Problem('Endpoint not found.',404);
    }
}
