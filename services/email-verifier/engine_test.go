package main

import (
 "bufio"
 "context"
 "crypto/ecdsa"
 "crypto/elliptic"
 "crypto/rand"
 "crypto/tls"
 "crypto/x509"
 "crypto/x509/pkix"
 "encoding/json"
 "encoding/pem"
 "fmt"
 "io"
 "math/big"
 "net"
 "net/http"
 "net/http/httptest"
 "strings"
 "sync"
 "testing"
 "time"
)
type fakeDNS struct {mx []*net.MX;mxerr,iperr error;ips []net.IPAddr}
func(d *fakeDNS)LookupMX(context.Context,string)([]*net.MX,error){return append([]*net.MX{},d.mx...),d.mxerr}
func(d *fakeDNS)LookupIPAddr(context.Context,string)([]net.IPAddr,error){return d.ips,d.iperr}
func defaultDNS()*fakeDNS{return &fakeDNS{mx:[]*net.MX{{Host:"mx.mail.test.",Pref:10}},ips:[]net.IPAddr{{IP:net.ParseIP("93.184.216.34")}}}}
func testEngine()*Engine{e:=&Engine{Resolver:defaultDNS(),Hello:"verify.sender.test",From:"verify@sender.test",Enabled:true,Timeout:time.Second,HostInterval:time.Nanosecond};e.init();return e}
func check(t *testing.T,v bool,m string){t.Helper();if !v{t.Fatal(m)}}
type fixture struct{target,control,from,ehlo,greeting string;tlsConfig *tls.Config;dropTarget bool;pause time.Duration;mu sync.Mutex;commands []string;listener net.Listener;wg sync.WaitGroup}
func(f *fixture)start(t *testing.T)*fixture{
 t.Helper();l,err:=net.Listen("tcp","127.0.0.1:0");if err!=nil{t.Fatal(err)};f.listener=l;f.wg.Add(1)
 go func(){defer f.wg.Done();for{c,err:=l.Accept();if err!=nil{return};f.wg.Add(1);go func(){defer f.wg.Done();defer c.Close();f.handle(c)}()}}()
 t.Cleanup(func(){l.Close();f.wg.Wait()});return f
}
func response(v,fallback string)string{if v!=""{return v};return fallback}
func(f *fixture)handle(c net.Conn){
 _=c.SetDeadline(time.Now().Add(3*time.Second));fmt.Fprintf(c,"%s\r\n",response(f.greeting,"220 fixture ESMTP"));reader:=bufio.NewReader(c)
 for{line,err:=reader.ReadString('\n');if err!=nil{return};line=strings.TrimSpace(line);f.mu.Lock();f.commands=append(f.commands,line);f.mu.Unlock()
  switch{
  case strings.HasPrefix(line,"EHLO "):if f.ehlo!=""{fmt.Fprintf(c,"%s\r\n",f.ehlo)}else if f.tlsConfig!=nil{fmt.Fprint(c,"250-fixture\r\n250 STARTTLS\r\n")}else{fmt.Fprint(c,"250 fixture\r\n")}
  case line=="STARTTLS":fmt.Fprint(c,"220 ready\r\n");secure:=tls.Server(c,f.tlsConfig);if secure.Handshake()!=nil{return};c=secure;reader=bufio.NewReader(c)
  case strings.HasPrefix(line,"MAIL FROM:"):fmt.Fprintf(c,"%s\r\n",response(f.from,"250 2.1.0 ok"))
  case strings.HasPrefix(line,"RCPT TO:<sz-check-"):fmt.Fprintf(c,"%s\r\n",response(f.control,"550 5.1.1 no mailbox"))
  case strings.HasPrefix(line,"RCPT TO:"):if f.dropTarget{return};if f.pause>0{time.Sleep(f.pause)};fmt.Fprintf(c,"%s\r\n",response(f.target,"250 2.1.5 ok"))
  case line=="RSET":fmt.Fprint(c,"250 reset\r\n")
  case line=="QUIT":fmt.Fprint(c,"221 bye\r\n");return
  default:fmt.Fprint(c,"500 forbidden\r\n");return
  }
 }
}
func(f *fixture)attach(e *Engine){e.dial=func(ctx context.Context,target string)(net.Conn,error){if target!="93.184.216.34:25"{return nil,fmt.Errorf("unexpected pinned destination")};return (&net.Dialer{}).DialContext(ctx,"tcp",f.listener.Addr().String())}}
func(f *fixture)assertNoSend(t *testing.T){t.Helper();f.mu.Lock();defer f.mu.Unlock();for _,cmd:=range f.commands{for _,forbidden:=range []string{"DATA","AUTH","VRFY","EXPN"}{if strings.HasPrefix(cmd,forbidden){t.Fatal("forbidden command",cmd)}}}}
func TestSyntax(t *testing.T){for _,tt:=range []struct{in,normalized,reason string}{
 {"User+tag@EXAMPLE.COM","User+tag@example.com",""},{"first.last@sub.example.com","first.last@sub.example.com",""},
 {"bad@@example.com","","invalid_syntax"},{"a..b@example.com","","invalid_syntax"},{".abc@example.com","","invalid_syntax"},{"x@-example.com","","invalid_syntax"},{"x@example..com","","invalid_syntax"},{"x@localhost","","invalid_syntax"},{"x\r\nRCPT@example.com","","invalid_syntax"},{"x@ex ample.com","","invalid_syntax"},
 {"\"quoted\"@example.com","","unsupported_format"},{"user@[127.0.0.1]","","unsupported_format"},{"usu\u00e1rio@example.com","","unsupported_format"},{strings.Repeat("a",65)+"@example.com","","invalid_syntax"},{strings.Repeat("a",64)+"@example.com",strings.Repeat("a",64)+"@example.com",""},
 }{t.Run(tt.in,func(t *testing.T){n,_,r:=normalize(tt.in);check(t,r==tt.reason,r);if tt.normalized!=""{check(t,n==tt.normalized,n)}})}}
