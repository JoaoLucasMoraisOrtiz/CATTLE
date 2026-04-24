package codeview

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Commit struct {
	Hash      string `json:"hash"`
	Message   string `json:"message"`
	Body      string `json:"body,omitempty"`
	Author    string `json:"author"`
	Time      string `json:"time"`
	Timestamp int64  `json:"timestamp"`
	Files     int    `json:"files"`
	Repo      string `json:"repo,omitempty"`
	Local     bool   `json:"local,omitempty"`
}

type FileDiff struct {
	Path      string `json:"path"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

type DiffDetail struct {
	Path  string `json:"path"`
	Patch string `json:"patch"`
}

// Branch info
type Branch struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
}

func ListBranches(repoPath string) []Branch {
	out, _ := gitCmd(repoPath, "branch", "--format=%(refname:short)|%(HEAD)")
	var branches []Branch
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		current := len(parts) > 1 && strings.TrimSpace(parts[1]) == "*"
		branches = append(branches, Branch{Name: parts[0], Current: current})
	}
	return branches
}

func ListCommits(repoPath string, limit int, branch string) ([]Commit, error) {
	args := []string{"log", fmt.Sprintf("-%d", limit), "--pretty=format:%H|%s|%an|%at", "--no-merges"}
	if branch != "" {
		args = append(args, branch)
	}
	out, err := gitCmd(repoPath, args...)
	if err != nil {
		return nil, err
	}

	// Find unpushed commit hashes
	localHashes := map[string]bool{}
	if branch != "" {
		unpushed, _ := gitCmd(repoPath, "log", "--oneline", branch, "--not", "--remotes", "--pretty=format:%H")
		for _, h := range strings.Split(strings.TrimSpace(unpushed), "\n") {
			if len(h) >= 8 {
				localHashes[h[:8]] = true
			}
		}
	}

	var commits []Commit
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 4)
		if len(parts) < 4 {
			continue
		}
		ts, _ := strconv.ParseInt(parts[3], 10, 64)
		t := time.Unix(ts, 0)
		hash := parts[0][:8]
		fout, _ := gitCmd(repoPath, "diff-tree", "--no-commit-id", "-r", "--name-only", parts[0])
		files := len(strings.Split(strings.TrimSpace(fout), "\n"))
		if fout == "" {
			files = 0
		}
		commits = append(commits, Commit{
			Hash:      hash,
			Message:   parts[1],
			Author:    parts[2],
			Time:      timeAgo(t),
			Timestamp: ts,
			Files:     files,
			Local:     localHashes[hash],
		})
	}
	return commits, nil
}


func GetCommitDetail(repoPath, hash string) *Commit {
	out, err := gitCmd(repoPath, "log", "-1", "--pretty=format:%H|%s|%an|%at|%b", hash)
	if err != nil {
		return nil
	}
	// Split only first 4 pipes, rest is body
	parts := strings.SplitN(strings.TrimSpace(out), "|", 5)
	if len(parts) < 4 {
		return nil
	}
	ts, _ := strconv.ParseInt(parts[3], 10, 64)
	body := ""
	if len(parts) > 4 {
		body = strings.TrimSpace(parts[4])
	}
	return &Commit{
		Hash:    parts[0][:8],
		Message: parts[1],
		Body:    body,
		Author:  parts[2],
		Time:    timeAgo(time.Unix(ts, 0)),
	}
}
func GetDiffFiles(repoPath, hash string) ([]FileDiff, error) {
	out, err := gitCmd(repoPath, "diff", hash+"~1", hash, "--numstat")
	if err != nil {
		// First commit
		out, err = gitCmd(repoPath, "diff-tree", "--no-commit-id", "-r", "--numstat", hash)
		if err != nil {
			return nil, err
		}
	}
	var files []FileDiff
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 3 {
			continue
		}
		add, _ := strconv.Atoi(parts[0])
		del, _ := strconv.Atoi(parts[1])
		status := "modified"
		if add > 0 && del == 0 {
			status = "added"
		}
		files = append(files, FileDiff{Path: parts[2], Status: status, Additions: add, Deletions: del})
	}
	return files, nil
}

func GetFilePatch(repoPath, hash, filePath string) (string, error) {
	out, err := gitCmd(repoPath, "diff", hash+"~1", hash, "--", filePath)
	if err != nil {
		out, _ = gitCmd(repoPath, "show", hash+":"+filePath)
	}
	return out, nil
}

func gitCmd(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %w", args[0], err)
	}
	return string(out), nil
}

// FindGitRepos discovers all git repositories in a project path (root + subdirs).
func FindGitRepos(projectPath string) []string {
	var repos []string

	// Check root first
	if isGitRepo(projectPath) {
		repos = append(repos, projectPath)
	}

	// Scan one level of subdirs
	entries, err := os.ReadDir(projectPath)
	if err != nil {
		return repos
	}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		sub := filepath.Join(projectPath, e.Name())
		if isGitRepo(sub) {
			repos = append(repos, sub)
		}
		// Check one more level
		inner, _ := os.ReadDir(sub)
		for _, ie := range inner {
			if ie.IsDir() && !strings.HasPrefix(ie.Name(), ".") {
				deep := filepath.Join(sub, ie.Name())
				if isGitRepo(deep) {
					repos = append(repos, deep)
				}
			}
		}
	}
	return repos
}

func isGitRepo(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil && info.IsDir()
}

// ListCommitsMulti lists commits from all git repos found in a project.
func ListCommitsMulti(projectPath string, limit int, branch string) ([]Commit, []string) {
	repos := FindGitRepos(projectPath)
	if len(repos) == 0 {
		return nil, nil
	}

	var all []Commit
	for _, repo := range repos {
		commits, err := ListCommits(repo, limit, branch)
		if err != nil {
			continue
		}
		// Tag commits with repo name if multiple repos
		if len(repos) > 1 {
			rel, _ := filepath.Rel(projectPath, repo)
			if rel == "" {
				rel = "."
			}
			for i := range commits {
				commits[i].Repo = rel
			}
		}
		all = append(all, commits...)
	}

	// Sort by time (most recent first) — simple approach since timeAgo is relative
	// Commits are already sorted per-repo, just interleave
	if len(all) > limit {
		all = all[:limit]
	}
	repoNames := make([]string, len(repos))
	for i, r := range repos {
		rel, _ := filepath.Rel(projectPath, r)
		if rel == "" || rel == "." {
			rel = filepath.Base(r)
		}
		repoNames[i] = rel
	}
	return all, repoNames
}

func timeAgo(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}
