package codeview

import (
	"os"
	"path/filepath"
	"strings"

	sitter "github.com/smacker/go-tree-sitter"
	"github.com/smacker/go-tree-sitter/golang"
	"github.com/smacker/go-tree-sitter/java"
	"github.com/smacker/go-tree-sitter/javascript"
	"github.com/smacker/go-tree-sitter/python"
)

type Symbol struct {
	Name      string   `json:"name"`
	Kind      string   `json:"kind"` // function, class, method, interface
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
	Type string `json:"type"` // calls, imports
}

var langMap = map[string]*sitter.Language{
	"go":         golang.GetLanguage(),
	"java":       java.GetLanguage(),
	"javascript": javascript.GetLanguage(),
	"typescript": javascript.GetLanguage(), // close enough for symbol extraction
	"python":     python.GetLanguage(),
}

func langForFile(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".go":
		return "go"
	case ".java":
		return "java"
	case ".js", ".jsx":
		return "javascript"
	case ".ts", ".tsx":
		return "typescript"
	case ".py":
		return "python"
	default:
		return ""
	}
}

func ParseFile(path string) ([]Symbol, error) {
	lang := langForFile(path)
	if lang == "" {
		return nil, nil
	}
	sitterLang := langMap[lang]
	if sitterLang == nil {
		return nil, nil
	}

	src, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	parser := sitter.NewParser()
	parser.SetLanguage(sitterLang)
	tree, err := parser.ParseCtx(nil, nil, src)
	if err != nil {
		return nil, err
	}
	root := tree.RootNode()

	var symbols []Symbol
	relPath := filepath.Base(path)

	extractSymbols(root, src, relPath, lang, &symbols)
	return symbols, nil
}

func extractSymbols(node *sitter.Node, src []byte, file, lang string, out *[]Symbol) {
	for i := 0; i < int(node.ChildCount()); i++ {
		child := node.Child(i)
		kind := ""
		name := ""

		switch lang {
		case "go":
			kind, name = extractGo(child, src)
		case "java":
			kind, name = extractJava(child, src)
		case "javascript", "typescript":
			kind, name = extractJS(child, src)
		case "python":
			kind, name = extractPython(child, src)
		}

		if name != "" {
			calls := extractCalls(child, src)
			*out = append(*out, Symbol{
				Name:      name,
				Kind:      kind,
				File:      file,
				StartLine: int(child.StartPoint().Row) + 1,
				EndLine:   int(child.EndPoint().Row) + 1,
				Calls:     calls,
			})
		}
		extractSymbols(child, src, file, lang, out)
	}
}

func extractGo(n *sitter.Node, src []byte) (string, string) {
	switch n.Type() {
	case "function_declaration":
		if name := n.ChildByFieldName("name"); name != nil {
			return "function", name.Content(src)
		}
	case "method_declaration":
		if name := n.ChildByFieldName("name"); name != nil {
			return "method", name.Content(src)
		}
	case "type_declaration":
		for i := 0; i < int(n.ChildCount()); i++ {
			spec := n.Child(i)
			if spec.Type() == "type_spec" {
				if name := spec.ChildByFieldName("name"); name != nil {
					return "class", name.Content(src)
				}
			}
		}
	}
	return "", ""
}

func extractJava(n *sitter.Node, src []byte) (string, string) {
	switch n.Type() {
	case "method_declaration":
		if name := n.ChildByFieldName("name"); name != nil {
			return "method", name.Content(src)
		}
	case "class_declaration":
		if name := n.ChildByFieldName("name"); name != nil {
			return "class", name.Content(src)
		}
	case "interface_declaration":
		if name := n.ChildByFieldName("name"); name != nil {
			return "interface", name.Content(src)
		}
	}
	return "", ""
}

func extractJS(n *sitter.Node, src []byte) (string, string) {
	switch n.Type() {
	case "function_declaration":
		if name := n.ChildByFieldName("name"); name != nil {
			return "function", name.Content(src)
		}
	case "class_declaration":
		if name := n.ChildByFieldName("name"); name != nil {
			return "class", name.Content(src)
		}
	case "lexical_declaration", "variable_declaration":
		// const foo = () => {} or const Foo = function() {}
		for i := 0; i < int(n.ChildCount()); i++ {
			decl := n.Child(i)
			if decl.Type() == "variable_declarator" {
				if name := decl.ChildByFieldName("name"); name != nil {
					if val := decl.ChildByFieldName("value"); val != nil {
						if val.Type() == "arrow_function" || val.Type() == "function" {
							return "function", name.Content(src)
						}
					}
				}
			}
		}
	}
	return "", ""
}

func extractPython(n *sitter.Node, src []byte) (string, string) {
	switch n.Type() {
	case "function_definition":
		if name := n.ChildByFieldName("name"); name != nil {
			return "function", name.Content(src)
		}
	case "class_definition":
		if name := n.ChildByFieldName("name"); name != nil {
			return "class", name.Content(src)
		}
	}
	return "", ""
}

func extractCalls(node *sitter.Node, src []byte) []string {
	seen := map[string]bool{}
	var calls []string
	walkCalls(node, src, seen, &calls)
	return calls
}

func walkCalls(node *sitter.Node, src []byte, seen map[string]bool, calls *[]string) {
	if node.Type() == "call_expression" {
		fn := node.ChildByFieldName("function")
		if fn != nil {
			name := fn.Content(src)
			// Simplify: take last part of dotted name
			if idx := strings.LastIndex(name, "."); idx >= 0 {
				name = name[idx+1:]
			}
			if !seen[name] && len(name) < 60 {
				seen[name] = true
				*calls = append(*calls, name)
			}
		}
	}
	for i := 0; i < int(node.ChildCount()); i++ {
		walkCalls(node.Child(i), src, seen, calls)
	}
}

// BuildGraph parses all relevant files in a repo and builds a symbol graph.
func BuildGraph(repoPath string, changedFiles []string) (*SymbolGraph, error) {
	graph := &SymbolGraph{}
	symbolNames := map[string]bool{}

	for _, f := range changedFiles {
		fullPath := filepath.Join(repoPath, f)
		syms, err := ParseFile(fullPath)
		if err != nil || len(syms) == 0 {
			continue
		}
		for _, s := range syms {
			s.File = f
			graph.Symbols = append(graph.Symbols, s)
			symbolNames[s.Name] = true
		}
	}

	// Build edges from calls
	for _, s := range graph.Symbols {
		for _, call := range s.Calls {
			if symbolNames[call] {
				graph.Edges = append(graph.Edges, Edge{From: s.Name, To: call, Type: "calls"})
			}
		}
	}
	return graph, nil
}