func TestPublicDestinations(t *testing.T){for _,ip:=range []string{"127.0.0.1","10.1.1.1","169.254.169.254","100.64.0.1","192.168.1.1","192.0.2.1","224.1.1.1","0.0.0.0","::1","::ffff:127.0.0.1","fe80::1","fc00::1","2001:db8::1","2002:7f00:1::1","64:ff9b::7f00:1"}{t.Run(ip,func(t *testing.T){check(t,!publicIP(net.ParseIP(ip)),"unsafe IP")})};for _,ip:=range []string{"8.8.8.8","93.184.216.34","2606:4700:4700::1111"}{check(t,publicIP(net.ParseIP(ip)),"public IP rejected")}}
func TestSMTPOutcomes(t *testing.T){cases:=[]struct{name string;f fixture;category,reason string;retry bool}{
 {"accepted",fixture{},"valid","recipient_accepted_non_catch_all",false},{"absent",fixture{target:"550 5.1.1 no user"},"invalid","recipient_rejected",false},
 {"temporary",fixture{target:"450 5.1.1 try later"},"unknown","recipient_temporary",true},{"policy",fixture{target:"550 5.7.1 blocked"},"unknown","recipient_policy_rejected",false},
 {"bare550",fixture{target:"550 denied"},"unknown","recipient_policy_rejected",false},{"full",fixture{target:"552 5.2.2 full"},"risky","mailbox_full",false},
 {"disabled",fixture{target:"550 5.2.1 disabled"},"invalid","recipient_rejected",false},{"forwarded",fixture{target:"251 forwarded"},"unknown","recipient_inconclusive",false},
 {"cannot_verify",fixture{target:"252 cannot verify"},"unknown","recipient_inconclusive",false},{"catch_all",fixture{control:"250 accepted"},"risky","catch_all",false},
 {"control_greylist",fixture{control:"451 4.7.1 greylisted"},"unknown","catch_all_inconclusive",true},{"control_policy",fixture{control:"550 5.7.1 policy"},"unknown","catch_all_inconclusive",false},
 {"sender_absent",fixture{from:"550 5.1.1 sender denied"},"unknown","sender_or_policy_rejected",false},{"sender_temporary",fixture{from:"451 unavailable"},"unknown","sender_or_policy_rejected",true},
 {"ehlo",fixture{ehlo:"550 policy"},"unknown","smtp_ehlo_failed",true},{"greeting",fixture{greeting:"421 unavailable"},"unknown","smtp_greeting_failed",true},{"interrupted",fixture{dropTarget:true},"unknown","smtp_interrupted",true},
 };for i:=range cases{tt:=&cases[i];t.Run(tt.name,func(t *testing.T){f:=tt.f.start(t);e:=testEngine();f.attach(e);r:=e.Check(context.Background(),"person@company.test");if r.Category!=tt.category||r.Reason!=tt.reason||r.Retryable!=tt.retry{t.Fatalf("%+v",r)};check(t,r.SpamTrap=="not_assessed","invented spamtrap result");f.assertNoSend(t)})}}
