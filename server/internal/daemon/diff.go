package daemon

// Local diff endpoints.
//
// A task's consolidated diff is the UNION of every diff source across the
// issue family (parent + descendants), grouped by repo/branch. Only this
// machine can compute it — the repositories live here — so the daemon owns the
// computation and any client (desktop modal today, web through a tunnel)
// renders the result.
//
// The client supplies what it already knows from the authenticated API (the
// family's runs, their work_dirs and timestamps, plus any ticket codes in the
// issue titles); the daemon supplies everything that requires the filesystem.
// That split keeps the CLI out of the picture entirely.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// diffRunInput is one agent run, as the client read it from the API.
type diffRunInput struct {
	RunID           string `json:"run_id"`
	WorkDir         string `json:"work_dir"`
	Status          string `json:"status"`
	CreatedAt       string `json:"created_at"`
	StartedAt       string `json:"started_at"`
	CompletedAt     string `json:"completed_at"`
	AgentID         string `json:"agent_id"`
	AgentName       string `json:"agent_name"`
	IssueID         string `json:"issue_id"`
	IssueIdentifier string `json:"issue_identifier"`
	IssueTitle      string `json:"issue_title"`
	IssueStatus     string `json:"issue_status"`
}

type diffSourcesRequest struct {
	WorkspaceID string         `json:"workspace_id"`
	Runs        []diffRunInput `json:"runs"`
	// Ticket codes taken from the family's issue titles (e.g. "AGENDA-608").
	// Some agents commit to a branch named after the code inside a shared
	// checkout instead of creating an agent/* branch.
	Codes []string `json:"codes"`
}

type diffIssueRef struct {
	ID         string `json:"id"`
	Identifier string `json:"identifier"`
	Title      string `json:"title"`
	Status     string `json:"status"`
}

type diffDuplicate struct {
	Branch string `json:"branch"`
	Kind   string `json:"kind"`
	Issue  string `json:"issue"`
}

// diffSource is one resolved repo+branch with its real base and summary.
type diffSource struct {
	Key           string          `json:"key"`
	Kind          string          `json:"kind"`
	Repo          string          `json:"repo"`
	RepoPath      string          `json:"repo_path"`
	RepoDisplay   string          `json:"repo_display"`
	Workdir       string          `json:"workdir"`
	Branch        string          `json:"branch"`
	AgentSlug     string          `json:"agent_slug"`
	AgentID       string          `json:"agent_id"`
	AgentName     string          `json:"agent_name"`
	Issue         diffIssueRef    `json:"issue"`
	RunStatus     string          `json:"run_status"`
	RunCreatedAt  string          `json:"run_created_at"`
	Base          string          `json:"base"`
	MergeBase     string          `json:"merge_base"`
	Ahead         int             `json:"ahead"`
	BaseKind      string          `json:"base_kind"`
	BranchBase    string          `json:"branch_base,omitempty"`
	BranchAhead   int             `json:"branch_ahead,omitempty"`
	Tip           *BranchTip      `json:"tip"`
	Totals        diffTotals      `json:"totals"`
	Files         []FileSummary   `json:"files"`
	Primary       bool            `json:"primary"`
	DemoteReasons []string        `json:"demote_reasons"`
	Duplicates    []diffDuplicate `json:"duplicates"`
}

type diffTotals struct {
	Add   int `json:"add"`
	Del   int `json:"del"`
	Files int `json:"files"`
}

type diffSourcesResponse struct {
	Sources        []diffSource `json:"sources"`
	CandidateCount int          `json:"candidate_count"`
	HasLocalRepos  bool         `json:"has_local_repos"`
}

// candidate is a repo+branch worth resolving, before base detection.
type candidate struct {
	kind       string
	repoPath   string
	repo       string
	branch     string
	agentSlug  string
	run        diffRunInput
	forcedBase []string
}

const bigDiffFileCount = 150

var ticketCodeRe = regexp.MustCompile(`^[A-Za-z]+[-_]?\d+`)

