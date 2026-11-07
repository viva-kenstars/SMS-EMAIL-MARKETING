package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

type API struct {
	engine   *Engine
	token    [32]byte
	slots    chan struct{}
	mu       sync.Mutex
	requests int
	window   time.Time
}

func NewAPI(e *Engine, token string) *API {
	return &API{engine: e, token: sha256.Sum256([]byte(token)), slots: make(chan struct{}, 4), window: time.Now()}
}
func jsonOut(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != "" {
		jsonOut(w, 403, map[string]string{"error": "server_to_server_only"})
		return
	}
	auth := r.Header.Get("Authorization")
	got := sha256.Sum256([]byte(strings.TrimPrefix(auth, "Bearer ")))
	if !strings.HasPrefix(auth, "Bearer ") || subtle.ConstantTimeCompare(got[:], a.token[:]) != 1 {
		jsonOut(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	if r.URL.Path == "/v1/health" && r.Method == "GET" {
		jsonOut(w, 200, map[string]any{"engine": "sendzad", "engine_version": Version, "smtp_enabled": a.engine.Enabled, "max_batch": 4, "acceptance_tested": false, "paid_fallback": false})
		return
	}
	if r.URL.Path != "/v1/verify" {
		jsonOut(w, 404, map[string]string{"error": "not_found"})
		return
	}
	if r.Method != "POST" {
		jsonOut(w, 405, map[string]string{"error": "post_required"})
		return
	}
	if !strings.EqualFold(strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0]), "application/json") {
		jsonOut(w, 415, map[string]string{"error": "json_required"})
		return
	}
	a.mu.Lock()
	if time.Since(a.window) >= time.Minute {
		a.requests = 0
		a.window = time.Now()
	}
	a.requests++
	limited := a.requests > 120
	a.mu.Unlock()
	if limited {
		w.Header().Set("Retry-After", "60")
		jsonOut(w, 429, map[string]string{"error": "rate_limited"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var body struct {
		Emails []string `json:"emails"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil {
		jsonOut(w, 400, map[string]string{"error": "invalid_request"})
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || len(body.Emails) < 1 || len(body.Emails) > 4 {
		jsonOut(w, 400, map[string]string{"error": "one_to_four_addresses_required"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 18*time.Second)
	defer cancel()
	results := make([]Result, len(body.Emails))
	var wg sync.WaitGroup
	positions := map[string][]int{}
	for i, address := range body.Emails {
		n, _, _ := normalize(address)
		positions[n] = append(positions[n], i)
	}
	for address, indexes := range positions {
		wg.Add(1)
		go func(address string, indexes []int) {
			defer wg.Done()
			var result Result
			select {
			case a.slots <- struct{}{}:
				defer func() { <-a.slots }()
				result = a.engine.Check(ctx, address)
			case <-ctx.Done():
				result = failure(baseResult(address), "service_busy", true)
			}
			for _, i := range indexes {
				results[i] = result
			}
		}(address, indexes)
	}
	wg.Wait()
	jsonOut(w, 200, map[string]any{"engine": "sendzad", "engine_version": Version, "results": results})
}
func loadDomains(path string) (map[string]bool, error) {
	if path == "" {
		return nil, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(b) > 4000000 {
		return nil, fmt.Errorf("domain list too large")
	}
	domains := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		s := strings.ToLower(strings.TrimSpace(line))
		if s == "" || strings.HasPrefix(s, "#") {
			continue
		}
		if !domainPattern.MatchString(s) {
			return nil, fmt.Errorf("invalid domain list")
		}
		domains[s] = true
	}
	return domains, nil
}
func main() {
	tokenFile := os.Getenv("VERIFY_TOKEN_FILE")
	stat, err := os.Stat(tokenFile)
	if err != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 {
		log.Fatal("VERIFY_TOKEN_FILE must be a private regular file, mode 0600")
	}
	data, err := os.ReadFile(tokenFile)
	token := strings.TrimSpace(string(data))
	if err != nil || len(token) < 32 || len(token) > 256 {
		log.Fatal("Invalid private token")
	}
	for _, r := range token {
		if r < 33 || r > 126 {
			log.Fatal("Invalid private token")
		}
	}
	// Never silently bypass an explicitly configured SMTP/SOCKS proxy.
	if os.Getenv("VERIFY_SMTP_PROXY") != "" || os.Getenv("ALL_PROXY") != "" || os.Getenv("all_proxy") != "" {
		log.Fatal("SMTP proxy routing unsupported. Use an approved direct-egress deployment; do not bypass required proxies")
	}
	domains, err := loadDomains(os.Getenv("VERIFY_DISPOSABLE_FILE"))
	if err != nil {
		log.Fatal("Cannot load disposable list")
	}
	e := &Engine{Hello: os.Getenv("VERIFY_HELO"), From: os.Getenv("VERIFY_FROM"), Enabled: os.Getenv("VERIFY_ENABLE_SMTP") == "true", RequireTLS: os.Getenv("VERIFY_REQUIRE_TLS") != "false", DisposableDomains: domains}
	e.init()
	if err = e.Validate(); err != nil {
		log.Fatal(err)
	}
	addr := os.Getenv("VERIFY_LISTEN")
	if addr == "" {
		addr = "127.0.0.1:8095"
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("Bind to loopback and use an HTTPS reverse proxy")
	}
	server := &http.Server{Addr: addr, Handler: NewAPI(e, token), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 22 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		_ = server.Shutdown(c)
	}()
	log.Printf("Sendzad verifier %s on loopback; SMTP enabled=%t", Version, e.Enabled)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal("Verifier server stopped")
	}
}
