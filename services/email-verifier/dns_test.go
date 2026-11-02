package main

import (
	"context"
	"encoding/binary"
	"net"
	"strings"
	"testing"
	"time"
)

func dnsName(s string) []byte {
	out := []byte{}
	for _, p := range strings.Split(strings.TrimSuffix(s, "."), ".") {
		if p != "" {
			out = append(out, byte(len(p)))
			out = append(out, []byte(p)...)
		}
	}
	return append(out, 0)
}
func dnsFixture(t *testing.T, mode string) *net.Resolver {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			b := make([]byte, 2048)
			n, peer, err := pc.ReadFrom(b)
			if err != nil {
				return
			}
			q := b[:n]
			if n < 17 {
				continue
			}
			end := 12
			for end < n && q[end] != 0 {
				end += int(q[end]) + 1
			}
			end++
			if end+4 > n {
				continue
			}
			kind := binary.BigEndian.Uint16(q[end : end+2])
			a := append([]byte{}, q[:end+4]...)
			a[2] = 0x81
			a[3] = 0x80
			for i := 6; i < 12; i++ {
				a[i] = 0
			}
			var data []byte
			if mode == "nx" {
				a[3] = 0x83
			} else if kind == 15 && mode == "null" {
				data = []byte{0, 0, 0}
			} else if kind == 15 && mode == "mx" {
				data = append([]byte{0, 10}, dnsName("mx.mail.test")...)
			} else if kind == 1 {
				data = []byte{93, 184, 216, 34}
			}
			if len(data) > 0 {
				a[7] = 1
				rr := []byte{0xc0, 0x0c, 0, byte(kind), 0, 1, 0, 0, 0, 30, 0, byte(len(data))}
				a = append(a, rr...)
				a = append(a, data...)
			}
			_, _ = pc.WriteTo(a, peer)
		}
	}()
	t.Cleanup(func() { pc.Close(); <-done })
	return &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "udp", pc.LocalAddr().String())
	}}
}
func TestRealDNSProtocol(t *testing.T) {
	for _, mode := range []string{"null", "nx", "mx", "fallback"} {
		t.Run(mode, func(t *testing.T) {
			e := testEngine()
			e.Resolver = dnsFixture(t, mode)
			f := (&fixture{}).start(t)
			f.attach(e)
			r := e.Check(context.Background(), "person@company.test")
			switch mode {
			case "null":
				check(t, r.Reason == "null_mx", r.Reason)
			case "nx":
				check(t, r.Reason == "no_mail_route" && r.Category == "invalid", r.Reason)
			default:
				check(t, r.Category == "valid", r.Reason)
			}
			f.assertNoSend(t)
		})
	}
}
