# Code Viewer — Plano de Implementação

## Objetivo

Visualizar como o código evolui a cada iteração do AI agent. Mostrar grafos de chamadas/dados, diffs por iteração, simular fluxos, e permitir que o agent configure o projeto automaticamente.

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────┐
│                      Frontend                            │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐ │
│  │ Timeline  │  │ Diff     │  │ Graph Viewer (D3.js)   │ │
│  │ (commits) │  │ Viewer   │  │ - Call graph           │ │
│  │           │  │ (inline) │  │ - Data flow            │ │
│  │           │  │          │  │ - Changed nodes (🟡)   │ │
│  │           │  │          │  │ - Click → code panel   │ │
│  └──────────┘  └──────────┘  └────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────┐│
│  │ Simulator: trace data through functions, mock APIs   ││
│  └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Git Service  │  │ AST Service      │  │ Simulator Service│
│ (Go)         │  │ (tree-sitter)    │  │ (Go + Python)    │
│              │  │                  │  │                  │
│ - watch repo │  │ - parse files    │  │ - trace calls    │
│ - list diffs │  │ - extract symbols│  │ - mock endpoints │
│ - snapshots  │  │ - build graph    │  │ - validate types │
└─────────────┘  └──────────────────┘  └──────────────────┘
```

---

## Fase 1 — Project Config + Git Diff Timeline

### Backend (Go)

**Arquivo: `internal/service/codeview/git.go`**
```
type Commit struct {
    Hash      string
    Message   string
    Author    string
    Timestamp time.Time
    Files     []FileDiff
}

type FileDiff struct {
    Path      string
    Status    string   // "added", "modified", "deleted"
    Additions int
    Deletions int
    Patch     string   // unified diff
}

func ListCommits(repoPath string, limit int) ([]Commit, error)
func GetDiff(repoPath, commitHash string) ([]FileDiff, error)
func GetFileDiff(repoPath, commitHash, filePath string) (string, error)
func WatchRepo(repoPath string, onChange func()) // fsnotify on .git/HEAD
```

Implementação: `exec.Command("git", "log", ...)` e `git diff`.

**Arquivo: `internal/domain/types.go`** — adicionar ao Project:
```go
type ProjectConfig struct {
    Language  string   `json:"language"`   // "java", "typescript", "python"
    Framework string   `json:"framework"`  // "spring-boot", "nextjs", "react-native", "flask"
    EntryFile string   `json:"entry_file"` // "src/main/java/App.java", "src/index.ts"
    TestCmd   string   `json:"test_cmd"`   // "mvn test", "npm test", "pytest"
    BuildCmd  string   `json:"build_cmd"`  // "mvn package", "npm run build"
}
```

**Arquivo: `app.go`** — novos métodos expostos:
```go
func (a *App) GetCommits(projectName string, limit int) []Commit
func (a *App) GetDiff(projectName, commitHash string) []FileDiff
func (a *App) GetFileDiff(projectName, commitHash, filePath string) string
func (a *App) SaveProjectConfig(projectName string, cfg ProjectConfig) string
```

### Frontend

**Nova aba no workspace**: "Code" (ao lado das tabs de projeto)

**Timeline** (painel esquerdo):
- Lista vertical de commits (hash curto, mensagem, tempo relativo)
- Commit selecionado mostra os arquivos alterados
- Clicar num arquivo mostra o diff inline (verde/vermelho)

**Config modal**: ao abrir projeto pela primeira vez, pede:
- Linguagem (dropdown: Java, TypeScript, Python)
- Framework (dropdown contextual)
- Entry file (auto-detect ou manual)
- Comandos de test/build

### Validação
- `git log --oneline -20` retorna commits
- `git diff <hash>~1 <hash>` retorna diffs
- Testar com repositório real do kiro-swarm

---

## Fase 2 — AST Parsing + Symbol Graph

### Backend (Go)

**Dependência**: `github.com/smacker/go-tree-sitter` + gramáticas por linguagem

**Arquivo: `internal/service/codeview/ast.go`**
```
type Symbol struct {
    Name       string
    Kind       string   // "function", "class", "method", "interface"
    File       string
    StartLine  int
    EndLine    int
    Params     []string
    ReturnType string
    Calls      []string // nomes de funções que esta chama
    CalledBy   []string // preenchido no build do grafo
}

