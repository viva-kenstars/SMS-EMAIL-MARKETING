<?php
declare(strict_types=1);
namespace Sendzad;

/** Reusable designs are stored independently of campaigns and SMTP credentials. */
function saved_template_input(array $in): array {
    $name=text($in['name']??'',120);if($name==='')throw new Problem('Name this template.');
    $raw=$in['html']??'';if(!is_string($raw)||strlen($raw)>500000)throw new Problem('Keep HTML under 500 KB.');
    $html=clean_html($raw);if(!trim($html))throw new Problem('Add some template content.');
    // Deliberately detach managed blocks: the template author can edit header/footer.
    // compose_email still supplies missing unsubscribe and business-address details.
    $html=preg_replace('/\sdata-tz-(?:header|footer)="standard"/','',$html);
    return ['name'=>$name,'category'=>text($in['category']??'',60),
        'subject'=>text($in['subject']??'',200),'preheader'=>text($in['preheader']??'',250),
        'html'=>$html,'text_body'=>text($in['text_body']??'',500000,true)];
}
function saved_template_get(string $id): array {
    $row=one('SELECT * FROM tz_templates WHERE id=?',[ident($id)]);
    if(!$row)throw new Problem('Template not found.',404);
    return $row;
}
function saved_template_save(array $in): array {
    $data=saved_template_input($in);$id=isset($in['id'])?ident($in['id']):uid();$now=time();
    $revision=isset($in['id'])?integer($in['revision']??0,1,2147483646):0;
    db()->beginTransaction();
    try{
        if($revision){
            $q=query('UPDATE tz_templates SET name=?,category=?,subject=?,preheader=?,html=?,text_body=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND archived=0',[...array_values($data),$now,$id,$revision]);
            if($q->rowCount()!==1)throw new Problem('This template changed or was archived. Reload before saving.',409);
        }else{
            query('INSERT INTO tz_templates(id,name,category,subject,preheader,html,text_body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',[$id,...array_values($data),$now,$now]);
        }
        $saved=saved_template_get($id);
        query('INSERT INTO tz_template_versions(template_id,revision,snapshot,created_at) VALUES(?,?,?,?)',[$id,$saved['revision'],json_encode($data,JSON_THROW_ON_ERROR),$now]);
        // Bounded history, newest twenty revisions. Original campaign copies are unaffected.
        query('DELETE FROM tz_template_versions WHERE template_id=? AND revision<=?',[$id,max(0,(int)$saved['revision']-20)]);
        audit('template_saved',$id,'admin');db()->commit();return $saved;
    }catch(\Throwable $e){if(db()->inTransaction())db()->rollBack();throw $e;}
}
function saved_template_route(string $route,string $method,array $in): array {
    if(!in_array($method,['GET','POST'],true))throw new Problem('Method not allowed.',405);
    $read=['list','get','history'];$write=['save','duplicate','archive','restore','use'];
    if(!in_array($route,$method==='GET'?$read:$write,true))throw new Problem('Template action or method not allowed.',405);
    switch($route){
        case 'list':
            $page=integer($_GET['page']??1,1,1000000);$offset=($page-1)*30;
            $search=text($_GET['search']??'',120);$archived=integer($_GET['archived']??0,0,1);
            $params=[$archived,'%'.$search.'%','%'.$search.'%'];
            $where='archived=? AND (name LIKE ? OR category LIKE ?)';
            return ['items'=>rows("SELECT id,name,category,subject,preheader,revision,archived,created_at,updated_at FROM tz_templates WHERE $where ORDER BY updated_at DESC,id DESC LIMIT 30 OFFSET $offset",$params),
                'total'=>(int)one("SELECT COUNT(*) n FROM tz_templates WHERE $where",$params)['n'],'page'=>$page];
        case 'get':return ['template'=>saved_template_get(ident($_GET['id']??''))];
        case 'history':
            $id=ident($_GET['id']??'');saved_template_get($id);
            return ['items'=>rows('SELECT revision,created_at FROM tz_template_versions WHERE template_id=? ORDER BY revision DESC LIMIT 20',[$id])];
        case 'save':return ['template'=>saved_template_save($in)];
        case 'duplicate':
            $old=saved_template_get(ident($in['id']??''));unset($old['id'],$old['revision']);
            $old['name']=substr($old['name'],0,110).' (copy)';return ['template'=>saved_template_save($old)];
        case 'archive':
            if(isset($in['archived'])&&!is_bool($in['archived']))throw new Problem('Archive state must be true or false.');
            $id=ident($in['id']??'');$rev=integer($in['revision']??0,1,2147483646);$archived=($in['archived']??true)===true?1:0;
            $q=query('UPDATE tz_templates SET archived=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',[$archived,time(),$id,$rev]);
            if($q->rowCount()!==1)throw new Problem('This template changed. Reload before continuing.',409);
            audit($archived?'template_archived':'template_unarchived',$id,'admin');return ['ok'=>true];
        case 'restore':
            $id=ident($in['id']??'');$version=integer($in['version']??0,1,2147483646);
            $row=one('SELECT snapshot FROM tz_template_versions WHERE template_id=? AND revision=?',[$id,$version]);
            if(!$row)throw new Problem('That revision is no longer available.',404);
            $data=json_decode($row['snapshot'],true,32,JSON_THROW_ON_ERROR);
            return ['template'=>saved_template_save([...$data,'id'=>$id,'revision'=>$in['revision']??0])];
        case 'use':
            $t=saved_template_get(ident($in['id']??''));
            if((int)$t['archived'])throw new Problem('Restore this template before using it.',409);
            if((int)$t['revision']!==integer($in['revision']??0,1,2147483646))throw new Problem('Template changed. Reload the saved version.',409);
            if(!trim($t['subject']))throw new Problem('Add a subject to the template before creating a campaign.');
            unset($t['id'],$t['revision']);$t['track_opens']=false;$t['track_clicks']=false;
            // A content snapshot only. No audience, account or launch permission is copied.
            return ['campaign'=>save_campaign($t)];
    }
    throw new Problem('Template action not found.',404);
}