// collectCandidates finds every branch that could hold this family's work.
func collectCandidates(ctx context.Context, req diffSourcesRequest) []candidate {
	var out []candidate
	seen := map[string]bool{}

	add := func(c candidate) {
		key := c.repoPath + "::" + c.branch
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, c)
	}

	// Source 1: agent/* branches in the workspace bares, matched to a run by
	// the 8-hex prefix that names the branch.
	runByPrefix := map[string]diffRunInput{}
	for _, r := range req.Runs {
		if len(r.RunID) >= 8 {
			runByPrefix[r.RunID[:8]] = r
		}
	}
	for _, bare := range discoverBareRepos(req.WorkspaceID) {
		for _, br := range listDiffAgentBranches(ctx, bare.Path) {
			run, ok := runByPrefix[br.RunPrefix]
			if !ok {
				continue
			}
			add(candidate{
				kind: "bare", repoPath: bare.Path, repo: bare.Label,
				branch: br.Ref, agentSlug: br.AgentSlug, run: run,
			})
		}
	}

	// Source 2: named branches inside a run's workdir checkout. Only branches
	// whose tip landed inside the run window (+6h slack) count as this task's
	// work — the clone also carries the repo's pre-existing branches.
	type dirRuns struct {
		runs []diffRunInput
	}
	byDir := map[string]*dirRuns{}
	for _, r := range req.Runs {
		if r.WorkDir == "" {
			continue
		}
		if _, err := os.Stat(r.WorkDir); err != nil {
			continue
		}
		if byDir[r.WorkDir] == nil {
			byDir[r.WorkDir] = &dirRuns{}
		}
		byDir[r.WorkDir].runs = append(byDir[r.WorkDir].runs, r)
	}
	for dir, group := range byDir {
		start, end, ok := runWindow(group.runs)
		if !ok {
			continue
		}
		for _, co := range listWorkdirCheckouts(ctx, dir) {
			for _, cand := range co.Candidates {
				tip, err := time.Parse(time.RFC3339, cand.Date)
				if err != nil || tip.Before(start) || tip.After(end) {
					continue
				}
				add(candidate{
					kind: "workdir", repoPath: co.Path,
					repo:   labelFromRemote(co.Remote, co.Name),
					branch: cand.Ref, run: group.runs[0],
				})
			}
		}
	}

	// Source 3: a branch named after the ticket code inside a shared checkout
	// whose work_dir IS the repo (no isolated workdir, no agent/* branch).
	if len(req.Codes) > 0 {
		repoDirs := map[string]diffRunInput{}
		for _, r := range req.Runs {
			if r.WorkDir == "" {
				continue
			}
			if _, err := os.Stat(filepath.Join(r.WorkDir, ".git")); err == nil {
				repoDirs[r.WorkDir] = r
			}
		}
		for repoPath, run := range repoDirs {
			raw, err := runGit(ctx, repoPath, "for-each-ref", "--format=%(refname:short)", "refs/heads")
			if err != nil {
				continue
			}
			remote, _ := runGit(ctx, repoPath, "remote", "get-url", "origin")
			for _, ref := range strings.Split(strings.TrimSpace(raw), "\n") {
				if ref == "" {
					continue
				}
				for _, code := range req.Codes {
					// Only the canonical ticket branch. The `<CODE>-MERGE-<ENV>`
					// integration branches carry whole-environment drift and
					// would show a huge, misleading diff.
					if ref != code && !(strings.HasPrefix(ref, code+"-") && !strings.Contains(strings.ToLower(ref), "-merge-")) {
						continue
					}
					add(candidate{
						kind: "workdir", repoPath: repoPath,
						repo:   labelFromRemote(strings.TrimSpace(remote), filepath.Base(repoPath)),
						branch: ref, run: run,
						// Ticket branches cut from production; prefer the remote
						// ref because local env refs go stale in a shared clone.
						forcedBase: []string{"origin/production", "production"},
					})
				}
			}
		}
	}

	return out
}

// runWindow is the span the family's runs covered, with slack at the end.
func runWindow(runs []diffRunInput) (time.Time, time.Time, bool) {
	var starts, ends []time.Time
	for _, r := range runs {
		if t, err := time.Parse(time.RFC3339, r.CreatedAt); err == nil {
			starts = append(starts, t)
		}
		for _, s := range []string{r.CompletedAt, r.StartedAt, r.CreatedAt} {
			if s == "" {
				continue
			}
			if t, err := time.Parse(time.RFC3339, s); err == nil {
				ends = append(ends, t)
				break
			}
		}
	}
	if len(starts) == 0 || len(ends) == 0 {
		return time.Time{}, time.Time{}, false
	}
	sort.Slice(starts, func(i, j int) bool { return starts[i].Before(starts[j]) })
	sort.Slice(ends, func(i, j int) bool { return ends[i].Before(ends[j]) })
	return starts[0], ends[len(ends)-1].Add(6 * time.Hour), true
}

