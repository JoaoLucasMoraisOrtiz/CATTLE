# ReDo! v2 — Pivot Architecture

> Terminal multiplexer inteligente com RAG injection para code agents.

## O que mudou

| Aspecto | v1 (Python) | v2 (Go) |
|---|---|---|
| Linguagem | Python (interpretado) | Go (compilado, binário único) |
| Agentes | PTY gerenciado por pexpect, output parseado | Terminal real, usuário interage direto |
| Orquestração | Automática (orchestrator roteia mensagens) | Manual (usuário controla, app assiste) |
| Comunicação inter-agente | Protocolo @handoff/@done | Removido — cada terminal é independente |
| System prompt | Injetado no spawn do agente | Removido inicialmente. Depois: RAG injection |
| Conhecimento | Nenhum | KB com docs do usuário → RAG → injection no prompt |
| Interface | Web (FastAPI+SSE) + TUI (Textual) | TUI nativa (bubbletea) — compilada |

## Arquitetura v2

```
┌──────────────────────────────────────────────────────────────┐
│                    ReDo! TUI (bubbletea)                      │
│                                                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                     │
│  │ Project A │ │ Project B │ │ Project C │  ← tabs            │
│  └────┬─────┘ └──────────┘ └──────────┘                     │
│       │                                                       │
│  ┌────┴──────────────────────────────────────────────┐       │
│  │  Terminal Panes (output only, split view)          │       │
│  │  ┌──────────────┐ ┌──────────────┐ ┌───────────┐ │       │
│  │  │ backend 🟠   │ │ frontend 🔵  │ │ tester 🟢 │ │       │
│  │  │ (kiro-cli)   │ │ (gemini)     │ │ (claude)  │ │       │
│  │  │ real PTY     │ │ real PTY     │ │ real PTY  │ │       │
│  │  └──────────────┘ └──────────────┘ └───────────┘ │       │
│  └───────────────────────────────────────────────────┘       │
│                                                               │
│  ┌─ Input ───────────────────────────────────────────┐       │
│  │ [@backend @frontend] implemente o filtro por status│       │
│  └───────────────────────────────────────────────────┘       │
│                                                               │
│  ┌───────────────────────────────────────────────────┐       │
│  │  Conversation Watcher (reads agent save files)     │       │
│  │  fsnotify → parse → MySQL → embeddings             │       │
│  └──────────────┬────────────────────────────────────┘       │
│                 │                                              │
│  ┌──────────────┴────────────────────────────────────┐       │
│  │  Knowledge Engine (MySQL)                          │       │
│  │  KB docs + conversas anteriores → busca semântica  │       │
│  └──────────────┬────────────────────────────────────┘       │
│                 │                                              │
│  ┌──────────────┴────────────────────────────────────┐       │
│  │  Context Curator                                   │       │
│  │  ranking semântico → curadoria → compressão        │       │
│  │  → reescreve arquivo de sessão do agent            │       │
│  └──────────────┬────────────────────────────────────┘       │
│                 │                                              │
│  ┌──────────────┴────────────────────────────────────┐       │
│  │  Prompt Injector                                   │       │
│  │  KB context + resumo compactado → prepende ao input│       │
│  └───────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
```

## Módulos

### 1. Terminal Manager
- Cria PTYs reais via `os/exec` + `creack/pty`
- Cada terminal roda o comando que o usuário configurou (kiro-cli, gemini-cli, claude, etc.)
- Captura output em tempo real (para o Conversation Watcher)
- Passa input do usuário para o PTY (com possível injection)
- Split view: múltiplos terminais lado a lado

### 2. Conversation Watcher
- Monitora os arquivos de sessão dos agents via fsnotify
- Quando detecta mudança, parseia novas mensagens (driver por agent)
- Salva no MySQL com embeddings
- Mantém índice atualizado para busca semântica
- Trigger: quando o usuário começa a digitar, busca contexto relevante

