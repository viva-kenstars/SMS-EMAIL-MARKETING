package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type auditResolver struct {
	mx  []*net.MX
	ips []net.IPAddr
	err error
}

func (r auditResolver) LookupMX(context.Context, string) ([]*net.MX, error) { return r.mx, r.err }
func (r auditResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return r.ips, r.err
}
func auditEngine() *Engine {
	e := &Engine{Hello: "verify.example.test", From: "verifier@example.test", Enabled: true, Timeout: time.Second}
	e.init()
	return e
}

func TestAuditSyntaxContract(t *testing.T) {
	for _, s := range []string{"bad", "bad@@example.com", "bad..part@example.com", "user@-bad.com"} {
		t.Run(s, func(t *testing.T) {
			r := auditEngine().Check(context.Background(), s)
			if r.Category != "invalid" || r.Syntax != "invalid" {
				t.Fatalf("invalid contract: %+v", r)
			}
		})
	}
}
func TestAuditUnsupportedAddresses(t *testing.T) {
	for _, s := range []string{"\"a b\"@example.com", "\"a@b\"@example.com", "person@[192.0.2.1]", "na\u00efve@example.com"} {
		t.Run(s, func(t *testing.T) {
			r := auditEngine().Check(context.Background(), s)
			if r.Category != "unknown" || r.Reason != "unsupported_format" {
				t.Fatalf("unsupported is not invalid: %+v", r)
			}
		})
	}
}
func TestAuditSMTPContradiction(t *testing.T) {
	for _, tc := range []struct {
		code      int
		msg, want string
	}{
		{250, "5.1.1 unavailable", "inconclusive"}, {250, "2.1.5 accepted", "accepted"},
		{450, "4.2.0 later", "temporary"}, {450, "5.1.1 retry", "temporary"}, {550, "5.1.1 no such recipient", "absent"},
		{550, "policy rejected (see 5.1.1 documentation)", "policy"}, {550, "unavailable", "policy"},
		{251, "2.1.5 forwarding", "inconclusive"}, {550, "5.7.1 blocked", "policy"},
	} {
		t.Run(fmt.Sprint(tc.code, "_", tc.msg), func(t *testing.T) {
			if got := smtpClass(tc.code, tc.msg); got != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
}
func TestAuditDNSAndDestination(t *testing.T) {
	cases := []struct {
		name string
		r    auditResolver
		want string
	}{
		{"null_mx", auditResolver{mx: []*net.MX{{Host: ".", Pref: 0}}}, "null_mx"},
		{"mixed_null", auditResolver{mx: []*net.MX{{Host: ".", Pref: 0}, {Host: "mx.example.test", Pref: 1}}}, "inconsistent_mx"},
		{"timeout", auditResolver{err: &net.DNSError{IsTimeout: true}}, "dns_temporary"},
		{"absent", auditResolver{err: &net.DNSError{IsNotFound: true}}, "no_mail_route"},
		{"private_mx", auditResolver{mx: []*net.MX{{Host: "mx.example.test"}}, ips: []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}}, "unsafe_destination"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := auditEngine()
			e.Resolver = tc.r
			e.dial = func(context.Context, string) (net.Conn, error) { t.Fatal("must not dial"); return nil, nil }
			got := e.Check(context.Background(), "person@example.test")
			if got.Reason != tc.want {
				t.Fatalf("%+v", got)
			}
		})
	}
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "192.0.2.1"} {
		t.Run("deny_"+address, func(t *testing.T) {
			if publicIP(net.ParseIP(address)) {
				t.Fatal("unsafe address accepted")
			}
		})
	}
}

