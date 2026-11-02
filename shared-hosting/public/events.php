<?php
declare(strict_types=1);
require __DIR__.'/_bootstrap.php';
try{
    if(($_SERVER['REQUEST_METHOD']??'')!=='POST')throw new Sendzad\Problem('Method not allowed.',405);
    $raw=file_get_contents('php://input',false,null,0,4000001);
    if($raw===false||strlen($raw)>4000000)throw new Sendzad\Problem('Event batch is too large.',413);
    $count=Sendzad\process_sendgrid((string)($_GET['account']??''),$raw,$_SERVER['HTTP_X_TWILIO_EMAIL_EVENT_WEBHOOK_SIGNATURE']??'',$_SERVER['HTTP_X_TWILIO_EMAIL_EVENT_WEBHOOK_TIMESTAMP']??'');
    Sendzad\json_response(['ok'=>true,'recorded'=>$count]);
}catch(Sendzad\Problem $e){Sendzad\json_response(['error'=>$e->getMessage()],$e->status);}
catch(Throwable){Sendzad\json_response(['error'=>'Event processing could not finish. Retry this batch.'],500);}
