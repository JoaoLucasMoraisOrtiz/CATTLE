# Task Analysis: File Tree Navigator

## Objetivo
Adicionar navegação em árvore de diretórios ao ReDo!, permitindo explorar a codebase, construir prompts com contexto preciso, e visualizar qualquer arquivo como grafo AST.

## Contexto
Concorrentes (TUICommander, Mux) têm file browsers integrados. O ReDo! hoje só mostra código via git diffs e busca semântica — não tem como navegar livremente pela codebase.

## Onde colocar
- **Painel esquerdo** (onde está a KB sidebar), como uma segunda aba: `📚 KB` | `📁 Files`
- Ou substituir a KB sidebar por um painel unificado com tabs: KB, Files, ambos no mesmo espaço

## Subtarefas

### 1. Backend: ListDirectory API
- `App.ListDirectory(projectName, relativePath string) []FileEntry`
- `FileEntry { Name, Path, IsDir, Size, Extension }`
- Respeitar `.gitignore` (usar `git ls-files` ou parsear .gitignore)
- Lazy loading: só lista o nível pedido, expande sob demanda

### 2. Backend: ReadFileContent API
- `App.ReadFileContent(projectName, relativePath string, startLine, endLine int) string`
- Limite de 500 linhas por request (paginação)
- Detectar binários e retornar placeholder

### 3. Backend: ParseFileSymbols API
- Já existe: `ParseFile` no embed_server.py
- Expor como `App.GetFileSymbols(projectName, filePath string) []Symbol`
- Retorna símbolos com calls, line ranges — pronto pro grafo

### 4. Frontend: File Tree Component (filetree.js)
- Árvore colapsável com ícones por extensão
- Click em diretório → expande/colapsa (lazy load)
- Click em arquivo → abre preview no painel central ou modal
- Ícones: 📁 dir, 📄 file, com cores por extensão (.java=laranja, .ts=azul, etc.)

### 5. Frontend: Ações por arquivo (context menu)
- Right-click em arquivo:
  - **📄 View** — abre conteúdo em modal (com syntax highlight básico)
  - **🔗 View as Graph** — parseia com tree-sitter, mostra grafo D3 dos símbolos
  - **📝 Add to Prompt** — adiciona `file:L1-Ln` ao prompt builder
  - **📚 Add to KB** — indexa o arquivo na knowledge base
- Right-click em diretório:
  - **📝 Add all to Prompt** — adiciona todos os arquivos do dir
  - **🔗 Graph all** — parseia todos os arquivos e mostra grafo unificado

### 6. Frontend: Integração com Prompt Builder
- Ao clicar "Add to Prompt" num arquivo, adiciona referência ao textarea do PB
- Ao clicar "View as Graph", abre o grafo no PB com os símbolos do arquivo
- Expand no grafo funciona igual (busca conexões via tree-sitter)

### 7. Frontend: Tab no sidebar
- Sidebar ganha tabs: `📚 KB` | `📁 Files`
- Tab Files mostra a árvore
- Tab KB continua como está

### 8. CSS: Estilos da árvore
- Indentação por nível (padding-left: level * 16px)
- Hover highlight, selected state
- Ícones colapsáveis (▶/▼)
- Scroll independente

## Dependências
- tree-sitter parsers (já integrados)
- `git ls-files` para filtrar .gitignore
- D3.js (já disponível)

## Estimativa
- Backend: 3 funções novas (~80 linhas Go)
- Frontend: 1 novo JS (~200 linhas), CSS (~60 linhas), HTML (tabs no sidebar)
- Integração PB: ~30 linhas

## Riscos
- Projetos grandes (10k+ arquivos): lazy loading resolve
- Arquivos binários: detectar e pular
- Symlinks: seguir ou ignorar? → ignorar por segurança
