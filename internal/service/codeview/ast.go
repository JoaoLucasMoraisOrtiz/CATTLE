package codeview

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
)

type Symbol struct {
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	File      string   `json:"file"`
	StartLine int      `json:"start_line"`
	EndLine   int      `json:"end_line"`
	Calls     []string `json:"calls"`
}

type SymbolGraph struct {
	Symbols []Symbol `json:"symbols"`
	Edges   []Edge   `json:"edges"`
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
		if err != nil || len(syms) == 0 {
			continue
		}
		for _, s := range syms {
			s.File = f
			graph.Symbols = append(graph.Symbols, s)
			symbolNames[s.Name] = true
		}
	}

	for _, s := range graph.Symbols {
		for _, call := range s.Calls {
			if symbolNames[call] {
				graph.Edges = append(graph.Edges, Edge{From: s.Name, To: call, Type: "calls"})
			}
		}
	}
	return graph, nil
}
