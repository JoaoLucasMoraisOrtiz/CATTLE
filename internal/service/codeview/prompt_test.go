package codeview

import (
	"strings"
	"testing"
)

func TestBuildPrompt_WithSymbols(t *testing.T) {
	graph := &SymbolGraph{
		Symbols: []Symbol{
			{Name: "authenticate", Kind: "function", File: "auth.go", StartLine: 10, EndLine: 30},
			{Name: "validateToken", Kind: "function", File: "auth.go", StartLine: 35, EndLine: 50},
		},
		Edges: []Edge{{From: "authenticate", To: "validateToken", Type: "calls"}},
	}

	ctx := PromptContext{
		Symbols: []string{"authenticate", "validateToken"},
		Intent:  "refactor auth to use JWT",
	}

	// BuildPrompt tries to read files — won't find them, but should still produce output
	prompt := BuildPrompt("/nonexistent", graph, ctx)

	if !strings.Contains(prompt, "refactor auth to use JWT") {
		t.Error("prompt should contain intent")
	}
	if !strings.Contains(prompt, "authenticate") {
		t.Error("prompt should contain symbol name")
	}
	// Connections section
	if !strings.Contains(prompt, "authenticate") || !strings.Contains(prompt, "validateToken") {
		t.Error("prompt should reference both symbols")
	}
}

func TestBuildPrompt_EmptySelection(t *testing.T) {
	graph := &SymbolGraph{
		Symbols: []Symbol{
			{Name: "foo", Kind: "function", File: "main.go", StartLine: 1, EndLine: 10},
		},
	}
	ctx := PromptContext{Symbols: []string{}, Intent: "do something"}
	prompt := BuildPrompt("/tmp", graph, ctx)
	if !strings.Contains(prompt, "do something") {
		t.Error("prompt should contain intent even with no symbols")
	}
}

func TestExtractCode_NonexistentFile(t *testing.T) {
	sym := Symbol{Name: "foo", File: "nonexistent.go", StartLine: 1, EndLine: 10}
	code := ExtractCode("/nonexistent", sym)
	if code != "" {
		t.Error("should return empty for nonexistent file")
	}
}