// resolveCandidate detects the real base and summarizes the change. Returns
// nil when there is nothing to review (or the repo is broken).
func resolveCandidate(ctx context.Context, c candidate) *diffSource {
	var base *BaseInfo

	for _, ref := range c.forcedBase {
		if _, err := runGit(ctx, c.repoPath, "rev-parse", "--verify", "--quiet", ref+"^{commit}"); err != nil {
			continue
		}
		mb, err := runGit(ctx, c.repoPath, "merge-base", ref, c.branch)
		if err != nil {
			continue
		}
		mb = strings.TrimSpace(mb)
		if mb == "" {
			continue
		}
		ahead := 0
		if out, err := runGit(ctx, c.repoPath, "rev-list", "--count", mb+".."+c.branch); err == nil {
			ahead = atoiSafe(strings.TrimSpace(out))
		}
		base = &BaseInfo{Base: ref, MergeBase: mb, Ahead: ahead, Kind: "forced"}
		break
	}

	if base == nil {
		// Two readings of "where this branch started": merge-base against the
		// repo's other branches, and the run window. The one that yields FEWER
		// commits wins — that is what makes a stale bare ref harmless.
		byBranch := detectBranchBase(ctx, c.repoPath, c.branch)
		runStart := c.run.StartedAt
		if runStart == "" {
			runStart = c.run.CreatedAt
		}
		var byRun *BaseInfo
		if runStart != "" {
			byRun = forkPointByRun(ctx, c.repoPath, c.branch, runStart)
		}
		base = byBranch
		if byRun != nil && (base == nil || byRun.Ahead < base.Ahead) {
			merged := *byRun
			if byBranch != nil {
				merged.BranchBase = byBranch.Base
				merged.BranchAhead = byBranch.Ahead
			}
			base = &merged
		}
	}
	if base == nil {
		return nil
	}

	files, err := numstat(ctx, c.repoPath, base.MergeBase, c.branch)
	if err != nil || len(files) == 0 {
		return nil
	}

	totals := diffTotals{Files: len(files)}
	for _, f := range files {
		totals.Add += f.Add
		totals.Del += f.Del
	}

	primary, reasons := classifySource(c, base, totals)
	workdir := c.repoPath
	if c.kind != "workdir" {
		workdir = resolveWorkdirCheckout(c.run.WorkDir, c.repo)
	}

	return &diffSource{
		Key: c.repoPath + "::" + c.branch, Kind: c.kind, Repo: c.repo,
		RepoPath: c.repoPath, RepoDisplay: displayPath(c.repoPath), Workdir: workdir,
		Branch: c.branch, AgentSlug: c.agentSlug,
		AgentID: c.run.AgentID, AgentName: c.run.AgentName,
		Issue: diffIssueRef{
			ID: c.run.IssueID, Identifier: c.run.IssueIdentifier,
			Title: c.run.IssueTitle, Status: c.run.IssueStatus,
		},
		RunStatus: c.run.Status, RunCreatedAt: c.run.CreatedAt,
		Base: base.Base, MergeBase: base.MergeBase, Ahead: base.Ahead,
		BaseKind: base.Kind, BranchBase: base.BranchBase, BranchAhead: base.BranchAhead,
		Tip: branchTip(ctx, c.repoPath, c.branch), Totals: totals, Files: files,
		Primary: primary, DemoteReasons: reasons, Duplicates: []diffDuplicate{},
	}
}

// classifySource demotes branches that are not "the work of the task":
// promotion branches, branches based on a sibling, and oversized diffs. They
// stay listed (the data is real) but do not count toward the headline totals.
func classifySource(c candidate, base *BaseInfo, totals diffTotals) (bool, []string) {
	reasons := []string{}
	if regexp.MustCompile(`(?i)-(merge|promo|promote)[-_/]`).MatchString(c.branch) {
		reasons = append(reasons, "promotion branch (gitflow)")
	}
	if base.Kind != "run" && !isProtectedBranch(base.Base) && sameTicketFamily(c.branch, base.Base) {
		reasons = append(reasons, "base is a sibling branch ("+base.Base+"), not a protected branch")
	}
	if totals.Files > bigDiffFileCount {
		reasons = append(reasons, "very large diff")
	}
	return len(reasons) == 0, reasons
}

func sameTicketFamily(a, b string) bool {
	key := func(s string) string {
		if m := ticketCodeRe.FindString(s); m != "" {
			return strings.ToLower(m)
		}
		if len(s) > 6 {
			return strings.ToLower(s[:6])
		}
		return strings.ToLower(s)
	}
	return key(a) == key(b)
}

