// Original Sendzad verification engine: no DATA, AUTH, VRFY or EXPN commands.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/textproto"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const Version = "1.0.1"

type Result struct {
	Email      string `json:"email"`
	Engine     string `json:"engine"`
	Version    string `json:"engine_version"`
	Category   string `json:"category"`
	Reason     string `json:"reason"`
	CheckedAt  int64  `json:"checked_at"`
	Retryable  bool   `json:"retryable"`
	RetryAfter int    `json:"retry_after_seconds,omitempty"`
	Syntax     string `json:"syntax"`
	Route      string `json:"mail_route"`
	SMTP       string `json:"smtp"`
	CatchAll   *bool  `json:"catch_all"`
	Role       bool   `json:"role_account"`
	Disposable string `json:"disposable"`
	SpamTrap   string `json:"spam_trap"`
	MX         string `json:"mx,omitempty"`
	Stage      string `json:"stage,omitempty"`
	Code       int    `json:"smtp_code,omitempty"`
	Cached     bool   `json:"cached"`
}
type Resolver interface {
	LookupMX(context.Context, string) ([]*net.MX, error)
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}
type cachedResult struct {
	value Result
	until time.Time
}
type cachedRoute struct {
	hosts  []string
	reason string
	retry  bool
	until  time.Time
}
type gate struct {
	busy bool
	next time.Time
}
type Engine struct {
	Resolver              Resolver
	Hello, From           string
	Enabled, RequireTLS   bool
	Timeout, HostInterval time.Duration
	DisposableDomains     map[string]bool
	// Test-only injection points. There are no request/config overrides for destinations or TLS trust.
	dial      func(context.Context, string) (net.Conn, error)
	tlsConfig *tls.Config
	mu        sync.Mutex
	cache     map[[32]byte]cachedResult
	routes    map[string]cachedRoute
	gates     map[string]gate
}

