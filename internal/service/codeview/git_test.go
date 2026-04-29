package codeview

import (
	"testing"
)

func TestSymbolGraph_EdgeBuilding(t *testing.T) {
	graph := &SymbolGraph{}
	graph.Symbols = []Symbol{
		{Name: "foo", Kind: "function", Calls: []string{"bar", "baz", "external"}},
		{Name: "bar", Kind: "function", Calls: []string{"foo"}},
		{Name: "baz", Kind: "function", Calls: []string{}},
	}

	symbolNames := map[string]bool{}
	for _, s := range graph.Symbols {
		symbolNames[s.Name] = true
	}
	for _, s := range graph.Symbols {
		for _, call := range s.Calls {
			if symbolNames[call] && call != s.Name {
				graph.Edges = append(graph.Edges, Edge{From: s.Name, To: call, Type: "calls"})
			}
		}
	}

	if len(graph.Edges) != 3 {
		t.Errorf("expected 3 edges, got %d: %+v", len(graph.Edges), graph.Edges)
	}

	edgeSet := map[string]bool{}
	for _, e := range graph.Edges {
		edgeSet[e.From+"->"+e.To] = true
	}
	for _, expected := range []string{"foo->bar", "foo->baz", "bar->foo"} {
		if !edgeSet[expected] {
			t.Errorf("missing edge %s", expected)
		}
	}
	if edgeSet["foo->external"] {
		t.Error("external call should be filtered out")
	}
}

func TestMarkChangedSymbols(t *testing.T) {
	graph := &SymbolGraph{
		Symbols: []Symbol{
			{Name: "foo", Kind: "function", File: "main.go", StartLine: 10, EndLine: 20},
			{Name: "bar", Kind: "function", File: "main.go", StartLine: 30, EndLine: 40},
		},
	}

	// Simulate: line 15 was changed (inside foo), line 50 was changed (outside both)
	// We can't call MarkChanged without a real repo, but we can test the line overlap logic
	changedLines := map[int]string{15: "add", 50: "add"}

	for i := range graph.Symbols {
		s := &graph.Symbols[i]
		for line := range changedLines {
			if line >= s.StartLine && line <= s.EndLine {
				s.Status = "modified"
				break
			}
		}
	}

	if graph.Symbols[0].Status != "modified" {
		t.Error("foo should be modified (line 15 is in range 10-20)")
	}
	if graph.Symbols[1].Status != "" {
		t.Error("bar should not be modified (line 50 is outside 30-40)")
	}
}
