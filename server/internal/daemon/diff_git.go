package daemon

// Git plumbing for the local diff endpoint.
//
// The daemon is the only component that can see the machine's clones, so it
// owns diff computation; clients (desktop modal today, web later) just render
// what this returns. We shell out to `git` rather than linking a Go git
// library: the daemon already does this elsewhere (gc.go, local_directory.go),
// there is no go-git dependency in go.mod, and porcelain output is exactly the
// contract we need.
//
// Everything here is READ-ONLY: no command mutates a repository.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// diffProtectedBranches are branch names that are never "the work of a task".
// Used both to pick a base and to reject a candidate working branch.
var diffProtectedBranches = map[string]struct{}{
	"main": {}, "master": {}, "develop": {}, "development": {}, "qa": {},
	"staging": {}, "stage": {}, "production": {}, "prod": {}, "hml": {},
	"homolog": {}, "homologacao": {}, "release": {},
}

func isProtectedBranch(ref string) bool {
	_, ok := diffProtectedBranches[ref]
	return ok
}

const (
	diffGitTimeout    = 30 * time.Second
	diffMaxFiles      = 300
	diffMaxLinesFile  = 3000
	diffMaxCommitList = 50
)

// runGit executes a git command inside repo and returns stdout.
func runGit(ctx context.Context, repo string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, diffGitTimeout)
	defer cancel()

	full := append([]string{"-C", repo}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		if len(msg) > 300 {
			msg = msg[:300]
		}
		label := args
		if len(label) > 3 {
			label = label[:3]
		}
		return "", fmt.Errorf("git %s: %s", strings.Join(label, " "), msg)
	}
	return stdout.String(), nil
}

// diffWorkspaceRoots lists ~/multica_workspaces_<profile> directories.
func diffWorkspaceRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	entries, err := os.ReadDir(home)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "multica_workspaces_") {
			continue
		}
		out = append(out, filepath.Join(home, e.Name()))
	}
	return out
}

// BareRepo is a repository Multica cloned for a workspace.
type BareRepo struct {
	Path    string
	DirName string
	Label   string
}

// discoverBareRepos finds the bares Multica clones under
// <root>/.repos/<workspaceID>/<host+org+repo>.git
func discoverBareRepos(workspaceID string) []BareRepo {
	var out []BareRepo
	for _, root := range diffWorkspaceRoots() {
		dir := filepath.Join(root, ".repos", workspaceID)
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() || !strings.HasSuffix(e.Name(), ".git") {
				continue
			}
			out = append(out, BareRepo{
				Path:    filepath.Join(dir, e.Name()),
				DirName: e.Name(),
				Label:   bareRepoLabel(e.Name()),
			})
		}
	}
	return out
}

// bareRepoLabel turns "github.com+org+repo.git" into "org/repo".
func bareRepoLabel(dirName string) string {
	base := strings.TrimSuffix(dirName, ".git")
	parts := strings.Split(base, "+")
	if len(parts) >= 3 {
		return strings.Join(parts[1:], "/")
	}
	return base
}

// AgentBranch is an refs/heads/agent/<slug>/<runPrefix> branch in a bare.
type AgentBranch struct {
	Ref       string
	SHA       string
	Date      string
	RunPrefix string
	AgentSlug string
}

func listDiffAgentBranches(ctx context.Context, bare string) []AgentBranch {
	out, err := runGit(ctx, bare, "for-each-ref",
		"--format=%(refname:short)\t%(objectname)\t%(committerdate:iso-strict)",
		"refs/heads/agent/")
	if err != nil {
		return nil
	}
	var branches []AgentBranch
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		cols := strings.Split(line, "\t")
		if len(cols) < 3 {
			continue
		}
		ref := cols[0]
		segs := strings.Split(ref, "/")
		last := segs[len(segs)-1]
		branches = append(branches, AgentBranch{
			Ref:       ref,
			SHA:       cols[1],
			Date:      cols[2],
			RunPrefix: strings.Split(last, "-")[0],
			AgentSlug: strings.Join(segs[1:len(segs)-1], "/"),
		})
	}
	return branches
}