// dedupeSources drops sources whose diff is identical. Reruns create a fresh
// branch with the same content, and the same branch can arrive via both the
// bare and the workdir. Key: repo + merge-base + tip tree.
func dedupeSources(list []*diffSource) []diffSource {
	bySameBranch := map[string]*diffSource{}
	for _, s := range list {
		if s == nil {
			continue
		}
		tipSHA := ""
		if s.Tip != nil {
			tipSHA = s.Tip.SHA
		}
		k := s.Repo + "::" + s.Branch + "::" + tipSHA
		prev, ok := bySameBranch[k]
		if !ok {
			bySameBranch[k] = s
			continue
		}
		// The bare's run↔branch mapping is exact; on a tie prefer the source
		// covering more commits (a too-short window hides work).
		if (prev.Kind != "bare" && s.Kind == "bare") || (prev.Kind == s.Kind && s.Ahead > prev.Ahead) {
			bySameBranch[k] = s
		}
	}

	byContent := map[string]*diffSource{}
	var order []string
	for _, s := range bySameBranch {
		tree := ""
		if s.Tip != nil {
			tree = s.Tip.Tree
			if tree == "" {
				tree = s.Tip.SHA
			}
		}
		k := s.Repo + "::" + s.MergeBase + "::" + tree
		prev, ok := byContent[k]
		if !ok {
			byContent[k] = s
			order = append(order, k)
			continue
		}
		dup := diffDuplicate{Branch: s.Branch, Kind: s.Kind, Issue: s.Issue.Identifier}
		better := (prev.Kind == "workdir" && s.Kind == "bare") ||
			(prev.Kind == s.Kind && s.RunCreatedAt > prev.RunCreatedAt)
		if better {
			s.Duplicates = append(s.Duplicates, diffDuplicate{Branch: prev.Branch, Kind: prev.Kind, Issue: prev.Issue.Identifier})
			s.Duplicates = append(s.Duplicates, prev.Duplicates...)
			byContent[k] = s
		} else {
			prev.Duplicates = append(prev.Duplicates, dup)
		}
	}

	out := make([]diffSource, 0, len(order))
	for _, k := range order {
		out = append(out, *byContent[k])
	}
	// Primary first, then most recent run.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Primary != out[j].Primary {
			return out[i].Primary
		}
		return out[i].RunCreatedAt > out[j].RunCreatedAt
	})
	return out
}

func displayPath(p string) string {
	home, err := os.UserHomeDir()
	if err != nil || !strings.HasPrefix(p, home) {
		return p
	}
	return "~" + strings.TrimPrefix(p, home)
}

func atoiSafe(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return n
		}
		n = n*10 + int(r-'0')
	}
	return n
}

// diffSourcesHandler resolves every diff source for a task family.
func (d *Daemon) diffSourcesHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req diffSourcesRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(req.WorkspaceID) == "" {
			http.Error(w, "workspace_id is required", http.StatusBadRequest)
			return
		}

		candidates := collectCandidates(r.Context(), req)
		resolved := make([]*diffSource, 0, len(candidates))
		for _, c := range candidates {
			if s := resolveCandidate(r.Context(), c); s != nil {
				resolved = append(resolved, s)
			}
		}

		writeDiffJSON(w, diffSourcesResponse{
			Sources:        dedupeSources(resolved),
			CandidateCount: len(candidates),
			HasLocalRepos:  len(discoverBareRepos(req.WorkspaceID)) > 0,
		})
	}
}

type diffFilesRequest struct {
	RepoPath  string `json:"repo_path"`
	Branch    string `json:"branch"`
	MergeBase string `json:"merge_base"`
	BaseLabel string `json:"base_label"`
}

type diffFilesResponse struct {
	RepoPath       string       `json:"repo_path"`
	Branch         string       `json:"branch"`
	Base           string       `json:"base"`
	MergeBase      string       `json:"merge_base"`
	Ahead          int          `json:"ahead"`
	Tip            *BranchTip   `json:"tip"`
	Commits        []DiffCommit `json:"commits"`
	Files          []DiffFile   `json:"files"`
	TruncatedFiles int          `json:"truncated_files"`
	Totals         diffTotals   `json:"totals"`
}

var shaRe = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)

