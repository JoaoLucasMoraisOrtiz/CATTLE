# ReDo! — Visão Arquitetural Geral

## O que é
Sistema de orquestração multi-agente que coordena múltiplas instâncias do `kiro-cli` (LLM agents) rodando em PTYs isolados, conectados por um grafo de fluxo dirigido.

## Padrão Arquitetural
**Swarm de Agentes com Grafo Dirigido** — cada agente é um processo `kiro-cli` isolado em PTY próprio, com HOME temporário. A comunicação entre agentes é mediada pelo Orchestrator, que roteia mensagens seguindo as arestas definidas no grafo de fluxo (`flow.json`).

## Camadas da Arquitetura

### 1. Camada de Processo (PTY Isolation)
- `pty_agent.py` — Spawn de processos `kiro-cli` via `pexpect` em PTYs isolados
- Cada agente recebe um HOME temporário (`tempfile.mkdtemp`) com symlinks seletivos do HOME real
- MCPs configurados por agente via `mcp.json` no HOME temporário
- Allowlist de arquivos do HOME: `.config`, `.local`, `.bashrc`, `.profile`, `.zshrc`
- `env_mcp_server.py` — MCP server standalone injetado automaticamente em todo agente, expõe ferramentas de gerenciamento de processos background (`env_run`, `env_status`, `env_logs`, `env_stop`, `env_input`). Resolve o problema de `execute_bash` bloqueante do kiro-cli para comandos long-running (servidores, builds, etc.)

### 2. Camada de Agente (Interface de Alto Nível)
- `agent.py` — Compõe PTY + output parser em interface send/receive limpa
- Detecção de processamento via keywords ("Thinking", "Using tool:")
- Detecção de prompt via regex `\d+%\s*!>` (prompt do kiro-cli)
- Limpeza de output: remove ANSI codes, spinners, timing info

### 3. Camada de Protocolo (Comunicação Inter-Agente)
- `protocol.py` — Parse de sinais `@handoff(agent_id): contexto` e `@done: resumo`
- `config.py` — Template de instruções de protocolo injetado na persona de cada agente
- Agentes só podem fazer handoff para alvos permitidos pelo grafo de fluxo

### 4. Camada de Orquestração
- `orchestrator.py` — Loop principal: envia mensagem → recebe resposta → parse sinal → roteia
- `session_service.py` — Versão persistente do orchestrator para uso web/interativo
- `agent_helpers.py` — Lógica compartilhada entre orchestrator e session (composição de persona, resolução de headers)
- `flow.py` — Grafo dirigido (nós = agentes, arestas = rotas permitidas de handoff, com suporte a return edges)

### 5. Camada de Supervisão
- `god.py` — GOD_AGENT: watchdog assíncrono que monitora saúde técnica do swarm
- Roda em thread separada, recebe summaries de cada round
- Comandos: `@continue`, `@restart(agent)`, `@compact(agent)`, `@stop(agent)`

### 6. Camada de Persistência
- `checkpoint.py` — Git auto-commit após cada round, rollback em caso de erro
- `swarm_state.py` — Salva estado do swarm em `~/.kiro-swarm/sessions/` (função pública `project_dir()`)
- `registry.py` — CRUD de definições de agentes em `agents.json`
- `projects.py` — CRUD de projetos em `~/.kiro-swarm/projects.json`

### 6.5. Camada de Serviços
- `header_service.py` — CRUD + composição de header templates (protocol, wrapper, handoff)
- `flow_service.py` — CRUD de múltiplos flows em `~/.kiro-swarm/flows.json`
- `data_collector.py` — Coleta de training data em MySQL remoto
- `settings_service.py` — Key-value store de configurações do usuário

### 7. Camada de Interface
- **CLI**: `orchestrator.py` direto via `python3 orchestrator.py`
- **TUI**: `app.py` — Interface Textual com CRUD de agentes e execução do swarm
- **Web**: `main.py` (FastAPI) + controllers modulares + `static/` — REST API + SSE para streaming
- Entry point unificado: `run.sh [web|tui|run]`

## Dependências Externas
- `pexpect` — PTY management
- `fastapi` + `uvicorn` — Web server
- `sse-starlette` — Server-Sent Events
- `textual` — TUI framework
- `pymysql` — MySQL connector (opcional, para data_collector)
- `python-dotenv` — Carrega `.env` para configuração
- `mcp` — SDK MCP do PyPI (≥1.0), usado pelo `env_mcp_server.py` para expor tools de gerenciamento de processos
- `kiro-cli` — O LLM agent que cada processo executa

## Configuração
- `agents.json` — Definições de agentes (id, nome, persona, cor, modelo, MCPs)
- `flows.json` — Múltiplos grafos de fluxo (nós com posições x/y, arestas src→dst com return flag, start_node, default_header_ids)
- `headers.json` — Header templates (protocol, wrapper, handoff) com composição dinâmica
- `settings.json` — Configurações de usuário (data_collection, etc.)
- `config.py` — Constantes: timeouts, limites de retry, template de protocolo, persona do GOD
- `app/models/header.py` — Single source of truth para IDs de headers default