var domainPattern = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$`)
var localPattern = regexp.MustCompile("^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.-]+$")
var enhancedPattern = regexp.MustCompile(`^([245]\.[0-9]{1,3}\.[0-9]{1,3})(?:\s|$)`)
var roles = map[string]bool{"admin": true, "info": true, "support": true, "sales": true, "contact": true, "billing": true, "abuse": true, "postmaster": true, "noreply": true, "no-reply": true}

func normalize(raw string) (string, string, string) {
	s := strings.TrimSpace(raw)
	for _, r := range s {
		if r < 32 || r == 127 {
			return s, "", "invalid_syntax"
		}
	}
	// Valid but unsupported quoted/EAI/literal forms must not be called nonexistent.
	if strings.Contains(s, "@") {
		if strings.ContainsAny(s, "\"\\") || strings.Contains(s, "@[") {
			return s, "", "unsupported_format"
		}
		for _, r := range s {
			if r > 127 {
				return s, "", "unsupported_format"
			}
		}
	}
	if strings.Count(s, "@") != 1 {
		return s, "", "invalid_syntax"
	}
	parts := strings.Split(s, "@")
	local, domain := parts[0], strings.ToLower(parts[1])
	if len(s) > 254 || len(local) > 64 || len(domain) > 253 || len(local) == 0 {
		return s, "", "invalid_syntax"
	}
	for _, r := range s {
		if r > 127 {
			return s, "", "unsupported_format"
		}
	}
	if strings.ContainsAny(local, "\"\\") || strings.HasPrefix(domain, "[") {
		return s, "", "unsupported_format"
	}
	if !localPattern.MatchString(local) || strings.HasPrefix(local, ".") || strings.HasSuffix(local, ".") || strings.Contains(local, "..") || !domainPattern.MatchString(domain) {
		return s, "", "invalid_syntax"
	}
	return local + "@" + domain, domain, ""
}
func baseResult(address string) Result {
	return Result{Email: address, Engine: "sendzad", Version: Version, Category: "unknown", Reason: "not_checked", CheckedAt: time.Now().Unix(), Syntax: "valid", Route: "not_checked", SMTP: "not_checked", Disposable: "not_assessed", SpamTrap: "not_assessed"}
}
func (e *Engine) init() {
	if e.Resolver == nil {
		e.Resolver = net.DefaultResolver
	}
	if e.Timeout == 0 {
		e.Timeout = 15 * time.Second
	}
	if e.HostInterval == 0 {
		e.HostInterval = 2 * time.Second
	}
	e.cache = make(map[[32]byte]cachedResult)
	e.routes = make(map[string]cachedRoute)
	e.gates = make(map[string]gate)
}
func failure(r Result, reason string, retry bool) Result {
	r.Reason = reason
	r.Retryable = retry
	r.RetryAfter = 0
	if retry {
		r.RetryAfter = 60
	}
	return r
}
func (e *Engine) Check(ctx context.Context, raw string) Result {
	address, domain, why := normalize(raw)
	r := baseResult(address)
	if why != "" {
		r.Syntax = why
		r.Reason = why
		if why == "invalid_syntax" {
			r.Syntax = "invalid"
			r.Category = "invalid"
		}
		return r
	}
	r.Role = roles[strings.ToLower(strings.Split(address, "@")[0])]
	if e.DisposableDomains != nil {
		r.Disposable = "not_listed"
		if e.DisposableDomains[domain] {
			r.Disposable = "listed"
			r.Category = "risky"
			r.Reason = "disposable_domain"
			return r
		}
	}
	key := sha256.Sum256([]byte(address))
	e.mu.Lock()
	hit, ok := e.cache[key]
	e.mu.Unlock()
	if ok && time.Now().Before(hit.until) {
		r = hit.value
		r.Cached = true
		return r
	}
	ctx, cancel := context.WithTimeout(ctx, e.Timeout)
	defer cancel()
	hosts, why, retry := e.mailRoute(ctx, domain)
	if why != "" {
		r.Route = why
		r = failure(r, why, retry)
		if why == "null_mx" || why == "no_mail_route" {
			r.Category = "invalid"
		}
		return e.save(key, r)
	}
	r.Route = "present"
	if !e.Enabled {
		return failure(r, "smtp_disabled", false)
	}
	clean := r
	for index, host := range hosts {
		r = clean
		r.MX = host
		if !e.reserve(host) {
			return failure(r, "provider_cooldown", true)
		}
		outcome, connected := e.probe(ctx, r, host, address, domain)
		e.release(host, outcome)
		r = outcome
		// Backup receivers can accept addresses without validating the final mailbox.
		if index > 0 && r.Category == "valid" {
			r.Category = "unknown"
			r = failure(r, "backup_mx_inconclusive", true)
		}
		if connected || ctx.Err() != nil || r.Reason == "unsafe_destination" {
			break
		}
	}
	return e.save(key, r)
}
func (e *Engine) save(key [32]byte, r Result) Result {
	if r.Retryable {
		return r
	}
	ttl := time.Minute
	if r.Category == "valid" {
		ttl = 30 * time.Minute
	}
	if r.Category == "invalid" {
		ttl = 10 * time.Minute
	}
	if r.Category == "risky" {
		ttl = 5 * time.Minute
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.cache) >= 10000 {
		e.cache = make(map[[32]byte]cachedResult)
	}
	e.cache[key] = cachedResult{r, time.Now().Add(ttl)}
	return r
}
func (e *Engine) mailRoute(ctx context.Context, domain string) ([]string, string, bool) {
	e.mu.Lock()
	hit, ok := e.routes[domain]
	e.mu.Unlock()
	if ok && time.Now().Before(hit.until) {
		return hit.hosts, hit.reason, hit.retry
	}
	mx, err := e.Resolver.LookupMX(ctx, domain)
	hosts := []string{}
	reason := ""
	retry := false
	if err != nil {
		var de *net.DNSError
		if !errors.As(err, &de) || !de.IsNotFound {
			return nil, "dns_temporary", true
		}
	}
	if len(mx) > 0 {
		sort.SliceStable(mx, func(i, j int) bool { return mx[i].Pref < mx[j].Pref })
		for _, m := range mx {
			if m.Host == "." {
				if len(mx) == 1 && m.Pref == 0 {
					return nil, "null_mx", false
				}
				return nil, "inconsistent_mx", false
			}
		}
		seen := map[string]bool{}
		for _, m := range mx {
			h := strings.ToLower(strings.TrimSuffix(m.Host, "."))
			if !domainPattern.MatchString(h) {
				return nil, "invalid_mx", false
			}
			if !seen[h] {
				hosts = append(hosts, h)
				seen[h] = true
			}
			if len(hosts) >= 3 {
				break
			}
		}
	} else {
		ips, iperr := e.Resolver.LookupIPAddr(ctx, domain)
		if iperr != nil {
			var de *net.DNSError
			if errors.As(iperr, &de) && de.IsNotFound {
				reason = "no_mail_route"
			} else {
				reason = "dns_temporary"
				retry = true
			}
		} else if len(ips) == 0 {
			reason = "no_mail_route"
		} else {
			hosts = append(hosts, domain)
		}
	}
	// net.Resolver does not expose DNS TTLs. Cache only for a short bounded interval.
	if !retry {
		e.mu.Lock()
		if len(e.routes) >= 5000 {
			e.routes = make(map[string]cachedRoute)
		}
		e.routes[domain] = cachedRoute{hosts, reason, retry, time.Now().Add(time.Minute)}
		e.mu.Unlock()
	}
	return hosts, reason, retry
}
func (e *Engine) reserve(host string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	g := e.gates[host]
	if g.busy || time.Now().Before(g.next) {
		return false
	}
	if len(e.gates) >= 10000 {
		for k, v := range e.gates {
			if !v.busy && time.Now().After(v.next) {
				delete(e.gates, k)
			}
		}
		if len(e.gates) >= 10000 {
			return false
		}
	}
	g.busy = true
	e.gates[host] = g
	return true
}
func (e *Engine) release(host string, r Result) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delay := e.HostInterval
	if r.Retryable || strings.Contains(r.Reason, "policy") {
		delay = time.Minute
	}
	e.gates[host] = gate{next: time.Now().Add(delay)}
}

var blockedNetworks = []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "2001::/23", "2001:db8::/32", "2002::/16"}

func publicIP(ip net.IP) bool {
	a, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	a = a.Unmap()
	if !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() {
		return false
	}
	if a.Is6() && !netip.MustParsePrefix("2000::/3").Contains(a) {
		return false
	}
	for _, p := range blockedNetworks {
		if netip.MustParsePrefix(p).Contains(a) {
			return false
		}
	}
	return true
}
func (e *Engine) connect(ctx context.Context, host string) (net.Conn, string) {
	ips, err := e.Resolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, "dns_temporary"
	}
	for _, ip := range ips {
		if !publicIP(ip.IP) {
			return nil, "unsafe_destination"
		}
	}
	d := net.Dialer{Timeout: 4 * time.Second}
	for i, ip := range ips {
		if i >= 2 {
			break
		}
		target := net.JoinHostPort(ip.IP.String(), "25")
		var c net.Conn
		if e.dial != nil {
			c, err = e.dial(ctx, target)
		} else {
			c, err = d.DialContext(ctx, "tcp", target)
		}
		if err == nil {
			return c, ""
		}
		if ctx.Err() != nil {
			break
		}
	}
	return nil, "connection_unavailable"
}

type smtpSession struct {
	reader *textproto.Reader
	writer *bufio.Writer
}

func session(c net.Conn) *smtpSession {
	return &smtpSession{textproto.NewReader(bufio.NewReader(io.LimitReader(c, 65536))), bufio.NewWriter(c)}
}
func (s *smtpSession) command(cmd string) (int, string, error) {
	if _, err := s.writer.WriteString(cmd + "\r\n"); err != nil {
		return 0, "", err
	}
	if err := s.writer.Flush(); err != nil {
		return 0, "", err
	}
	return s.reader.ReadResponse(0)
}
func smtpClass(code int, message string) string {
	// A primary 4xx response remains temporary even if its enhanced code is malformed.
	if code >= 400 && code < 500 {
		return "temporary"
	}
	m := enhancedPattern.FindStringSubmatch(strings.TrimSpace(message))
	enhanced := ""
	if len(m) > 1 {
		enhanced = m[1]
	}
	// RFC 2034 requires matching enhanced codes at the start of every reply line.
	for _, line := range strings.Split(strings.TrimSpace(message), "\n")[1:] {
		other := enhancedPattern.FindStringSubmatch(strings.TrimSpace(line))
		if (enhanced != "" && (len(other) < 2 || other[1] != enhanced)) ||
			(enhanced == "" && len(other) > 1) {
			return "inconclusive"
		}
	}
	if enhanced != "" && int(enhanced[0]-'0') != code/100 {
		return "inconclusive"
	}
	if code >= 500 && code < 600 {
		switch enhanced {
		case "5.1.1", "5.1.3", "5.2.1":
			return "absent"
		case "5.2.2":
			return "full"
		}
		return "policy"
	}
	if code == 250 {
		return "accepted"
	}
	return "inconclusive"
}
func (e *Engine) probe(ctx context.Context, r Result, host, address, domain string) (Result, bool) {
	c, why := e.connect(ctx, host)
	if c == nil {
		return failure(r, why, why != "unsafe_destination"), false
	}
	defer c.Close()
	deadline, _ := ctx.Deadline()
	_ = c.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	s := session(c)
	r.Stage = "greeting"
	code, _, err := s.reader.ReadResponse(0)
	if err != nil || code != 220 {
		return failure(r, "smtp_greeting_failed", true), true
	}
	r.Stage = "ehlo"
	code, msg, err := s.command("EHLO " + e.Hello)
	if err != nil || code != 250 {
		return failure(r, "smtp_ehlo_failed", true), true
	}
	hasTLS := false
	for _, line := range strings.Split(msg, "\n") {
		if strings.EqualFold(strings.TrimSpace(line), "STARTTLS") {
			hasTLS = true
		}
	}
	if hasTLS {
		r.Stage = "starttls"
		code, _, err = s.command("STARTTLS")
		if err != nil || code != 220 {
			return failure(r, "tls_failed", true), true
		}
		cfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: host}
		if e.tlsConfig != nil {
			cfg = e.tlsConfig.Clone()
			cfg.ServerName = host
		}
		secure := tls.Client(c, cfg)
		if err = secure.HandshakeContext(ctx); err != nil {
			return failure(r, "tls_failed", true), true
		}
		s = session(secure)
		code, _, err = s.command("EHLO " + e.Hello)
		if err != nil || code != 250 {
			return failure(r, "smtp_ehlo_failed", true), true
		}
	} else if e.RequireTLS {
		return failure(r, "tls_unavailable", false), true
	}
	r.Stage = "mail_from"
	code, _, err = s.command("MAIL FROM:<" + e.From + ">")
	if err != nil {
		return failure(r, "smtp_interrupted", true), true
	}
	if code != 250 {
		r.Code = code
		return failure(r, "sender_or_policy_rejected", code >= 400 && code < 500), true
	}
	r.Stage = "rcpt_to"
	code, msg, err = s.command("RCPT TO:<" + address + ">")
	r.Code = code
	if err != nil {
		return failure(r, "smtp_interrupted", true), true
	}
	r.SMTP = smtpClass(code, msg)
	switch r.SMTP {
	case "absent":
		r.Category = "invalid"
		r.Reason = "recipient_rejected"
		return r, true
	case "full":
		r.Category = "risky"
		r.Reason = "mailbox_full"
		return r, true
	case "temporary":
		return failure(r, "recipient_temporary", true), true
	case "policy":
		return failure(r, "recipient_policy_rejected", false), true
	case "accepted":
	default:
		return failure(r, "recipient_inconclusive", false), true
	}
	// Control address uses a separate envelope. A policy failure is not proof of non-catch-all.
	r.Stage = "catch_all"
	code, _, err = s.command("RSET")
	if err != nil || code != 250 {
		return failure(r, "catch_all_inconclusive", true), true
	}
	code, _, err = s.command("MAIL FROM:<" + e.From + ">")
	if err != nil || code != 250 {
		return failure(r, "catch_all_inconclusive", true), true
	}
	random := make([]byte, 16)
	if _, err = rand.Read(random); err != nil {
		return failure(r, "entropy_unavailable", true), true
	}
	code, msg, err = s.command("RCPT TO:<sz-check-" + hex.EncodeToString(random) + "@" + domain + ">")
	if err != nil {
		return failure(r, "catch_all_inconclusive", true), true
	}
	switch smtpClass(code, msg) {
	case "accepted":
		v := true
		r.CatchAll = &v
		r.Category = "risky"
		r.Reason = "catch_all"
	case "absent":
		v := false
		r.CatchAll = &v
		r.Category = "valid"
		r.Reason = "recipient_accepted_non_catch_all"
		if r.Role {
			r.Category = "risky"
			r.Reason = "role_account"
		}
	default:
		return failure(r, "catch_all_inconclusive", code >= 400 && code < 500), true
	}
	_, _, _ = s.command("QUIT")
	return r, true
}
func (e *Engine) Validate() error {
	if !domainPattern.MatchString(e.Hello) {
		return fmt.Errorf("VERIFY_HELO must be a hostname you control")
	}
	_, _, why := normalize(e.From)
	if why != "" {
		return fmt.Errorf("VERIFY_FROM must be a valid address on your domain")
	}
	return nil
}