// diffFilesHandler returns the structured diff for one source, on demand.
func (d *Daemon) diffFilesHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req diffFilesRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
			return
		}
		if req.RepoPath == "" || req.Branch == "" {
			http.Error(w, "repo_path and branch are required", http.StatusBadRequest)
			return
		}

		ctx := r.Context()
		tip := branchTip(ctx, req.RepoPath, req.Branch)
		if tip == nil {
			http.Error(w, "branch not found", http.StatusNotFound)
			return
		}

		// Prefer the base the caller already resolved: recomputing here could
		// yield a different diff than the summary the user is looking at.
		var base *BaseInfo
		if shaRe.MatchString(req.MergeBase) {
			if out, err := runGit(ctx, req.RepoPath, "rev-parse", "--verify", req.MergeBase+"^{commit}"); err == nil {
				sha := strings.TrimSpace(out)
				label := req.BaseLabel
				if label == "" && len(sha) >= 7 {
					label = sha[:7]
				}
				base = &BaseInfo{Base: label, MergeBase: sha}
			}
		}
		if base == nil {
			base = detectBranchBase(ctx, req.RepoPath, req.Branch)
		}
		if base == nil {
			writeDiffJSON(w, diffFilesResponse{
				RepoPath: req.RepoPath, Branch: req.Branch, Tip: tip,
				Commits: []DiffCommit{}, Files: []DiffFile{},
			})
			return
		}

		summaries, err := numstat(ctx, req.RepoPath, base.MergeBase, req.Branch)
		if err != nil {
			http.Error(w, "diff failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		stats := make(map[string]FileSummary, len(summaries))
		totals := diffTotals{Files: len(summaries)}
		for _, f := range summaries {
			stats[f.Path] = f
			totals.Add += f.Add
			totals.Del += f.Del
		}

		patch, err := runGit(ctx, req.RepoPath, "diff", "-M", "--no-color", base.MergeBase+".."+req.Branch)
		if err != nil {
			http.Error(w, "diff failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		files := parsePatch(patch, stats)
		truncated := 0
		if len(files) > diffMaxFiles {
			truncated = len(files) - diffMaxFiles
			files = files[:diffMaxFiles]
		}

		writeDiffJSON(w, diffFilesResponse{
			RepoPath: req.RepoPath, Branch: req.Branch,
			Base: base.Base, MergeBase: base.MergeBase, Ahead: base.Ahead,
			Tip: tip, Commits: listCommits(ctx, req.RepoPath, base.MergeBase, req.Branch),
			Files: files, TruncatedFiles: truncated, Totals: totals,
		})
	}
}

func writeDiffJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	// The desktop renderer and (through a tunnel) the web app call these from a
	// different origin; the listener is 127.0.0.1-only, so this stays local.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_ = json.NewEncoder(w).Encode(v)
}

type diffOpenRequest struct {
	// Preferred target: the agent's workdir checkout, which already has the
	// branch checked out with the changes applied.
	Workdir  string `json:"workdir"`
	RepoPath string `json:"repo_path"`
	Tool     string `json:"tool"` // "gitkraken" | "vscode"
}

type diffOpenResponse struct {
	Target string `json:"target"`
}

// diffOpenHandler opens a diff source in a local GUI tool. The daemon runs on
// the machine that holds the clones, so this also works for a remote client:
// the tool opens here, next to the code being reviewed.
func (d *Daemon) diffOpenHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req diffOpenRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
			return
		}

		// A bare repo has no working tree, so neither tool can show the change;
		// the agent workdir is what the reviewer actually wants.
		target := req.Workdir
		if target == "" {
			if _, err := os.Stat(filepath.Join(req.RepoPath, ".git")); err == nil {
				target = req.RepoPath
			}
		}
		if target == "" {
			http.Error(w, "the agent workdir for this source is gone (cleaned up); review the diff here", http.StatusNotFound)
			return
		}
		if _, err := os.Stat(target); err != nil {
			http.Error(w, "target no longer exists on disk", http.StatusNotFound)
			return
		}

		if err := openInTool(r.Context(), req.Tool, target); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeDiffJSON(w, diffOpenResponse{Target: target})
	}
}

type diffParseRequest struct {
	Patch string `json:"patch"`
}

type diffParseResponse struct {
	Files  []DiffFile `json:"files"`
	Totals diffTotals `json:"totals"`
}

// diffParseHandler turns a raw patch into the same structured shape the diff
// endpoints return. Some deliveries arrive as an attached `.patch` instead of a
// branch; parsing them here keeps one parser for both paths.
func (d *Daemon) diffParseHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req diffParseRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
			return
		}
		files := parsePatch(req.Patch, map[string]FileSummary{})
		totals := diffTotals{Files: len(files)}
		for _, f := range files {
			totals.Add += f.Add
			totals.Del += f.Del
		}
		writeDiffJSON(w, diffParseResponse{Files: files, Totals: totals})
	}
}