// BaseInfo is where a branch started, plus how far it has moved.
type BaseInfo struct {
	Base        string `json:"base"`
	MergeBase   string `json:"merge_base"`
	Ahead       int    `json:"ahead"`
	Behind      int    `json:"behind,omitempty"`
	Kind        string `json:"kind"`
	BranchBase  string `json:"branch_base,omitempty"`
	BranchAhead int    `json:"branch_ahead,omitempty"`
}

// detectBranchBase picks, among all non-agent branches, the one that leaves
// the branch with the FEWEST commits ahead; ties break toward a protected
// branch, then the smallest "behind".
func detectBranchBase(ctx context.Context, repo, branch string) *BaseInfo {
	refsOut, err := runGit(ctx, repo, "for-each-ref", "--format=%(refname:short)", "refs/heads")
	if err != nil {
		return nil
	}

	type candidate struct {
		ref           string
		ahead, behind int
		prot          int
	}
	var best *candidate
	for _, ref := range strings.Split(strings.TrimSpace(refsOut), "\n") {
		if ref == "" || ref == branch || strings.HasPrefix(ref, "agent/") {
			continue
		}
		counts, err := runGit(ctx, repo, "rev-list", "--count", "--left-right", ref+"..."+branch)
		if err != nil {
			continue
		}
		fields := strings.Fields(strings.TrimSpace(counts))
		if len(fields) != 2 {
			continue
		}
		behind, _ := strconv.Atoi(fields[0])
		ahead, _ := strconv.Atoi(fields[1])
		if ahead == 0 {
			continue
		}
		prot := 1
		if isProtectedBranch(ref) {
			prot = 0
		}
		cand := candidate{ref: ref, ahead: ahead, behind: behind, prot: prot}
		if best == nil ||
			cand.ahead < best.ahead ||
			(cand.ahead == best.ahead && cand.prot < best.prot) ||
			(cand.ahead == best.ahead && cand.prot == best.prot && cand.behind < best.behind) {
			c := cand
			best = &c
		}
	}
	if best == nil {
		return nil
	}
	mb, err := runGit(ctx, repo, "merge-base", best.ref, branch)
	if err != nil {
		return nil
	}
	mb = strings.TrimSpace(mb)
	if mb == "" {
		return nil
	}
	return &BaseInfo{Base: best.ref, MergeBase: mb, Ahead: best.ahead, Behind: best.behind, Kind: "branch"}
}

// forkPointByRun cuts the branch at the commit just before the run started.
// The bares Multica clones do not track the remote, so a stale ref can make a
// branch look hundreds of commits ahead; the agent's own commits are the ones
// inside the run window, and the parent of the oldest is the honest base.
func forkPointByRun(ctx context.Context, repo, branch, isoStart string) *BaseInfo {
	start, err := time.Parse(time.RFC3339, isoStart)
	if err != nil {
		return nil
	}
	cutoff := start.Add(-10 * time.Minute)

	out, err := runGit(ctx, repo, "log", "-n500", "--format=%H|%cI", branch)
	if err != nil {
		return nil
	}
	ahead := 0
	base := ""
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		if len(parts) != 2 {
			continue
		}
		when, err := time.Parse(time.RFC3339, parts[1])
		if err != nil {
			continue
		}
		if !when.Before(cutoff) {
			ahead++
			continue
		}
		base = parts[0]
		break
	}
	if ahead == 0 || base == "" {
		return nil
	}
	short := base
	if len(short) > 7 {
		short = short[:7]
	}
	return &BaseInfo{Base: short, MergeBase: base, Ahead: ahead, Kind: "run"}
}

// BranchTip is the head commit of a branch.
type BranchTip struct {
	SHA     string `json:"sha"`
	Short   string `json:"short"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	Date    string `json:"date"`
	Tree    string `json:"tree"`
}

func branchTip(ctx context.Context, repo, branch string) *BranchTip {
	out, err := runGit(ctx, repo, "log", "-1", "--format=%H%x09%h%x09%s%x09%an%x09%cI%x09%T", branch)
	if err != nil {
		return nil
	}
	cols := strings.Split(strings.TrimSpace(out), "\t")
	if len(cols) < 6 {
		return nil
	}
	return &BranchTip{SHA: cols[0], Short: cols[1], Subject: cols[2], Author: cols[3], Date: cols[4], Tree: cols[5]}
}

// DiffCommit is one commit between the base and the branch tip.
type DiffCommit struct {
	Short   string `json:"short"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	Date    string `json:"date"`
}