### 3. Knowledge Engine
- MySQL — mesma instância usada para conversas
- O usuário cadastra: documentações, specs de API, regras de negócio, READMEs
- Indexa em chunks com embeddings (Gemini API)
- Busca semântica: dado o contexto da conversa, retorna os chunks mais relevantes
- Fontes de busca: KB docs **+** conversas anteriores (tudo no mesmo MySQL)

```sql
CREATE TABLE kb_chunks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    project VARCHAR(255) NOT NULL,
    source_file VARCHAR(500),          -- path do doc original
    content TEXT NOT NULL,
    embedding BLOB,
    chunk_index INT,                   -- posição no doc original
    INDEX idx_project (project),
    FULLTEXT idx_content (content)
);
```

### 4. Prompt Injector
- Intercepta o input do usuário antes de enviar ao PTY
- Se a KB tem contexto relevante, prepende ao input:
  ```
  [Context from KB: O endpoint /api/pedidos usa paginação com PageRequest. 
   O DTO retorna campos: id, status, cpfSolicitante, dataEncaminhamento.]
  
  <mensagem original do usuário>
  ```
- O usuário vê o que foi injetado (transparência)
- Toggle: o usuário pode desligar a injection

### 5. Config Manager
- Projetos: path, KBs associadas
- Agents: lista de agents por projeto, cada um com: nome, comando de spawn, MCPs, modelo, cor
- O usuário pode ter N agents no mesmo projeto (ex: kiro para backend, gemini para frontend, claude para testes)
- MCPs: configuração por agent (injetada no HOME temporário, como v1)
- Persiste em JSON ou SQLite

Exemplo de config:
```json
{
  "projects": [{
    "name": "SGABE",
    "path": "/home/joao/Documentos/sgabePrototipos",
    "kbs": ["docs/", "Knowledge.md"],
    "agents": [
      { "name": "backend", "command": "kiro-cli chat", "color": "#f0883e", "mcps": {} },
      { "name": "frontend", "command": "gemini", "color": "#1f6feb", "mcps": {} },
      { "name": "tester", "command": "claude", "color": "#3fb950", "mcps": {} }
    ]
  }]
}
```

### 6. TUI (bubbletea + lipgloss)
- Tabs de projetos
- Split panes de terminais (**output only** — mostram a conversa do agent)
- **Input centralizado**: text-box na parte inferior, compartilhado
  - `@agent_name` para direcionar a mensagem (ex: `@backend implemente o filtro`)
  - Múltiplos destinos: `@backend @frontend implemente o filtro` → envia para ambos
  - Sem `@`: envia para o terminal focado
  - Autocomplete de nomes de agents com Tab
- Sidebar com KB status / insights encontrados
- Barra de status com agent info
- Keybindings: Ctrl+N novo agent, Ctrl+W fechar, Ctrl+Tab trocar foco, etc.

## Stack Técnico

| Componente | Biblioteca |
|---|---|
| TUI framework | bubbletea + lipgloss + bubbles |
| PTY management | creack/pty |
| Terminal rendering | charmbracelet/x/xpty ou vt100 parser |
| Conversation capture | fsnotify (file watcher) + parsers por agent format |
| Embeddings | API Gemini (google/generative-ai-go) |
| Database | MySQL (como v1) — conversas, embeddings, KB, config |
| Config | JSON files (projetos/agents) + MySQL (dados persistentes) |
| Build | `go build` → binário único |

## Conversation Capture (TUI-agnostic)

### O problema
Precisamos capturar as conversas (user + agent) de forma limpa para salvar, indexar, e usar como RAG.

### A solução: Ler os saves do próprio agent

Todo code-agent TUI já salva suas sessões em arquivos limpos:

| Agent | Onde salva | Formato | Como triggerar |
|---|---|---|---|
| kiro-cli | `~/.kiro/` | Markdown/JSON | `/chat save` ou auto |
| gemini-cli | `~/.gemini/conversations/` | JSON (role/content) | Auto |
| claude | `~/.claude/` | JSONL | Auto |

