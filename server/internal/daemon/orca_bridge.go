package daemon

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

// Orca bridge: adopt an Orca pane identity for the task's agent process so the
// Orca app reports the run's live status (working / needs attention / done)
// next to its own agents, instead of only indexing the transcript afterwards.
//
// Orca's agent hooks (~/.orca/agent-hooks/{claude,codex}-hook.sh, wired into
// ~/.claude/settings.json and ~/.codex/hooks.json) report an event only when
// the agent process carries ORCA_PANE_KEY plus a readable
// ORCA_AGENT_HOOK_ENDPOINT. Both are handed out exclusively to terminals Orca
// itself creates, which is why the daemon has to ask Orca for a pane and read
// the identity back rather than synthesizing one.
//
// The helper `multica-orca pane-open <run dir>` does that handshake: it opens
// an Orca terminal on the run's worktree, the terminal's bootstrap publishes
// its own ORCA_* variables into <run dir>/.orca_pane.json, and the helper
// prints them as a JSON object. Anything missing (Orca closed, repo not
// registered, helper absent) prints "{}" and the run proceeds untouched.
//
// Only the endpoint *path* ever reaches this process; the hook token stays in
// the 0600 file Orca owns, so nothing secret is stored on the Multica side.
const (
	orcaBridgeEnvFlag     = "MULTICA_ORCA_BRIDGE"
	orcaBridgeHelper      = "multica-orca"
	orcaBridgeTimeoutEnv  = "MULTICA_ORCA_BRIDGE_TIMEOUT"
	orcaBridgeDefaultWait = 8 * time.Second
)

// orcaBridgeEnabled reports whether the operator opted in. Off by default:
// the bridge only makes sense on a workstation running the Orca app.
func orcaBridgeEnabled() bool {
	switch os.Getenv(orcaBridgeEnvFlag) {
	case "1", "true", "yes":
		return true
	}
	return false
}

func orcaBridgeWait() time.Duration {
	if raw := os.Getenv(orcaBridgeTimeoutEnv); raw != "" {
		if secs, err := strconv.ParseFloat(raw, 64); err == nil && secs > 0 && secs <= 60 {
			return time.Duration(secs * float64(time.Second))
		}
	}
	return orcaBridgeDefaultWait
}

// orcaBridgeEnv returns the ORCA_* variables to layer onto the agent
// environment, or nil. It never returns an error: a failed handshake must
// degrade to "no live status in Orca", never to a failed run.
func orcaBridgeEnv(ctx context.Context, workDir, provider string, logger *slog.Logger) map[string]string {
	if !orcaBridgeEnabled() || workDir == "" {
		return nil
	}
	// Orca ships hooks for these two agent CLIs; other providers would carry
	// the variables without anything ever reporting.
	if provider != "claude" && provider != "codex" {
		return nil
	}
	helper, err := exec.LookPath(orcaBridgeHelper)
	if err != nil {
		return nil
	}
	wait := orcaBridgeWait()
	// The helper polls for the pane file up to --timeout; give the process a
	// little more than that before giving up on it.
	cmdCtx, cancel := context.WithTimeout(ctx, wait+10*time.Second)
	defer cancel()

	runDir := filepath.Dir(workDir)
	out, err := exec.CommandContext(cmdCtx, helper, "pane-open", runDir,
		"--timeout", strconv.FormatFloat(wait.Seconds(), 'f', 1, 64)).Output()
	if err != nil {
		if logger != nil {
			logger.Debug("orca bridge: pane handshake failed; run continues without live status", "error", err)
		}
		return nil
	}
	var env map[string]string
	if err := json.Unmarshal(out, &env); err != nil || env["ORCA_PANE_KEY"] == "" {
		return nil
	}
	if logger != nil {
		logger.Info("orca bridge: pane adopted", "run_dir", runDir, "provider", provider)
	}
	return env
}
