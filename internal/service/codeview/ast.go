package codeview

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
)

type Symbol struct {
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	File      string   `json:"file"`
	StartLine int      `json:"start_line"`
	EndLine   int      `json:"end_line"`
	Calls     []string `json:"calls"`
	Status    string   `json:"status,omitempty"` // "added", "modified", "deleted"
}

type SymbolGraph struct {
	Symbols []Symbol `json:"symbols"`
	Edges   []Edge   `json:"edges"`
}

// ChangedLines extracts which line numbers were modified in a diff patch.
func ChangedLines(repoPath, hash, filePath string) map[int]string {
	patch, _ := GetFilePatch(repoPath, hash, filePath)
	if patch == "" {
		return nil
	}
	lines := map[int]string{} // line number -> "add" or "del"
	currentLine := 0
	for _, line := range strings.Split(patch, "\n") {
		if strings.HasPrefix(line, "@@") {
			// Parse @@ -old,count +new,count @@
			parts := strings.Fields(line)
			for _, p := range parts {
				if strings.HasPrefix(p, "+") && strings.Contains(p, ",") {
					p = strings.TrimPrefix(p, "+")
					n, _ := strconv.Atoi(strings.Split(p, ",")[0])
					currentLine = n
					break
				} else if strings.HasPrefix(p, "+") {
					p = strings.TrimPrefix(p, "+")
					n, _ := strconv.Atoi(p)
					currentLine = n
					break
				}
			}
		} else if strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++") {
			lines[currentLine] = "add"
			currentLine++
		} else if strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---") {
			lines[currentLine] = "del"
			// Don't increment — deleted lines don't exist in new file
		} else {
			currentLine++
		}
	}
	return lines
}

// MarkChangedSymbols sets a "changed" status on symbols whose line range overlaps with diff lines.
func MarkChangedSymbols(graph *SymbolGraph, repoPath, hash string) {
	for i := range graph.Symbols {
		s := &graph.Symbols[i]
		changed := ChangedLines(repoPath, hash, s.File)
		if changed == nil {
			continue
		}
		for line, status := range changed {
			if line >= s.StartLine && line <= s.EndLine {
				if status == "add" {
					s.Status = "modified"
				} else if s.Status == "" {
					s.Status = "modified"
				}
				break
			}
		}
	}
}

type Edge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Type string `json:"type"`
}

// ParseFile calls the Python server to parse a file with tree-sitter.
func ParseFile(serverURL, path string) ([]Symbol, error) {
	body, _ := json.Marshal(map[string]string{"path": path})
	resp, err := http.Post(serverURL+"/parse", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result struct {
		Symbols []Symbol `json:"symbols"`
		Error   string   `json:"error"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	if result.Error != "" {
		return nil, fmt.Errorf("parse: %s", result.Error)
	}
	return result.Symbols, nil
}

// BuildGraph parses changed files and builds a symbol graph.
func BuildGraph(serverURL, repoPath string, changedFiles []string) (*SymbolGraph, error) {
	graph := &SymbolGraph{}
	symbolNames := map[string]bool{}

	for _, f := range changedFiles {
		fullPath := filepath.Join(repoPath, f)
		syms, err := ParseFile(serverURL, fullPath)
		if err != nil {
			fmt.Printf("[Graph] parse %s error: %v\n", fullPath, err)
			continue
		}
		if len(syms) == 0 {
			continue
		}
		fmt.Printf("[Graph] %s: %d symbols, calls sample: %v\n", f, len(syms), syms[0].Calls)
		for i := range syms {
			syms[i].File = f
			graph.Symbols = append(graph.Symbols, syms[i])
			symbolNames[syms[i].Name] = true
		}
	}

	for _, s := range graph.Symbols {
		for _, call := range s.Calls {
			if symbolNames[call] && call != s.Name {
				graph.Edges = append(graph.Edges, Edge{From: s.Name, To: call, Type: "calls"})
			}
		}
	}
	// Debug: check calls
	totalCalls := 0
	for _, s := range graph.Symbols {
		totalCalls += len(s.Calls)
	}
	fmt.Printf("[Graph] %d symbols, %d total calls, %d edges from %d files\n", len(graph.Symbols), totalCalls, len(graph.Edges), len(changedFiles))
	if totalCalls == 0 && len(graph.Symbols) > 0 {
		fmt.Printf("[Graph] DEBUG first symbol: %+v\n", graph.Symbols[0])
	}
	return graph, nil
}

// MarkChanged sets Status on symbols whose line range overlaps with diff changed lines.
func MarkChanged(graph *SymbolGraph, repoPath, hash string) {
	// Collect changed lines per file
	fileLines := map[string][]int{} // file -> list of changed line numbers
	for _, s := range graph.Symbols {
		if _, ok := fileLines[s.File]; ok {
			continue
		}
		patch, _ := GetFilePatch(repoPath, hash, s.File)
		fileLines[s.File] = parseDiffLines(patch)
	}

	for i := range graph.Symbols {
		s := &graph.Symbols[i]
		for _, line := range fileLines[s.File] {
			if line >= s.StartLine && line <= s.EndLine {
				s.Status = "modified"
				break
			}
		}
	}
}

func parseDiffLines(patch string) []int {
	var lines []int
	cur := 0
	for _, line := range strings.Split(patch, "\n") {
		if strings.HasPrefix(line, "@@") {
			// @@ -x,y +N,M @@
			for _, p := range strings.Fields(line) {
				if strings.HasPrefix(p, "+") && p != "+++" {
					p = strings.TrimPrefix(p, "+")
					if i := strings.Index(p, ","); i > 0 {
						p = p[:i]
					}
					n, _ := strconv.Atoi(p)
					cur = n
					break
				}
			}
		} else if strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++") {
			lines = append(lines, cur)
			cur++
		} else if strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---") {
			// deleted line — don't increment cur
		} else {
			cur++
		}
	}
	return lines
}
