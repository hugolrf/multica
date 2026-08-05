package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestParsePatchNumbersLinesAndClassifiesFiles pins the parser contract the
// clients render against: line kinds, old/new numbering, and file status.
func TestParsePatchNumbersLinesAndClassifiesFiles(t *testing.T) {
	patch := "diff --git a/src/app.ts b/src/app.ts\n" +
		"index 111..222 100644\n" +
		"--- a/src/app.ts\n" +
		"+++ b/src/app.ts\n" +
		"@@ -10,3 +10,4 @@ func main\n" +
		" keep\n" +
		"-gone\n" +
		"+added one\n" +
		"+added two\n" +
		"diff --git a/new.md b/new.md\n" +
		"new file mode 100644\n" +
		"@@ -0,0 +1,1 @@\n" +
		"+hello\n"

	files := parsePatch(patch, map[string]FileSummary{})
	if len(files) != 2 {
		t.Fatalf("files = %d, want 2", len(files))
	}

	app := files[0]
	if app.Path != "src/app.ts" || app.Language != "typescript" || app.Status != "modified" {
		t.Fatalf("app file = %+v", app)
	}
	if app.Add != 2 || app.Del != 1 {
		t.Fatalf("app add/del = %d/%d, want 2/1", app.Add, app.Del)
	}
	lines := app.Hunks[0].Lines
	if lines[0].T != "ctx" || lines[0].O != 10 || lines[0].N != 10 {
		t.Fatalf("ctx line = %+v", lines[0])
	}
	if lines[1].T != "del" || lines[1].O != 11 || lines[1].N != 0 {
		t.Fatalf("del line = %+v", lines[1])
	}
	if lines[2].T != "add" || lines[2].N != 11 {
		t.Fatalf("add line = %+v", lines[2])
	}
	if files[1].Status != "added" {
		t.Fatalf("new file status = %q, want added", files[1].Status)
	}
}

func TestSameTicketFamilyGroupsPromotionBranches(t *testing.T) {
	if !sameTicketFamily("AGENDA-650-merge-qa", "AGENDA-650") {
		t.Fatal("promotion branch should share the ticket family")
	}
	if sameTicketFamily("AGENDA-650", "PC-147") {
		t.Fatal("different tickets must not share a family")
	}
}

// gitInit builds a throwaway repo so the handler test does not depend on any
// repository that happens to exist on the machine.
func gitInit(t *testing.T, dir string) {
	t.Helper()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-qm", "base")
	run("checkout", "-q", "-b", "feature")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo changed\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("commit", "-qam", "feature work")
}

// TestDiffFilesHandlerReturnsStructuredDiff exercises the HTTP path end to end
// against a real repository: base detection, numstat totals, and the parsed
// hunks the client renders.
func TestDiffFilesHandlerReturnsStructuredDiff(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)

	body, _ := json.Marshal(diffFilesRequest{RepoPath: dir, Branch: "feature"})
	req := httptest.NewRequest(http.MethodPost, "/diff/files", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	(&Daemon{}).diffFilesHandler()(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var resp diffFilesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Base != "main" {
		t.Fatalf("base = %q, want main", resp.Base)
	}
	if resp.Totals.Files != 1 || resp.Totals.Add != 2 || resp.Totals.Del != 1 {
		t.Fatalf("totals = %+v, want 1 file +2/-1", resp.Totals)
	}
	if len(resp.Files) != 1 || resp.Files[0].Path != "a.txt" {
		t.Fatalf("files = %+v", resp.Files)
	}
	if len(resp.Files[0].Hunks) == 0 {
		t.Fatal("expected at least one hunk")
	}
	if len(resp.Commits) != 1 || resp.Commits[0].Subject != "feature work" {
		t.Fatalf("commits = %+v", resp.Commits)
	}
}

// TestDiffFilesHandlerRejectsBadInput keeps the handler's contract explicit.
func TestDiffFilesHandlerRejectsBadInput(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Daemon{}).diffFilesHandler()(rec, httptest.NewRequest(http.MethodGet, "/diff/files", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d, want 405", rec.Code)
	}

	body, _ := json.Marshal(diffFilesRequest{Branch: "feature"})
	rec = httptest.NewRecorder()
	(&Daemon{}).diffFilesHandler()(rec, httptest.NewRequest(http.MethodPost, "/diff/files", bytes.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing repo_path status = %d, want 400", rec.Code)
	}
}

// TestDiffSourcesHandlerRequiresWorkspace covers the other handler's guard.
func TestDiffSourcesHandlerRequiresWorkspace(t *testing.T) {
	body, _ := json.Marshal(diffSourcesRequest{})
	rec := httptest.NewRecorder()
	(&Daemon{}).diffSourcesHandler()(rec, httptest.NewRequest(http.MethodPost, "/diff/sources", bytes.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// TestResolveWorkdirCheckoutPrefersMatchingRepo pins the folder an external
// tool should open when the run's work_dir holds several clones.
func TestResolveWorkdirCheckoutPrefersMatchingRepo(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"other", "extension.dwlaw"} {
		if err := os.MkdirAll(filepath.Join(root, name, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	got := resolveWorkdirCheckout(root, "hugolrf/extension.dwlaw")
	if got != filepath.Join(root, "extension.dwlaw") {
		t.Fatalf("got %q", got)
	}
	if resolveWorkdirCheckout(filepath.Join(root, "missing"), "x") != "" {
		t.Fatal("missing workdir must resolve to empty")
	}
}

var _ = context.Background
