<?php
declare(strict_types=1);
namespace Sendzad;
use PHPMailer\PHPMailer\PHPMailer;
function ip_in_range(string $address,string $network,int $bits): bool {
    $a=inet_pton($address);$n=inet_pton($network);
    if($a===false||$n===false||strlen($a)!==strlen($n))return false;
    $bytes=intdiv($bits,8);$rest=$bits%8;
    return substr($a,0,$bytes)===substr($n,0,$bytes)&&(!$rest||((ord($a[$bytes])& (255 << (8-$rest)))===(ord($n[$bytes])& (255 << (8-$rest)))));
}
function public_ip(string $ip): bool {
    if(!filter_var($ip,FILTER_VALIDATE_IP))return false;
    if(str_contains($ip,':')){
        if(!ip_in_range($ip,'2000::',3))return false;
        foreach([['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as [$network,$bits])if(ip_in_range($ip,$network,$bits))return false;
        return true;
    }
    foreach([['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as [$network,$bits])if(ip_in_range($ip,$network,$bits))return false;
    return true;
}
function smtp_ip(string $host): string {
    if(!preg_match('/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iD',$host)||filter_var($host,FILTER_VALIDATE_IP)||preg_match('/\.(local|internal|test|invalid|localhost)$/i',$host))throw new Problem('Use a public SMTP hostname.');
    $allow=config()['smtp_allowed_hosts']??[];
    if($allow&&!in_array(strtolower($host),array_map('strtolower',$allow),true))throw new Problem('This SMTP host is not in the installation allowlist.');
    $answers=dns_get_record($host,DNS_A|DNS_AAAA);
    $ips=[];
    foreach($answers?:[] as $answer){$ip=$answer['ip']??$answer['ipv6']??null;if($ip)$ips[]=$ip;}
    if(!$ips)throw new Problem('SMTP hostname could not be resolved.');
    foreach($ips as $ip)if(!public_ip($ip))throw new Problem('SMTP must resolve only to public addresses.');
    return $ips[0];
}
function smtp_client(array $c): PHPMailer {
    if(!class_exists(PHPMailer::class))throw new Problem('Install the private Composer dependencies before using SMTP.',503);
    $host=$c['host'];$address=smtp_ip($host);$port=(int)$c['port'];
    if(!in_array($port,[465,587,2525],true))throw new Problem('Use SMTP port 465, 587 or 2525.');
    if(($port===465&&$c['security']!=='tls')||($port===587&&$c['security']!=='starttls'))throw new Problem('Choose TLS for port 465 or STARTTLS for port 587.');
    $mail=new PHPMailer(true);$mail->isSMTP();
    // Connect to a validated DNS answer while verifying the original hostname.
    $mail->Host=str_contains($address,':')?'['.$address.']':$address;
    $mail->Port=$port;$mail->SMTPAuth=true;
    $mail->Username=$c['username'];$mail->Password=$c['password'];
    $mail->SMTPSecure=$c['security']==='tls'?PHPMailer::ENCRYPTION_SMTPS:PHPMailer::ENCRYPTION_STARTTLS;
    $mail->SMTPAutoTLS=false;$mail->Timeout=15;$mail->getSMTPInstance()->Timelimit=20;
    $mail->SMTPOptions=['ssl'=>['peer_name'=>$host,'verify_peer'=>true,'verify_peer_name'=>true,'allow_self_signed'=>false,'SNI_enabled'=>true,'crypto_method'=>STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT|STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT]];
    $mail->CharSet='UTF-8';$mail->Encoding='base64';$mail->SMTPDebug=0;
    $mail->setFrom($c['from_email'],$c['from_name']);
    if(!empty($c['reply_to']))$mail->addReplyTo($c['reply_to']);
    return $mail;
}
function check_smtp(array $account): void {
    $mail=smtp_client(account_config($account));
    try { if(!$mail->smtpConnect())throw new \RuntimeException(); }
    catch(\Throwable){throw new Problem('SMTP test failed. Check hostname, TLS, login and hosting port access.',502);}
    finally{$mail->smtpClose();}
}
function send_mail(array $account,array $campaign,array $recipient): array {
    $mail=null;
    try {
        $mail=smtp_client(account_config($account));
        // SendGrid owns its tracking pixel, so machine-open flags remain useful.
        $renderOptions=$campaign;
        if($account['provider']==='sendgrid'){$renderOptions['track_opens']=0;$renderOptions['track_clicks']=0;}
        $rendered=render_mail($renderOptions,$recipient);
        $mail->addAddress($recipient['email'],$recipient['name']);
        $mail->Subject=($recipient['is_test']?'[Test] ':'').$rendered['subject'];
        $mail->isHTML(true);$mail->Body=$rendered['html'];$mail->AltBody=$rendered['text'];
        $domain=explode('@',account_config($account)['from_email'])[1];
        $mail->MessageID='<'.$recipient['id'].'@'.$domain.'>';
        $mail->addCustomHeader('List-Unsubscribe','<'.$rendered['unsubscribe'].'>');
        $mail->addCustomHeader('List-Unsubscribe-Post','List-Unsubscribe=One-Click');
        if($account['provider']==='sendgrid')$mail->addCustomHeader('X-SMTPAPI',json_encode(sendgrid_metadata($campaign,$recipient),JSON_THROW_ON_ERROR));
        $mail->send();
        return ['status'=>'accepted','message_id'=>$mail->getLastMessageID(),'error'=>null];
    } catch(Problem $e) {
        return ['status'=>'failed','message_id'=>null,'error'=>$e->getMessage()];
    } catch(\Throwable) {
        // Do not infer failure from a lost acknowledgement after DATA.
        $error=$mail?->getSMTPInstance()->getError()??[];
        $smtpCode=(int)($error['smtp_code']??0);
        $definite=$smtpCode>=400&&$smtpCode<600;
        return ['status'=>$definite?'failed':'unknown','message_id'=>null,'error'=>$definite?'SMTP rejected this message. Review the account or recipient.':'Submission was not confirmed. Check provider history; automatic replay is disabled.'];
    } finally { $mail?->smtpClose(); }
}

function sendgrid_metadata(array $campaign,array $recipient): array {
    return ['unique_args'=>['sendzad_delivery_id'=>$recipient['id']], 'filters'=>[
        'opentrack'=>['settings'=>['enable'=>(int)(bool)$campaign['track_opens']]],
        'clicktrack'=>['settings'=>['enable'=>(int)(bool)$campaign['track_clicks'],'enable_text'=>false]],
    ]];
}
