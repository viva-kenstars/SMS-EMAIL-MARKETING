<?php
declare(strict_types=1);
require __DIR__.'/_bootstrap.php';
$title='Unsubscribe';$message='Stop receiving campaign emails from this sender.';$show=false;
try{
    $id=Sendzad\read_token('unsubscribe',(string)($_GET['k']??''));
    $r=$id?Sendzad\one('SELECT * FROM tz_recipients WHERE id=?',[$id]):null;
    if(!$r)throw new Sendzad\Problem('This unsubscribe link is invalid.',404);
    if(($_SERVER['REQUEST_METHOD']??'GET')==='POST'){
        if(($_POST['confirm']??'')!=='yes'&&($_POST['List-Unsubscribe']??'')!=='One-Click')throw new Sendzad\Problem('Confirm your unsubscribe request.');
        Sendzad\record_event($id,'unsubscribe','unsubscribe',$id,time());
        $title='You are unsubscribed';$message='No more campaign emails will be sent to this address. Messages already submitted cannot be recalled.';
    }elseif(($_SERVER['REQUEST_METHOD']??'GET')==='GET')$show=true;
    else throw new Sendzad\Problem('Method not allowed.',405);
}catch(Sendzad\Problem $e){http_response_code($e->status);$message=$e->getMessage();}
catch(Throwable){http_response_code(503);$message='Please try again shortly.';}
?><!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title><?=Sendzad\esc($title)?></title><link rel="stylesheet" href="assets/workspace.css"></head><body class="public-page"><main class="auth-card"><div class="brand-mark">s</div><h1><?=Sendzad\esc($title)?></h1><p><?=Sendzad\esc($message)?></p><?php if($show):?><form method="post"><button class="btn primary" name="confirm" value="yes">Unsubscribe</button></form><?php endif?></main></body></html>