type SymbolGraph struct {
    Symbols map[string]*Symbol  // qualified name -> symbol
    Edges   []Edge
}

type Edge struct {
    From string
    To   string
    Type string // "calls", "imports", "extends", "implements"
}

func ParseFile(path, language string) ([]*Symbol, error)
func BuildGraph(repoPath string, config ProjectConfig) (*SymbolGraph, error)
func DiffGraph(old, new *SymbolGraph) []GraphChange
```

**Gramáticas tree-sitter necessárias:**
- `tree-sitter-java` → classes, methods, calls
- `tree-sitter-javascript` / `tree-sitter-typescript` → functions, components, hooks
- `tree-sitter-python` → functions, classes, decorators

**Queries por linguagem** (tree-sitter S-expressions):
```scheme
;; Java: extrair métodos
(method_declaration
  name: (identifier) @method.name
  parameters: (formal_parameters) @method.params
  body: (block) @method.body)

;; TypeScript: extrair funções
(function_declaration
  name: (identifier) @func.name
  parameters: (formal_parameters) @func.params)

;; Python: extrair funções
(function_definition
  name: (identifier) @func.name
  parameters: (parameters) @func.params)
```

**Arquivo: `app.go`** — novos métodos:
```go
func (a *App) GetSymbolGraph(projectName string) *SymbolGraph
func (a *App) GetSymbolGraphDiff(projectName, commitHash string) []GraphChange
```

### Validação
- Parsear `app.go` → extrair todas as funções e seus calls
- Parsear um arquivo Java Spring Boot → extrair controllers, services
- Comparar grafo antes/depois de um commit

---

## Fase 3 — Graph Visual (Frontend)

### Dependência: D3.js (force-directed graph)

**Arquivo: `frontend/lib/d3.min.js`** (local, não CDN)

**Arquivo: `frontend/src/graph.js`**
```javascript
// Renderiza o SymbolGraph como grafo interativo
function renderGraph(container, graph, changes) {
    // Nodes: símbolos (cor por tipo: azul=function, verde=class, roxo=interface)
    // Edges: chamadas (setas direcionais)
    // Changed nodes: borda amarela pulsante
    // Click node: abre painel lateral com código do símbolo
    // Hover: mostra tooltip com signature
    // Zoom/pan: D3 zoom behavior
}

function highlightDataFlow(graph, startNode) {
    // Destaca o caminho de dados a partir de um nó
    // Segue edges "calls" recursivamente
    // Anima as setas mostrando direção do fluxo
}
```

**Layout do Code Viewer** (nova view no workspace):
```
┌─────────────────────────────────────────────────────┐
│ [Timeline] [Graph] [Simulator]          tabs        │
├──────────┬──────────────────────────────────────────┤
│ Commits  │                                          │
│ ┌──────┐ │         Graph / Diff / Simulator         │
│ │ abc12│ │                                          │
│ │ def34│ │    (conteúdo muda conforme tab ativa)    │
│ │ ghi56│ │                                          │
│ └──────┘ │                                          │
├──────────┴──────────────────────────────────────────┤
│ Code Panel (mostra código do símbolo selecionado)   │
└─────────────────────────────────────────────────────┘
```

**Cores dos nós:**
- 🔵 Function/Method
- 🟢 Class/Component
- 🟣 Interface/Type
- 🟡 Changed (borda pulsante)
- 🔴 Deleted
- ⚪ New (borda tracejada)

### Validação
- Renderizar grafo do kiro-swarm (Go)
- Clicar num nó mostra o código
- Selecionar commit diferente → nós changed ficam amarelos

---

## Fase 4 — Simulação de Fluxo

### Backend

**Arquivo: `internal/service/codeview/simulator.go`**
```
type TraceStep struct {
    Symbol    string
    File      string
    Line      int
    Input     map[string]any
    Output    map[string]any
    Duration  string
}

type SimulationConfig struct {
    EntryPoint string            // "handleRequest"
    MockData   map[string]any    // dados de entrada simulados
    MockAPIs   map[string]any    // respostas mock de APIs externas
}