func listCommits(ctx context.Context, repo, mergeBase, branch string) []DiffCommit {
	out, err := runGit(ctx, repo, "log", "--format=%h%x09%s%x09%an%x09%cI",
		fmt.Sprintf("-n%d", diffMaxCommitList), mergeBase+".."+branch)
	if err != nil {
		return nil
	}
	commits := []DiffCommit{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		cols := strings.Split(line, "\t")
		if len(cols) < 4 {
			continue
		}
		commits = append(commits, DiffCommit{Short: cols[0], Subject: cols[1], Author: cols[2], Date: cols[3]})
	}
	return commits
}

// FileSummary is the --numstat view of one changed file.
type FileSummary struct {
	Path   string `json:"path"`
	Add    int    `json:"add"`
	Del    int    `json:"del"`
	Binary bool   `json:"binary"`
}

func numstat(ctx context.Context, repo, mergeBase, branch string) ([]FileSummary, error) {
	out, err := runGit(ctx, repo, "diff", "--numstat", "-M", mergeBase+".."+branch)
	if err != nil {
		return nil, err
	}
	files := []FileSummary{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		cols := strings.SplitN(line, "\t", 3)
		if len(cols) < 3 {
			continue
		}
		add, del := 0, 0
		binary := cols[0] == "-" && cols[1] == "-"
		if !binary {
			add, _ = strconv.Atoi(cols[0])
			del, _ = strconv.Atoi(cols[1])
		}
		files = append(files, FileSummary{Path: cols[2], Add: add, Del: del, Binary: binary})
	}
	return files, nil
}

// DiffLine is one line of a hunk, already classified.
type DiffLine struct {
	T string `json:"t"`
	C string `json:"c"`
	O int    `json:"o,omitempty"`
	N int    `json:"n,omitempty"`
}

// DiffHunk is one @@ block.
type DiffHunk struct {
	Header   string     `json:"header"`
	Context  string     `json:"context"`
	OldStart int        `json:"oldStart"`
	NewStart int        `json:"newStart"`
	Lines    []DiffLine `json:"lines"`
}

// DiffFile is a structured per-file diff ready for the client to render.
type DiffFile struct {
	Path      string     `json:"path"`
	OldPath   string     `json:"oldPath"`
	Status    string     `json:"status"`
	Add       int        `json:"add"`
	Del       int        `json:"del"`
	Binary    bool       `json:"binary"`
	Language  string     `json:"language"`
	Hunks     []DiffHunk `json:"hunks"`
	Truncated bool       `json:"truncated"`
}

