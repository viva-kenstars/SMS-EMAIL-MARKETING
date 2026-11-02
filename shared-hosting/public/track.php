<?php
declare(strict_types=1);
require __DIR__.'/_bootstrap.php';
$kind=(string)($_GET['kind']??'');$value=(string)($_GET['k']??'');
try{
    if(($_SERVER['REQUEST_METHOD']??'GET')!=='GET')throw new Sendzad\Problem('Method not allowed.',405);
    if($kind==='click'){
        $id=Sendzad\read_token('click',$value);$link=$id?Sendzad\one('SELECT * FROM tz_links WHERE id=?',[$id]):null;
        if(!$link||!Sendzad\safe_url($link['url']))throw new Sendzad\Problem('Link unavailable.',404);
        Sendzad\record_event($link['recipient_id'],'click','tracking',$id.':'.gmdate('YmdHi'),time());
        header('Location: '.$link['url'],true,302);exit;
    }
    if($kind==='open'){
        $id=Sendzad\read_token('open',$value);
        if($id){$machine=(bool)preg_match('/bot|spider|scanner|prefetch/i',substr($_SERVER['HTTP_USER_AGENT']??'',0,300));Sendzad\record_event($id,'open','tracking',$id.':'.gmdate('YmdHi'),time(),$machine);}
    }
}catch(Throwable){if($kind==='click'){http_response_code(404);echo 'Link unavailable.';exit;}}
header('Content-Type: image/gif');header('Cache-Control: private,no-store,no-cache,max-age=0');header('Pragma: no-cache');
echo base64_decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
