<?php
declare(strict_types=1);
namespace Sendzad;
function verify_sendgrid_signature(string $raw,string $signature,string $timestamp,string $publicKey,?int $now=null): bool {
    $now??=time();
    if(!preg_match('/^[0-9]{10}$/D',$timestamp)||abs($now-(int)$timestamp)>86400)return false;
    $sig=base64_decode($signature,true);if($sig===false)return false;
    $key=str_contains($publicKey,'BEGIN PUBLIC KEY')?$publicKey:"-----BEGIN PUBLIC KEY-----\n".chunk_split(preg_replace('/\s+/','',$publicKey),64,"\n")."-----END PUBLIC KEY-----\n";
    $resource=openssl_pkey_get_public($key);if($resource===false)return false;
    return openssl_verify($timestamp.$raw,$sig,$resource,OPENSSL_ALGO_SHA256)===1;
}
function record_event(string $recipientId,string $kind,string $source,string $key,int $at,bool $machine=false): bool {
    $columns=['delivered'=>'delivered_at','open'=>$machine?'machine_opened_at':'opened_at','click'=>'clicked_at','bounce'=>'bounced_at','dropped'=>'bounced_at','unsubscribe'=>'unsubscribed_at','spamreport'=>'complained_at'];
    if(!in_array($kind,['processed','delivered','open','click','bounce','dropped','deferred','unsubscribe','spamreport'],true))return false;
    db()->beginTransaction();
    try{
        $r=one('SELECT r.*,c.track_opens,c.track_clicks FROM tz_recipients r JOIN tz_campaigns c ON c.id=r.campaign_id WHERE r.id=? FOR UPDATE',[$recipientId]);
        if(!$r||!$r['attempted_at']){db()->rollBack();return false;}
        if($kind==='open'&&!$r['track_opens']||$kind==='click'&&!$r['track_clicks']){db()->rollBack();return false;}
        $insert=query('INSERT IGNORE INTO tz_events(recipient_id,source,event_key,kind,machine,occurred_at) VALUES(?,?,?,?,?,?)',[$recipientId,$source,hash('sha256',$key),$kind,$machine?1:0,$at]);
        if(!$insert->rowCount()){db()->commit();return false;}
        if(isset($columns[$kind])){ $column=$columns[$kind];query("UPDATE tz_recipients SET $column=CASE WHEN $column IS NULL THEN ? ELSE LEAST($column,?) END WHERE id=?",[$at,$at,$recipientId]); }
        if(in_array($kind,['unsubscribe','spamreport','bounce'],true))query('UPDATE tz_contacts SET suppressed=1 WHERE email=?',[$r['email']]);
        db()->commit();return true;
    }catch(\Throwable $e){if(db()->inTransaction())db()->rollBack();throw $e;}
}
function event_delivery_id(array $event): ?string {
    $current=$event['sendzad_delivery_id']??null;$legacy=$event['trezad_delivery_id']??null;
    if($current!==null&&$legacy!==null&&$current!==$legacy)return null;
    $id=$current??$legacy;return is_string($id)&&preg_match('/^[a-f0-9]{32}$/D',$id)?$id:null;
}
function process_sendgrid(string $aid,string $raw,string $signature,string $timestamp): int {
    $account=one('SELECT * FROM tz_accounts WHERE id=?',[ident($aid)]);
    if(!$account||$account['provider']!=='sendgrid')throw new Problem('Webhook not configured.',404);
    $key=account_config($account)['webhook_public_key']??'';
    if(!$key||!verify_sendgrid_signature($raw,$signature,$timestamp,$key))throw new Problem('Webhook signature is invalid.',401);
    try{$events=json_decode($raw,true,32,JSON_THROW_ON_ERROR);}catch(\Throwable){throw new Problem('Invalid event payload.');}
    if(!is_array($events)||!array_is_list($events)||count($events)>2000)throw new Problem('Invalid event batch.');
    $recorded=0;
    foreach($events as $e){
        if(!is_array($e))continue;
        $id=event_delivery_id($e);$eventId=$e['sg_event_id']??'';$at=$e['timestamp']??0;
        if(!is_string($id)||!preg_match('/^[a-f0-9]{32}$/D',$id)||!is_string($eventId)||!$eventId||strlen($eventId)>512||!is_numeric($at)||(int)$at>time()+300||(int)$at<946684800)continue;
        $r=one('SELECT email,account_id FROM tz_recipients WHERE id=?',[$id]);
        if(!$r||$r['account_id']!==$aid||$r['email']!==email($e['email']??''))continue;
        $kind=($e['event']??'')==='group_unsubscribe'?'unsubscribe':($e['event']??'');
        if(!is_string($kind))continue;
        if(record_event($id,$kind,'sendgrid',$aid.':'.$eventId,(int)$at,($e['sg_machine_open']??false)===true))$recorded++;
    }
    return $recorded;
}
function metrics(?string $campaign=null,?int $since=null): array {
    $where='is_test=0';$args=[];
    if($campaign){$where.=' AND campaign_id=?';$args[]=$campaign;}
    if($since){$where.=' AND created_at>=?';$args[]=$since;}
    $r=one("SELECT COUNT(*) audience,
      COALESCE(SUM(status='accepted'),0) accepted,
      COALESCE(SUM(delivered_at IS NOT NULL),0) delivered,
      COALESCE(SUM(opened_at IS NOT NULL),0) opened,
      COALESCE(SUM(machine_opened_at IS NOT NULL),0) machine_opens,
      COALESCE(SUM(clicked_at IS NOT NULL),0) clicked,
      COALESCE(SUM(bounced_at IS NOT NULL),0) bounced,
      COALESCE(SUM(unsubscribed_at IS NOT NULL),0) unsubscribed,
      COALESCE(SUM(complained_at IS NOT NULL),0) complaints,
      COALESCE(SUM(status='failed'),0) failed,
      COALESCE(SUM(status='unknown' AND delivered_at IS NULL AND bounced_at IS NULL),0) unknown,
      COALESCE(SUM(status='pending'),0) pending,
      COALESCE(SUM(status='suppressed'),0) suppressed
      FROM tz_recipients WHERE $where",$args);
    return array_map('intval',$r);
}
function export_report(string $id): never {
    ident($id);if(!one('SELECT id FROM tz_campaigns WHERE id=?',[$id]))throw new Problem('Campaign not found.',404);
    header('Content-Type: text/csv; charset=utf-8');header('Content-Disposition: attachment; filename="sendzad-campaign-'.$id.'.csv"');header('Cache-Control: no-store');
    $out=fopen('php://output','wb');
    fputcsv($out,['Email','Submission','Accepted UTC','Delivered UTC','Opened UTC (estimate)','Machine open UTC','Clicked UTC (estimate)','Bounce UTC','Unsubscribed UTC','Details'],',','"','');
    $cursor='';
    do{
        $page=rows('SELECT * FROM tz_recipients WHERE campaign_id=? AND is_test=0 AND id>? ORDER BY id LIMIT 500',[$id,$cursor]);
        foreach($page as $r){$cursor=$r['id'];$line=[$r['email'],$r['status']];foreach(['accepted_at','delivered_at','opened_at','machine_opened_at','clicked_at','bounced_at','unsubscribed_at']as $key)$line[]=$r[$key]?gmdate('c',(int)$r[$key]):'';$line[]=$r['error'];fputcsv($out,array_map(__NAMESPACE__.'\\csv_cell',$line),',','"','');}
    }while(count($page)===500);
    fclose($out);exit;
}