func TestRoleDisposable(t *testing.T){f:=(&fixture{}).start(t);e:=testEngine();f.attach(e);r:=e.Check(context.Background(),"sales@company.test");check(t,r.Role&&r.Category=="risky","role missing");e.DisposableDomains=map[string]bool{"trash.test":true};r=e.Check(context.Background(),"me@trash.test");check(t,r.Reason=="disposable_domain"&&r.SMTP=="not_checked","disposable probed");f.assertNoSend(t)}
func TestDNSFailures(t *testing.T){for _,tt:=range []struct{name string;dns *fakeDNS;reason,category string}{
 {"null",&fakeDNS{mx:[]*net.MX{{Host:".",Pref:0}}},"null_mx","invalid"},{"mixed_null",&fakeDNS{mx:[]*net.MX{{Host:".",Pref:0},{Host:"mx.mail.test.",Pref:5}}},"inconsistent_mx","unknown"},
 {"temporary",&fakeDNS{mxerr:&net.DNSError{IsTimeout:true}},"dns_temporary","unknown"},{"missing",&fakeDNS{mxerr:&net.DNSError{IsNotFound:true},iperr:&net.DNSError{IsNotFound:true}},"no_mail_route","invalid"},
 {"a_temporary",&fakeDNS{iperr:&net.DNSError{IsTimeout:true}},"dns_temporary","unknown"},{"private",&fakeDNS{mx:[]*net.MX{{Host:"mx.mail.test."}},ips:[]net.IPAddr{{IP:net.ParseIP("10.0.0.1")}}},"unsafe_destination","unknown"},
 {"mixed_ips",&fakeDNS{mx:[]*net.MX{{Host:"mx.mail.test."}},ips:[]net.IPAddr{{IP:net.ParseIP("8.8.8.8")},{IP:net.ParseIP("127.0.0.1")}}},"unsafe_destination","unknown"},
 }{t.Run(tt.name,func(t *testing.T){e:=testEngine();e.Resolver=tt.dns;e.dial=func(context.Context,string)(net.Conn,error){t.Error("unexpected probe");return nil,fmt.Errorf("blocked")};r:=e.Check(context.Background(),"a@company.test");check(t,r.Reason==tt.reason&&r.Category==tt.category,r.Reason)})}
 t.Run("implicit_mx",func(t *testing.T){e:=testEngine();d:=defaultDNS();d.mx=nil;e.Resolver=d;f:=(&fixture{}).start(t);f.attach(e);r:=e.Check(context.Background(),"a@company.test");check(t,r.Category=="valid"&&r.MX=="company.test",r.Reason)})}
