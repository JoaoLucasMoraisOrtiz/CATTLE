package codeview

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PromptContext holds human-selected context for prompt building.
type PromptContext struct {
	Symbols []string `json:"symbols"` // selected function/class names
	Files   []string `json:"files"`   // files containing those symbols
	Intent  string   `json:"intent"`  // what the user wants to do
}

// BuildPrompt assembles a rich prompt from human-selected graph nodes + intent.
func BuildPrompt(repoPath string, graph *SymbolGraph, ctx PromptContext) string {
	var parts []string

	// 1. Intent
	parts = append(parts, "## Task\n"+ctx.Intent)

	// 2. Selected symbols with their code
	selectedSet := map[string]bool{}
	for _, s := range ctx.Symbols {
		selectedSet[s] = true
	}

	parts = append(parts, "\n## Relevant Code")
	for _, sym := range graph.Symbols {
		if !selectedSet[sym.Name] {
			continue
		}
		code := extractSymbolCode(repoPath, sym)
		if code != "" {
			parts = append(parts, fmt.Sprintf("\n### %s `%s` (%s:%d-%d)\n```\n%s\n```",
				sym.Kind, sym.Name, sym.File, sym.StartLine, sym.EndLine, code))
		}
	}

	// 3. Connections between selected symbols
	var connections []string
	for _, e := range graph.Edges {
		if selectedSet[e.From] && selectedSet[e.To] {
			connections = append(connections, fmt.Sprintf("  %s → %s", e.From, e.To))
		} else if selectedSet[e.From] || selectedSet[e.To] {
			connections = append(connections, fmt.Sprintf("  %s → %s (external)", e.From, e.To))
		}
	}
	if len(connections) > 0 {
		parts = append(parts, "\n## Call Relationships\n"+strings.Join(connections, "\n"))
	}

	// 4. Dependencies (symbols called by selected but not selected themselves)
	var deps []string
	for _, sym := range graph.Symbols {
		if !selectedSet[sym.Name] {
			continue
		}
		for _, call := range sym.Calls {
			if !selectedSet[call] {
				deps = append(deps, fmt.Sprintf("  %s calls %s (not selected)", sym.Name, call))
			}
		}
	}
	if len(deps) > 0 && len(deps) <= 10 {
		parts = append(parts, "\n## External Dependencies\n"+strings.Join(deps, "\n"))
	}

	return strings.Join(parts, "\n")
}

func extractSymbolCode(repoPath string, sym Symbol) string {
	return ExtractCode(repoPath, sym)
}

// ExtractCode reads the source lines for a symbol.
func ExtractCode(repoPath string, sym Symbol) string {
	path := filepath.Join(repoPath, sym.File)
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(string(data), "\n")
	start := sym.StartLine - 1
	end := sym.EndLine
	if start < 0 {
		start = 0
	}
	if end > len(lines) {
		end = len(lines)
	}
	return strings.Join(lines[start:end], "\n")
}