// Protocol fixture: the engine really speaks SMTP over net.Pipe. The resolver and
// dialer are test-only injected dependencies; no public mailbox is contacted.
func auditProbe(t *testing.T, recipient, control string) Result {
	t.Helper()
	e := auditEngine()
	e.Resolver = auditResolver{mx: []*net.MX{{Host: "mx.example.test"}}, ips: []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}}
	var wg sync.WaitGroup
	e.dial = func(context.Context, string) (net.Conn, error) {
		client, server := net.Pipe()
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer server.Close()
			server.SetDeadline(time.Now().Add(2 * time.Second))
			fmt.Fprint(server, "220 fixture\r\n")
			scan := bufio.NewScanner(server)
			for scan.Scan() {
				line := scan.Text()
				var reply string
				switch {
				case strings.HasPrefix(line, "EHLO "):
					reply = "250 fixture"
				case strings.HasPrefix(line, "MAIL FROM:"):
					reply = "250 2.1.0 accepted"
				case strings.HasPrefix(line, "RCPT TO:<sz-check-"):
					reply = control
				case strings.HasPrefix(line, "RCPT TO:"):
					reply = recipient
				case line == "RSET":
					reply = "250 reset"
				case line == "QUIT":
					fmt.Fprint(server, "221 bye\r\n")
					return
				default:
					t.Errorf("forbidden/unexpected SMTP command: %q", line)
					return
				}
				fmt.Fprint(server, reply+"\r\n")
			}
		}()
		return client, nil
	}
	r := e.Check(context.Background(), "person@example.test")
	wg.Wait()
	return r
}
func TestAuditSMTPProtocol(t *testing.T) {
	for _, tc := range []struct{ name, target, control, category string }{
		{"valid", "250 2.1.5 accepted", "550 5.1.1 absent", "valid"},
		{"catch_all", "250 2.1.5 accepted", "250 2.1.5 accepted", "risky"},
		{"absent", "550 5.1.1 absent", "", "invalid"},
		{"temporary", "450 4.2.0 later", "", "unknown"},
		{"policy", "550 5.7.1 blocked", "", "unknown"},
		{"contradiction", "250 5.1.1 absent", "550 5.1.1 absent", "unknown"},
		{"control_policy", "250 2.1.5 accepted", "550 5.7.1 blocked", "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := auditProbe(t, tc.target, tc.control)
			if r.Category != tc.category {
				t.Fatalf("%+v", r)
			}
		})
	}
}
func TestAuditEmitContract(t *testing.T) {
	path := os.Getenv("SENDZAD_AUDIT_FIXTURES")
	if path == "" {
		t.Skip("fixture export not requested")
	}
	e := auditEngine()
	e.Resolver = auditResolver{mx: []*net.MX{{Host: ".", Pref: 0}}}
	rows := []Result{auditProbe(t, "250 2.1.5 accepted", "550 5.1.1 absent"), auditEngine().Check(context.Background(), "bad-address"), e.Check(context.Background(), "person@null.example.test")}
	for i, r := range rows {
		if i == 0 && r.Category != "valid" {
			t.Fatal("fixture invalid")
		}
	}
	b, err := json.Marshal(map[string]any{"engine": "sendzad", "engine_version": Version, "results": rows})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestAuditHTTPContract(t *testing.T) {
	e := auditEngine()
	server := httptest.NewServer(NewAPI(e, "fixture-private-token-not-for-production"))
	defer server.Close()
	for _, tc := range []struct {
		name, method, path, mime, auth, origin, body string
		status                                       int
	}{
		{"no_auth", "GET", "/v1/health", "", "", "", "", 401},
		{"browser_block", "GET", "/v1/health", "", "Bearer fixture-private-token-not-for-production", "https://browser.test", "", 403},
		{"health", "GET", "/v1/health", "", "Bearer fixture-private-token-not-for-production", "", "", 200},
		{"wrong_method", "GET", "/v1/verify", "", "Bearer fixture-private-token-not-for-production", "", "", 405},
		{"bad_mime", "POST", "/v1/verify", "application/json-fake", "Bearer fixture-private-token-not-for-production", "", `{"emails":["bad"]}`, 415},
		{"invalid_address", "POST", "/v1/verify", "application/json", "Bearer fixture-private-token-not-for-production", "", `{"emails":["bad"]}`, 200},
		{"extra_fields", "POST", "/v1/verify", "application/json", "Bearer fixture-private-token-not-for-production", "", `{"emails":["bad"],"host":"127.0.0.1"}`, 400},
		{"too_many", "POST", "/v1/verify", "application/json", "Bearer fixture-private-token-not-for-production", "", `{"emails":["a","b","c","d","e"]}`, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest(tc.method, server.URL+tc.path, strings.NewReader(tc.body))
			req.Header.Set("Authorization", tc.auth)
			req.Header.Set("Origin", tc.origin)
			req.Header.Set("Content-Type", tc.mime)
			res, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			b, _ := io.ReadAll(res.Body)
			if res.StatusCode != tc.status {
				t.Fatalf("status %d: %s", res.StatusCode, b)
			}
			if tc.name == "invalid_address" && !strings.Contains(string(b), `"syntax":"invalid"`) {
				t.Fatalf("%s", b)
			}
			if tc.name == "health" && !strings.Contains(string(b), `"acceptance_tested":false`) {
				t.Fatal("health must not imply mailbox acceptance")
			}
		})
	}
}
func TestAuditMultilineContradiction(t *testing.T) {
	for _, message := range []string{"2.1.5 accepted\n5.1.1 absent", "2.1.5 accepted\n2.1.1 inconsistent", "accepted\n5.1.1 absent"} {
		if smtpClass(250, message) != "inconclusive" {
			t.Fatalf("accepted: %s", message)
		}
	}
}
