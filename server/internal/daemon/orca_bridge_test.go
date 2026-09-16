package daemon

import (
	"context"
	"testing"
	"time"
)

func TestOrcaBridgeEnvDisabledByDefault(t *testing.T) {
	t.Setenv(orcaBridgeEnvFlag, "")
	if env := orcaBridgeEnv(context.Background(), "/tmp/run/workdir", "claude", nil); env != nil {
		t.Fatalf("bridge must stay off without %s; got %v", orcaBridgeEnvFlag, env)
	}
}

func TestOrcaBridgeEnvSkipsProvidersWithoutOrcaHooks(t *testing.T) {
	t.Setenv(orcaBridgeEnvFlag, "1")
	for _, provider := range []string{"opencode", "cursor", "hermes", ""} {
		if env := orcaBridgeEnv(context.Background(), "/tmp/run/workdir", provider, nil); env != nil {
			t.Fatalf("provider %q has no Orca hook; got %v", provider, env)
		}
	}
}

func TestOrcaBridgeEnvSkipsEmptyWorkDir(t *testing.T) {
	t.Setenv(orcaBridgeEnvFlag, "1")
	if env := orcaBridgeEnv(context.Background(), "", "claude", nil); env != nil {
		t.Fatalf("no workdir means no run directory to hand Orca; got %v", env)
	}
}

func TestOrcaBridgeWaitBounds(t *testing.T) {
	tests := map[string]time.Duration{
		"":     orcaBridgeDefaultWait,
		"0":    orcaBridgeDefaultWait,
		"-3":   orcaBridgeDefaultWait,
		"999":  orcaBridgeDefaultWait, // out of range: a stuck helper must not stall a run
		"abc":  orcaBridgeDefaultWait,
		"2.5":  2500 * time.Millisecond,
		"12":   12 * time.Second,
		"60":   60 * time.Second,
		"60.1": orcaBridgeDefaultWait,
	}
	for raw, want := range tests {
		t.Setenv(orcaBridgeTimeoutEnv, raw)
		if got := orcaBridgeWait(); got != want {
			t.Errorf("%s=%q: got %v, want %v", orcaBridgeTimeoutEnv, raw, got, want)
		}
	}
}
