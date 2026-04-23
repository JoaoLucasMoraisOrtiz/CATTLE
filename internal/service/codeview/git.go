package codeview

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type Commit struct {
	Hash    string `json:"hash"`
	Message string `json:"message"`
	Author  string `json:"author"`
	Time    string `json:"time"`
	Files   int    `json:"files"`
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

func ListCommits(repoPath string, limit int) ([]Commit, error) {
	out, err := gitCmd(repoPath, "log", fmt.Sprintf("-%d", limit),
		"--pretty=format:%H|%s|%an|%at", "--no-merges")
	if err != nil {
		return nil, err
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
		// Count changed files
		fout, _ := gitCmd(repoPath, "diff-tree", "--no-commit-id", "-r", "--name-only", parts[0])
		files := len(strings.Split(strings.TrimSpace(fout), "\n"))
		if fout == "" {
			files = 0
		}
		commits = append(commits, Commit{
			Hash:    parts[0][:8],
			Message: parts[1],
			Author:  parts[2],
			Time:    timeAgo(t),
			Files:   files,
		})
	}
	return commits, nil
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