Em vez de parsear o output do terminal (frágil), lemos o que o agent já salvou:

```
Agent salva sessão (arquivo limpo)
  → fsnotify detecta mudança
    → Parser lê novas mensagens (formato específico do agent)
      → MySQL storage (conversations table)
```

### Implementação

1. **Driver por agent**: Cada agent tem um driver que sabe:
   - Onde fica o arquivo de sessão (path pattern)
   - Formato do arquivo (markdown, JSON, JSONL)
   - Como parsear role + content
   
2. **File watcher**: `fsnotify` monitora o arquivo de sessão. Quando muda, lê as novas mensagens.

3. **Parser por formato**: Extrai `{role, content, timestamp}` de cada formato.

4. **Fallback**: Se o agent não salva automaticamente, o ReDo! pode enviar o comando de save periodicamente (ex: `/chat save` no kiro) via PTY write.

### Vantagens sobre VT100 parsing
- Zero parsing de terminal — texto já vem limpo do agent
- TUI-agnostic de verdade — cada agent salva no seu formato, nós só lemos
- Confiável — é o próprio agent que gera o texto
- Extensível — adicionar novo agent = novo driver de leitura

### Formato salvo (MySQL)

```sql
CREATE TABLE conversations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    project VARCHAR(255) NOT NULL,
    agent VARCHAR(100) NOT NULL,
    role ENUM('user', 'assistant') NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME NOT NULL,
    embedding BLOB,
    session_id VARCHAR(36) NOT NULL,
    INDEX idx_project_agent (project, agent),
    INDEX idx_session (session_id),
    FULLTEXT idx_content (content)
);
```

### Uso futuro

1. **Responder sem LLM**: Busca semântica nas conversas anteriores → resposta direto (zero tokens)
2. **RAG de conversas**: Contexto de conversas passadas injetado no prompt
3. **Analytics**: Tópicos, agents mais usados, tempo de resposta
4. **Replay**: Reconstruir sessão completa para review

### Context Curation (economia de tokens)

Os agents carregam o histórico do arquivo de sessão. Se manipulamos o arquivo antes do agent ler, controlamos o que ele vê.

```
Histórico completo (100 mensagens, ~50K tokens)
  → Busca semântica: quais são relevantes para o próximo input do usuário?
  → Filtra: mantém 15 mensagens relevantes (~8K tokens)
  → Reescreve o arquivo de sessão do agent
  → Agent carrega histórico curado
  → Menos tokens, mais foco, melhor resultado
```

**Como funciona por agent:**

| Agent | Arquivo de sessão | Manipulável? |
|---|---|---|
| kiro-cli | `~/.kiro/chats/{id}.json` | Sim — JSON com array de mensagens |
| gemini-cli | `~/.gemini/conversations/{id}` | Sim — JSON |
| claude | `~/.claude/conversations/{id}` | Sim — JSONL |

**O processo:**
1. Usuário digita mensagem no text-box central
2. ReDo! lê o histórico completo do MySQL (todas as mensagens da sessão)
3. Busca semântica: ranqueia mensagens por relevância ao input atual
4. Reescreve o arquivo de sessão do agent com apenas as top-K relevantes + as últimas N (para continuidade)
5. Envia o input ao agent via PTY
6. Agent lê o histórico curado e responde com contexto otimizado

**Regras de curadoria:**
- Sempre manter as últimas 3-5 mensagens (continuidade da conversa)
- Sempre manter mensagens que o agent referenciou (citou arquivo, função)
- Ranquear o resto por similaridade semântica com o input atual
- Limite de tokens configurável pelo usuário (ex: 8K, 16K, 32K)
- **Mensagens descartadas não são perdidas** — são comprimidas num resumo (ver abaixo)

**Compressão de contexto descartado:**

As mensagens que não entram no top-K não são simplesmente removidas. São enviadas ao LLM (pode ser o próprio agent ou um modelo barato) para gerar um resumo compactado:

```
85 mensagens irrelevantes (~42K tokens)
  → LLM compacta → resumo de ~1K tokens
  → Cacheado no MySQL (recomprime só quando acumula novas mensagens)

Arquivo de sessão final:
  [Resumo: configuramos Docker+PostgreSQL, implementamos CRUD editais,
   corrigimos bug autosave, discutimos arquitetura de comissões...]
  + 15 mensagens relevantes completas
  + últimas 3 mensagens (continuidade)
  = ~9K tokens em vez de 50K
```

O agent tem **visão geral** (resumo compactado) + **detalhe** (mensagens relevantes). Não fica cego sobre o que foi discutido, mas não gasta tokens com texto completo irrelevante.

O resumo é cacheado — só recomprime quando novas mensagens descartadas se acumulam acima de um threshold.

**Resultado:** O agent trabalha com um "resumo inteligente" do histórico em vez do histórico bruto. Menos tokens gastos, menos confusão, respostas mais focadas.

## Fluxo do Usuário

```
1. redo                          # inicia o app
2. Ctrl+N → novo projeto         # configura path, agents, KBs
3. Enter → abre terminal          # spawna kiro-cli no projeto
4. Usuário digita normalmente     # conversa com o agent
5. [Background] Watcher lê output # detecta contexto
6. [Background] KB search         # encontra docs relevantes  
7. Próximo input do usuário       # injection prepende contexto
8. Agent recebe input enriquecido # responde melhor
```

## O que mantém da v1
- Conceito de múltiplos projetos com tabs
- Configuração de MCPs por agent
- Estética de "swarm" (múltiplos terminais trabalhando)
- Spawn de agents em HOME isolado com MCPs configurados

## O que remove da v1
- Orchestrator (roteamento automático de mensagens)
- Protocolo @handoff/@done
- GOD agent (watchdog)
- Flow graph (grafo dirigido de handoffs)
- Output parser (detecção de prompt, processing keywords)
- Session service (persistência de sessão de orquestração)
- Web UI (FastAPI + SSE) — tudo vira TUI
- Data collector (MySQL training data)

## Implementação — Ordem

### Fase 1: Terminal Multiplexer básico
- [ ] Projeto Go com bubbletea
- [ ] PTY spawn + capture (creack/pty)
- [ ] Terminal rendering em pane
- [ ] Split view (2+ terminais)
- [ ] Tabs de projetos
- [ ] Config: projetos + agents em JSON

### Fase 2: MCP Injection
- [ ] HOME temporário com MCPs configurados (port da lógica v1)
- [ ] Spawn do agent com env customizado

### Fase 3: Knowledge Engine + Conversation Storage
- [ ] MySQL schema (conversations, kb_chunks)
- [ ] Agent session drivers (kiro, gemini, claude — onde salva, formato)
- [ ] File watcher (fsnotify) para detectar novas mensagens nos saves
- [ ] Parsers por formato (markdown, JSON, JSONL)
- [ ] Fallback: enviar comando de save via PTY periodicamente
- [ ] Save user messages + agent responses to MySQL
- [ ] Embeddings via Gemini API
- [ ] Indexação de docs (markdown, txt, código) em kb_chunks
- [ ] Busca semântica unificada (KB + conversas anteriores)
- [ ] UI para gerenciar KBs por projeto

### Fase 4: Conversation Watcher + Prompt Injection
- [ ] Parser de output do terminal (detectar mensagens)
- [ ] Trigger de busca na KB baseado no contexto
- [ ] Injection de contexto no input do usuário
- [ ] UI mostrando o que foi injetado

### Fase 5: Context Curation
- [ ] Leitura + parsing do arquivo de sessão de cada agent
- [ ] Ranking semântico de mensagens por relevância ao input atual
- [ ] Reescrita do arquivo de sessão com mensagens curadas
- [ ] Regras: manter últimas N + top-K relevantes + referenciadas
- [ ] Limite de tokens configurável
- [ ] UI mostrando quantas mensagens foram filtradas e tokens economizados