var hunkHeaderRe = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$`)
var diffGitHeaderRe = regexp.MustCompile(`^diff --git a/(.+?) b/(.+)$`)

// parsePatch turns `git diff` output into structured files. stats (from
// --numstat) is optional; without it the counts come from the hunk lines.
func parsePatch(patch string, stats map[string]FileSummary) []DiffFile {
	files := []DiffFile{}
	var cur *DiffFile
	lineCount := 0

	flush := func() {
		if cur != nil {
			files = append(files, *cur)
			cur = nil
		}
	}

	for _, line := range strings.Split(patch, "\n") {
		if strings.HasPrefix(line, "diff --git ") {
			flush()
			path, oldPath := line[11:], line[11:]
			if m := diffGitHeaderRe.FindStringSubmatch(line); m != nil {
				oldPath, path = m[1], m[2]
			}
			st, ok := stats[path]
			if !ok {
				st = stats[oldPath]
			}
			cur = &DiffFile{
				Path: path, OldPath: oldPath, Status: "modified",
				Add: st.Add, Del: st.Del, Binary: st.Binary,
				Language: languageOf(path), Hunks: []DiffHunk{},
			}
			lineCount = 0
			continue
		}
		if cur == nil {
			continue
		}

		switch {
		case strings.HasPrefix(line, "new file mode"):
			cur.Status = "added"
			continue
		case strings.HasPrefix(line, "deleted file mode"):
			cur.Status = "deleted"
			continue
		case strings.HasPrefix(line, "rename from "), strings.HasPrefix(line, "similarity index"):
			cur.Status = "renamed"
			continue
		case strings.HasPrefix(line, "Binary files"):
			cur.Binary = true
			continue
		case strings.HasPrefix(line, "index "), strings.HasPrefix(line, "--- "),
			strings.HasPrefix(line, "+++ "), strings.HasPrefix(line, "old mode"),
			strings.HasPrefix(line, "new mode"), strings.HasPrefix(line, "rename to "):
			continue
		}

		if strings.HasPrefix(line, "@@") {
			hunk := DiffHunk{Header: line, Lines: []DiffLine{}}
			if m := hunkHeaderRe.FindStringSubmatch(line); m != nil {
				hunk.OldStart, _ = strconv.Atoi(m[1])
				hunk.NewStart, _ = strconv.Atoi(m[3])
				hunk.Context = strings.TrimSpace(m[5])
			}
			cur.Hunks = append(cur.Hunks, hunk)
			continue
		}

		if len(cur.Hunks) == 0 {
			continue
		}
		if lineCount >= diffMaxLinesFile {
			cur.Truncated = true
			continue
		}
		lineCount++

		kind := "ctx"
		if len(line) > 0 {
			switch line[0] {
			case '+':
				kind = "add"
			case '-':
				kind = "del"
			case '\\':
				kind = "meta"
			}
		}
		content := ""
		if len(line) > 0 {
			content = line[1:]
		}
		h := &cur.Hunks[len(cur.Hunks)-1]
		h.Lines = append(h.Lines, DiffLine{T: kind, C: content})
	}
	flush()

	for i := range files {
		f := &files[i]
		if len(stats) == 0 {
			add, del := 0, 0
			for _, h := range f.Hunks {
				for _, l := range h.Lines {
					if l.T == "add" {
						add++
					} else if l.T == "del" {
						del++
					}
				}
			}
			f.Add, f.Del = add, del
		}
		for hi := range f.Hunks {
			h := &f.Hunks[hi]
			o, n := h.OldStart, h.NewStart
			for li := range h.Lines {
				switch h.Lines[li].T {
				case "add":
					h.Lines[li].N = n
					n++
				case "del":
					h.Lines[li].O = o
					o++
				case "ctx":
					h.Lines[li].O = o
					h.Lines[li].N = n
					o++
					n++
				}
			}
		}
	}
	return files
}

var extLanguage = map[string]string{
	"js": "javascript", "jsx": "javascript", "mjs": "javascript", "cjs": "javascript",
	"ts": "typescript", "tsx": "typescript",
	"cs": "csharp", "java": "java", "kt": "kotlin", "swift": "swift", "go": "go", "rs": "rust",
	"py": "python", "rb": "ruby", "php": "php",
	"vue": "html", "html": "html", "htm": "html", "xml": "xml", "svg": "xml",
	"css": "css", "scss": "css", "sass": "css", "less": "css",
	"json": "json", "yml": "yaml", "yaml": "yaml", "toml": "ini", "ini": "ini",
	"sh": "shell", "bash": "shell", "zsh": "shell",
	"sql": "sql", "md": "markdown", "markdown": "markdown",
	"dart": "dart", "gradle": "groovy", "plist": "xml",
}

func languageOf(path string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))
	if lang, ok := extLanguage[ext]; ok {
		return lang
	}
	return "plain"
}

// WorkdirCheckout is a real clone inside a run's work_dir.
type WorkdirCheckout struct {
	Path       string
	Name       string
	Remote     string
	Head       string
	Candidates []workdirRef
}

type workdirRef struct {
	Ref  string
	SHA  string
	Date string
}

// listWorkdirCheckouts finds clones under a run work_dir. Not every task leaves
// an agent/* branch — several work on a named branch inside the workdir.
func listWorkdirCheckouts(ctx context.Context, workdir string) []WorkdirCheckout {
	entries, err := os.ReadDir(workdir)
	if err != nil {
		return nil
	}
	var out []WorkdirCheckout
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		p := filepath.Join(workdir, e.Name())
		if _, err := os.Stat(filepath.Join(p, ".git")); err != nil {
			continue
		}
		remote, _ := runGit(ctx, p, "remote", "get-url", "origin")
		head, err := runGit(ctx, p, "rev-parse", "--abbrev-ref", "HEAD")
		if err != nil {
			continue
		}
		head = strings.TrimSpace(head)

		var refs []workdirRef
		if raw, err := runGit(ctx, p, "for-each-ref", "--sort=-committerdate",
			"--format=%(refname:short)\t%(objectname)\t%(committerdate:iso-strict)", "refs/heads"); err == nil {
			for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
				if line == "" {
					continue
				}
				cols := strings.Split(line, "\t")
				if len(cols) < 3 {
					continue
				}
				refs = append(refs, workdirRef{Ref: cols[0], SHA: cols[1], Date: cols[2]})
			}
		}

		var candidates []workdirRef
		for _, r := range refs {
			if isProtectedBranch(r.Ref) || strings.HasPrefix(r.Ref, "agent/") {
				continue
			}
			candidates = append(candidates, r)
			if len(candidates) == 6 {
				break
			}
		}
		// Make sure HEAD is considered even when it is not among the newest.
		if head != "" && head != "HEAD" && !isProtectedBranch(head) {
			found := false
			for _, c := range candidates {
				if c.Ref == head {
					found = true
					break
				}
			}
			if !found {
				for _, r := range refs {
					if r.Ref == head {
						candidates = append([]workdirRef{r}, candidates...)
						break
					}
				}
			}
		}

		out = append(out, WorkdirCheckout{
			Path: p, Name: e.Name(), Remote: strings.TrimSpace(remote),
			Head: head, Candidates: candidates,
		})
	}
	return out
}

var remoteLabelRe = regexp.MustCompile(`[/:]([^/:]+/[^/]+)$`)

// labelFromRemote turns an origin URL into "org/repo".
func labelFromRemote(url, fallback string) string {
	if url == "" {
		return fallback
	}
	trimmed := strings.TrimSuffix(url, ".git")
	if m := remoteLabelRe.FindStringSubmatch(trimmed); m != nil {
		return m[1]
	}
	return fallback
}

// resolveWorkdirCheckout returns the agent's real checkout inside work_dir —
// the folder GitKraken/VS Code should open. Empty when the GC removed it.
func resolveWorkdirCheckout(workDir, repoLabel string) string {
	if workDir == "" {
		return ""
	}
	if _, err := os.Stat(workDir); err != nil {
		return ""
	}
	if _, err := os.Stat(filepath.Join(workDir, ".git")); err == nil {
		return workDir
	}
	entries, err := os.ReadDir(workDir)
	if err != nil {
		return ""
	}
	var dirs []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(workDir, e.Name(), ".git")); err == nil {
			dirs = append(dirs, e.Name())
		}
	}
	if len(dirs) == 0 {
		return ""
	}
	want := repoLabel
	if i := strings.LastIndex(want, "/"); i >= 0 {
		want = want[i+1:]
	}
	for _, d := range dirs {
		if d == want {
			return filepath.Join(workDir, d)
		}
	}
	sort.Strings(dirs)
	return filepath.Join(workDir, dirs[0])
}

// vscodeBinaries are the usual `code` locations; the daemon's PATH does not
// always carry the user's shell PATH.
var vscodeBinaries = []string{
	"/usr/local/bin/code",
	"/opt/homebrew/bin/code",
	"/usr/local/bin/code-insiders",
	"/opt/homebrew/bin/code-insiders",
}

// openInTool launches a local GUI tool on the given path.
func openInTool(ctx context.Context, tool, target string) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	switch tool {
	case "gitkraken":
		// `open -a` is required: the gitkraken:// deep link treats its argument
		// as a remote URL and offers to clone instead of opening the clone.
		cmd = exec.CommandContext(ctx, "open", "-a", "GitKraken", target)
	case "vscode":
		bin := "code"
		if home, err := os.UserHomeDir(); err == nil {
			if _, statErr := os.Stat(filepath.Join(home, ".local/bin/code")); statErr == nil {
				bin = filepath.Join(home, ".local/bin/code")
			}
		}
		if bin == "code" {
			for _, candidate := range vscodeBinaries {
				if _, err := os.Stat(candidate); err == nil {
					bin = candidate
					break
				}
			}
		}
		cmd = exec.CommandContext(ctx, bin, "--new-window", target)
	default:
		return fmt.Errorf("unknown tool %q", tool)
	}

	if out, err := cmd.CombinedOutput(); err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("could not open %s: %s", tool, msg)
	}
	return nil
}