func TestCachingAndBounds(t *testing.T){
 t.Run("cache",func(t *testing.T){e:=testEngine();f:=(&fixture{}).start(t);f.attach(e);r1:=e.Check(context.Background(),"A@company.test");r2:=e.Check(context.Background(),"A@COMPANY.TEST");check(t,r1.Category=="valid"&&r2.Cached&&r1.CheckedAt==r2.CheckedAt,"cache")})
 t.Run("cooldown",func(t *testing.T){e:=testEngine();e.HostInterval=time.Minute;f:=(&fixture{}).start(t);f.attach(e);e.Check(context.Background(),"A@company.test");r:=e.Check(context.Background(),"B@other.test");check(t,r.Reason=="provider_cooldown"&&r.Retryable,"MX throttle")})
 t.Run("deadline",func(t *testing.T){e:=testEngine();e.Timeout=30*time.Millisecond;f:=(&fixture{pause:80*time.Millisecond}).start(t);f.attach(e);start:=time.Now();r:=e.Check(context.Background(),"a@company.test");check(t,r.Category=="unknown"&&r.Retryable&&time.Since(start)<200*time.Millisecond,"deadline")})
 t.Run("disabled",func(t *testing.T){e:=testEngine();e.Enabled=false;r:=e.Check(context.Background(),"a@company.test");check(t,r.Reason=="smtp_disabled"&&r.Category=="unknown","DNS falsely verified")})
}
func cert(t *testing.T)(tls.Certificate,*x509.CertPool){key,err:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader);if err!=nil{t.Fatal(err)};tmpl:=&x509.Certificate{SerialNumber:big.NewInt(1),Subject:pkix.Name{CommonName:"fixture"},DNSNames:[]string{"mx.mail.test"},NotBefore:time.Now().Add(-time.Hour),NotAfter:time.Now().Add(time.Hour),KeyUsage:x509.KeyUsageDigitalSignature|x509.KeyUsageCertSign,ExtKeyUsage:[]x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},BasicConstraintsValid:true,IsCA:true};der,err:=x509.CreateCertificate(rand.Reader,tmpl,tmpl,&key.PublicKey,key);if err!=nil{t.Fatal(err)};pk,_:=x509.MarshalECPrivateKey(key);c,err:=tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type:"CERTIFICATE",Bytes:der}),pem.EncodeToMemory(&pem.Block{Type:"EC PRIVATE KEY",Bytes:pk}));if err!=nil{t.Fatal(err)};pool:=x509.NewCertPool();parsed,_:=x509.ParseCertificate(der);pool.AddCert(parsed);return c,pool}
func TestSTARTTLS(t *testing.T){c,pool:=cert(t)
 t.Run("trusted",func(t *testing.T){e:=testEngine();e.RequireTLS=true;e.tlsConfig=&tls.Config{RootCAs:pool,MinVersion:tls.VersionTLS12};f:=(&fixture{tlsConfig:&tls.Config{Certificates:[]tls.Certificate{c}}}).start(t);f.attach(e);r:=e.Check(context.Background(),"a@company.test");check(t,r.Category=="valid",r.Reason);f.assertNoSend(t)})
 t.Run("untrusted",func(t *testing.T){e:=testEngine();e.RequireTLS=true;f:=(&fixture{tlsConfig:&tls.Config{Certificates:[]tls.Certificate{c}}}).start(t);f.attach(e);r:=e.Check(context.Background(),"a@company.test");check(t,r.Reason=="tls_failed"&&r.Category=="unknown",r.Reason)})
 t.Run("unavailable",func(t *testing.T){e:=testEngine();e.RequireTLS=true;f:=(&fixture{}).start(t);f.attach(e);r:=e.Check(context.Background(),"a@company.test");check(t,r.Reason=="tls_unavailable",r.Reason)})
}
func TestBackupMX(t *testing.T){e:=testEngine();d:=defaultDNS();d.mx=[]*net.MX{{Host:"first.mail.test.",Pref:0},{Host:"mx.mail.test.",Pref:10}};e.Resolver=d;f:=(&fixture{}).start(t);attempt:=0;e.dial=func(ctx context.Context,_ string)(net.Conn,error){attempt++;if attempt==1{return nil,fmt.Errorf("preferred unavailable")};return (&net.Dialer{}).DialContext(ctx,"tcp",f.listener.Addr().String())};r:=e.Check(context.Background(),"a@company.test");check(t,r.Category=="unknown"&&r.Reason=="backup_mx_inconclusive"&&r.Retryable,r.Reason);f.assertNoSend(t)}
func TestHTTPContract(t *testing.T){e:=testEngine();f:=(&fixture{}).start(t);f.attach(e);token:=strings.Repeat("T",40);a:=NewAPI(e,token);server:=httptest.NewServer(a);defer server.Close()
 for _,tt:=range []struct{name,method,path,body,token,origin string;want int}{
 {"missing","GET","/v1/health","","","",401},{"wrong","GET","/v1/health","","wrong","",401},{"health","GET","/v1/health","",token,"",200},{"origin","GET","/v1/health","",token,"https://evil.test",403},
 {"method","GET","/v1/verify","",token,"",405},{"send_endpoint","POST","/send","{}",token,"",404},{"empty","POST","/v1/verify","{\"emails\":[]}",token,"",400},
 {"extra","POST","/v1/verify","{\"emails\":[\"a@company.test\"],\"host\":\"127.0.0.1\"}",token,"",400},{"trailing","POST","/v1/verify","{} {}",token,"",400},{"oversize","POST","/v1/verify",strings.Repeat("x",4100),token,"",400},
 {"too_many","POST","/v1/verify","{\"emails\":[\"a\",\"b\",\"c\",\"d\",\"e\"]}",token,"",400},{"duplicates","POST","/v1/verify","{\"emails\":[\"A@company.test\",\"A@COMPANY.TEST\"]}",token,"",200},
 }{t.Run(tt.name,func(t *testing.T){req,_:=http.NewRequest(tt.method,server.URL+tt.path,strings.NewReader(tt.body));req.Header.Set("Content-Type","application/json");if tt.token!=""{req.Header.Set("Authorization","Bearer "+tt.token)};req.Header.Set("Origin",tt.origin);resp,err:=http.DefaultClient.Do(req);if err!=nil{t.Fatal(err)};defer resp.Body.Close();b,_:=io.ReadAll(resp.Body);check(t,resp.StatusCode==tt.want,string(b));check(t,!strings.Contains(string(b),token),"token leaked");if tt.name=="duplicates"{var out struct{Results []Result `json:"results"`};if json.Unmarshal(b,&out)!=nil{t.Fatal("bad JSON")};check(t,len(out.Results)==2&&out.Results[0].Category=="valid"&&out.Results[1].Category=="valid","dedup")}})}
 t.Run("rate_limit",func(t *testing.T){a.mu.Lock();a.requests=120;a.mu.Unlock();req,_:=http.NewRequest("POST",server.URL+"/v1/verify",strings.NewReader(`{"emails":["a@b.test"]}`));req.Header.Set("Content-Type","application/json");req.Header.Set("Authorization","Bearer "+token);resp,err:=http.DefaultClient.Do(req);if err!=nil{t.Fatal(err)};resp.Body.Close();check(t,resp.StatusCode==429,"rate limit")});f.assertNoSend(t)
}