func Simulate(graph *SymbolGraph, config SimulationConfig) ([]TraceStep, error)
```

**Arquivo: `internal/service/codeview/api_mock.go`**
```
// Para Spring Boot: parsear @RequestMapping, @GetMapping etc.
// Para Next.js: parsear pages/api/*.ts
// Para Python/Flask: parsear @app.route

type APIEndpoint struct {
    Method  string // GET, POST, etc.
    Path    string
    Handler string // nome da função
    Params  []string
}

func ExtractEndpoints(graph *SymbolGraph, framework string) []APIEndpoint
```

### Frontend

**Simulator view:**
- Dropdown: selecionar endpoint ou função de entrada
- JSON editor: dados de entrada mock
- Botão "Simulate" → mostra trace step-by-step
- Cada step destaca o nó no grafo
- Animação: dados "fluem" pelas setas do grafo

### Validação
- Simular uma request GET /api/projects no kiro-swarm
- Ver o trace: handler → service → repository → response
- Mock de dados de entrada e verificar output esperado

---

## Fase 5 — Agent Setup Generator

### Backend

**Arquivo: `internal/service/codeview/setup.go`**
```
type SetupTemplate struct {
    Language  string
    Framework string
    Files     map[string]string // path -> content
}

func GenerateSetup(config ProjectConfig) SetupTemplate
func ValidateSetup(repoPath string, config ProjectConfig) (bool, string)
```

**Templates por framework:**

| Framework | Arquivos gerados |
|-----------|-----------------|
| Spring Boot | `pom.xml`, `application.yml`, `src/main/java/Application.java` |
| Next.js | `package.json`, `tsconfig.json`, `next.config.js` |
| React Native | `package.json`, `app.json`, `babel.config.js` |
| Python/Flask | `requirements.txt`, `pyproject.toml`, `app.py` |

### Fluxo
1. Usuário configura linguagem/framework no projeto
2. Agent recebe instrução: "Configure o projeto para {framework}"
3. Agent gera os arquivos de setup
4. `ValidateSetup` roda o build/test command pra verificar
5. Se falhar, agent recebe o erro e corrige

### Validação
- Criar projeto Spring Boot do zero via agent
- `mvn compile` deve passar
- Criar projeto Next.js via agent
- `npm run build` deve passar

---

## Arquivos a Criar/Modificar

### Novos arquivos Go:
```
internal/service/codeview/
├── git.go          # Fase 1: git log, diff, watch
├── ast.go          # Fase 2: tree-sitter parsing
├── graph.go        # Fase 2: symbol graph builder
├── simulator.go    # Fase 4: trace simulation
├── api_mock.go     # Fase 4: endpoint extraction
├── setup.go        # Fase 5: project setup generator
└── queries/        # Fase 2: tree-sitter queries por linguagem
    ├── java.scm
    ├── typescript.scm
    └── python.scm
```

### Novos arquivos Frontend:
```
frontend/
├── lib/d3.min.js           # Fase 3
└── src/
    ├── codeview.js          # Fase 1-5: toda a UI do code viewer
    └── graph.js             # Fase 3: renderização D3
```

### Arquivos modificados:
```
internal/domain/types.go    # ProjectConfig struct
app.go                      # Novos métodos expostos
frontend/index.html          # Nova view "Code"
frontend/src/main.js         # Tab de navegação
frontend/src/style.css       # Estilos do code viewer
go.mod                       # go-tree-sitter dependency
install.sh                   # tree-sitter grammars
```

---

## Dependências

| Pacote | Uso |
|--------|-----|
| `github.com/smacker/go-tree-sitter` | AST parsing multi-linguagem |
| `github.com/smacker/go-tree-sitter/java` | Gramática Java |
| `github.com/smacker/go-tree-sitter/javascript` | Gramática JS |
| `github.com/smacker/go-tree-sitter/typescript/typescript` | Gramática TS |
| `github.com/smacker/go-tree-sitter/python` | Gramática Python |
| D3.js v7 (local) | Visualização de grafos |

---

## Ordem de Implementação

```
Fase 1 (2-3h): Git + Config → Timeline funcional
Fase 2 (3-4h): AST + Graph → Símbolos extraídos
Fase 3 (3-4h): D3 Visual → Grafo interativo
Fase 4 (4-5h): Simulator → Trace de fluxo
Fase 5 (2-3h): Setup → Agent gera configs
```

Total estimado: ~15-19h de implementação.
