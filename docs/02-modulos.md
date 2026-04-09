# ReDo! — Responsabilidade de Cada Módulo

## Módulos Core

### `pty_agent.py` — Gerenciamento de Processo PTY
- **Função**: Spawn e lifecycle de processos `kiro-cli` em PTYs isolados
- **Classe `PtyProcess`**: Encapsula `pexpect.spawn` com read/write raw
- **Função `make_clean_env(mcps, workdir=None)`**: Cria HOME temporário com:
  - Symlinks seletivos do HOME real (allowlist em `config.py`)
  - Cópia do `.kiro/` com `mcp.json` customizado por agente
  - Se `workdir` fornecido e `ENV_MCP_AUTO_INJECT=True`: injeta automaticamente o MCP `env-manager` no dict de MCPs antes de escrever `mcp.json`. O MCP aponta para `env_mcp_server.py` com `--state-dir /tmp/kiro-env-{hash}/` (hash = MD5 truncado do workdir)
  - Retorna `(env_dict, tmp_home_path)`
- **Propagação de workdir**: `PtyProcess.spawn()` passa `self.workdir` para `make_clean_env()` (único caller direto)
- **Isolamento**: Cada agente tem seu próprio filesystem, impedindo interferência entre MCPs
- **Cleanup**: `kill()` envia `/quit`, termina processo, e remove `tmp_home` com `shutil.rmtree`

### `env_mcp_server.py` — MCP Server de Gerenciamento de Processos Background
- **Função**: MCP server standalone (stdio) que permite agentes executarem e monitorarem processos long-running sem bloquear
- **SDK**: Usa pacote `mcp` do PyPI (FastMCP/Server class) com registro de tools via decorators
- **Classe `ProcessManager`**: Dict de processos protegido por `threading.Lock` para thread safety
  - Cada processo: `Popen`, `deque(maxlen=500)` para output, thread daemon de leitura, `start_time`
  - Reader thread por processo: `readline()` em loop no stdout/stderr (merged via `Popen(stderr=STDOUT)`)
- **5 Tools expostas**:
  - `env_run(command, name, cwd?)` — Inicia processo em background, retorna imediatamente. Output capturado em ring buffer
  - `env_status(name?)` — Status de processos (running/exited, exit_code, uptime, últimas 5 linhas de output)
  - `env_logs(name, lines=50)` — Últimas N linhas de stdout+stderr combinados do ring buffer
  - `env_stop(name, force=false)` — Para processo (SIGTERM default, SIGKILL se force)
  - `env_input(name, text)` — Envia texto para stdin do processo (interatividade)
- **PID Persistence**: `state_dir/processes.json` — mapa `{name: {pid, command, start_time}}`. No startup, reconcilia com PIDs vivos para detectar zombies
- **Cleanup**: `atexit.register` + signal handler SIGTERM — mata todos os processos filhos e limpa `processes.json`
- **Standalone**: `if __name__ == '__main__':` com `argparse` para `--state-dir`

### `agent.py` — Interface de Alto Nível do Agente
- **Função**: Compõe `PtyProcess` + `output_parser` em API limpa `send(message) → response`
- **Classe `Agent(name, workdir, model, mcps)`**:
  - `start()` — Spawn PTY e aguarda prompt inicial
  - `send(message)` — Envia mensagem, detecta processamento, aguarda prompt, limpa resposta
  - `quit()` — Mata o processo PTY
- **Detecção de processamento**: `_skip_until_processing()` — espera keywords "Thinking"/"Using tool:"
- **Detecção de prompt**: `_read_until_prompt()` — lê chunks até regex `\d+%\s*!>` no tail
- **Context manager**: Suporta `with Agent(...) as a:`

### `protocol.py` — Parser de Sinais de Comunicação
- **Função**: Extrai sinais `@handoff` e `@done` das respostas dos agentes
- **Regex**: `@handoff(\w+)\s*:\s*(.+)` e `@done\s*:\s*(.+)`
- **`parse(response) → Signal`**: Busca nas últimas 5 linhas da resposta
- **Dataclass `Signal`**: `kind` (handoff/done/none), `target`, `summary`, `clean_response`
- **Limpeza**: Remove o sinal do texto da resposta para não poluir handoffs subsequentes

### `flow.py` — Grafo de Fluxo Dirigido
- **Função**: Define quais agentes podem se comunicar com quais
- **Dataclasses**: `Node(agent_id, x, y)`, `Edge(src, dst)`, `Flow(nodes, edges, start_node)`
- **`targets_for(agent_id)`**: Retorna lista de destinos permitidos para handoff
- **`start_agent()`**: Retorna o nó inicial (explícito via `start_node` ou inferido como nó sem arestas de entrada)
- **Persistência**: `flow.json` no diretório do projeto
- **Posições x/y**: Usadas pela UI web para renderizar o grafo visualmente

### `config.py` — Constantes e Configuração Central
- **Timeouts**: `RESPONSE_TIMEOUT=300s`, `STARTUP_TIMEOUT=60s`, `PROCESSING_DETECT_TIMEOUT=30s`
- **Limites**: `MAX_RETRIES=2`, `MAX_HANDOFF_ROUNDS=10`, `MIN_RESPONSE_LEN=50`, `MAX_SIGNAL_NUDGES=1`
- **Environment Manager**: `ENV_MCP_BUFFER_LINES=500` (tamanho do ring buffer), `ENV_MCP_TIMEOUT=300` (timeout do MCP), `ENV_MCP_AUTO_INJECT=True` (flag para desabilitar injeção automática)
- **`NUDGE_MESSAGE`**: Mensagem enviada quando agente não emite sinal `@handoff`/`@done`
- **`PROTOCOL_INSTRUCTIONS`**: Template com placeholder `{agent_list}` — injetado na persona de cada agente
- **`GOD_PERSONA`**: Instruções do watchdog (monitora saúde, não qualidade)
- **`HOME_ALLOWLIST`**: Arquivos do HOME real que são symlinked no HOME temporário
- **Nota**: IDs de headers default (`DEFAULT_PROTOCOL_ID`, `DEFAULT_WRAPPER_ID`, `DEFAULT_HANDOFF_ID`) foram movidos para `app/models/header.py` como single source of truth

## Módulos de Orquestração

### `agent_helpers.py` — Lógica Compartilhada de Agentes
- **Função**: Helpers reutilizados por `orchestrator.py` e `session_service.py`, evitando duplicação
- **`resolve_header_ids(node_id, flow, flow_def)`**: Resolve IDs de header para um nó: nó → flow → default
- **`compose_persona(defn, header_ids, agent_list)`**: Monta persona a partir de headers, com fallback para persona raw + protocol
- **`build_agent_list_for(agent_id, agents, flow)`**: Gera string de agentes visíveis para um agente baseado nas arestas do flow

### `orchestrator.py` — Loop Principal do Swarm
- **Função**: Execução batch do swarm (CLI mode)
- **`run_swarm(question, workdir, flow, log, resume, flow_id)`**:
  1. Carrega agentes do registry e flow
  2. Inicializa GitCheckpoint e GOD_AGENT
  3. Spawna agentes do flow (ou resume de estado salvo)
  4. Loop: envia mensagem → recebe resposta → parse sinal → roteia handoff ou termina
  5. A cada round: git commit, save state, submit review ao GOD
  6. GOD commands processados no início de cada round (non-blocking poll)
- **Retry**: `_send_with_retry()` — até `MAX_RETRIES` tentativas com backoff exponencial
- **Rollback**: Em caso de erro, faz `git reset --hard` para o commit anterior
- **Delega** composição de persona e resolução de headers para `agent_helpers`
- ⚠️ **Bug conhecido**: `_init_agent` definida duas vezes (a segunda sobrescreve a primeira)

### `session_service.py` — Sessão Persistente para Web/TUI
- **Função**: Versão stateful do orchestrator para uso interativo
- **Classe `SwarmSession(project_path, callback, flow_id)`**:
  - `open()` — Spawna todos os agentes do flow em paralelo (threads)
  - `close()` — Compacta contexto, salva sessões, mata agentes e limpa `state_dir` do env-manager (`/tmp/kiro-env-{hash}/`) via `shutil.rmtree` como safety net
  - `abort()` — Interrompe operação em andamento via `threading.Event`
  - `interrupt_agent(agent_id)` — Interrompe agente específico
  - `restart_agent(agent_id)` — Re-spawna agente
  - `send_to_swarm(message)` — Envia ao start agent, segue handoffs automaticamente
  - `send_to_agent(agent_id, message)` — Mensagem direta, bypass do flow
- **Return edges**: Suporte a arestas de retorno (`flow.edge_returns()`) com `return_stack`
- **Auto-compact**: `_auto_compact()` monitora uso de contexto via regex `(\d+)%.*?!>` e compacta se ≥ 70%
- **Compact all**: `_compact_all()` compacta todos os agentes em paralelo ao final de cada swarm run
- **Nudge**: Se agente não emite sinal, envia `NUDGE_MESSAGE` até `MAX_SIGNAL_NUDGES` vezes
- **Busy tracking**: `_busy` set impede envio simultâneo ao mesmo agente; `_agent_queues` enfileira mensagens
- **Pending messages**: Mensagens enviadas durante `open()` são enfileiradas e processadas após spawn
- **`EventCallback`**: Interface para receber eventos (SSE, logging)
- **Delega** composição de persona e resolução de headers para `agent_helpers`

## Módulos de Serviço (app/services/)

### `header_service.py` — CRUD + Composição de Headers
- **Função**: Gerencia header templates (protocol, wrapper, handoff) com persistência em `~/.kiro-swarm/headers.json`
- **CRUD**: `load_all()`, `get()`, `add()`, `update()`, `remove()`, `set_default()`
- **`compose(header_ids, context_vars)`**: Concatena headers e interpola placeholders (`{agent_name}`, `{agent_list}`, etc.)
- **`ensure_defaults()`**: Cria headers default se não existirem (protocol, wrapper, handoff)
- **Atomic writes**: Usa `tmp.replace()` para escrita segura

### `flow_service.py` — CRUD de Flows (Multi-Flow)
- **Função**: Gerencia múltiplos grafos de fluxo em `~/.kiro-swarm/flows.json`
- **`FlowDef`**: id, name, flow (Flow), default_header_ids
- **Migração**: `migrate()` converte `flow.json` legado para formato multi-flow
- **Thread-safe**: Usa `threading.Lock` para serializar escritas

### `data_collector.py` — Coleta de Training Data
- **Função**: Salva pares input/output em MySQL remoto para fine-tuning
- **Conexão**: Lazy init via env vars (`MYSQL_HOST`, `MYSQL_DB`, etc.)
- **Async**: Inserts rodam em threads daemon (non-blocking)
- **Respeitável**: Desativável via `settings_service.get_all()['data_collection']`

### `settings_service.py` — Configurações de Usuário
- **Função**: Key-value store em `~/.kiro-swarm/settings.json`
- **Defaults**: `{'data_collection': True}`

### `registry.py` — Registro de Agentes
- **Função**: CRUD de definições de agentes
- **Persistência**: `agents.json` no diretório do projeto
- **`AgentDef`**: id, name, persona, color, model, workdir, mcps

### `project_service.py` — Registro de Projetos
- **Função**: CRUD de projetos nomeados com paths
- **Persistência**: `~/.kiro-swarm/projects.json`
- **`Project`**: id, name, path

## Módulos de Supervisão

### `god.py` — GOD_AGENT (Watchdog Assíncrono)
- **Função**: Monitora saúde técnica do swarm em background
- **Classe `GodAgent(workdir, model)`**:
  - Roda em `threading.Thread` daemon
  - Recebe summaries via `submit_review(round_num, summary)`
  - Produz comandos via `poll_command() → GodCommand | None`
- **Comandos**: `@continue`, `@restart(agent)`, `@compact(agent): instruções`, `@stop(agent)`
- **Detecção de loops**: `build_summary()` inclui contagem de chamadas consecutivas ao mesmo agente
- **`parse_command(text)`**: Regex nas últimas 10 linhas da resposta do GOD

## Módulos de Persistência

### `checkpoint.py` — Git Checkpoints
- **Função**: Auto-commit após cada round, rollback em caso de erro
- **Classe `GitCheckpoint(workdir)`**:
  - `init()` — Salva hash inicial, faz stash do trabalho não commitado
  - `commit(round_num, agent_name)` — `git add -A && git commit`
  - `rollback(commit_hash)` — `git reset --hard`
  - `finish()` — `git stash pop` para restaurar trabalho original

### `swarm_state.py` — Persistência de Estado do Swarm
- **Função**: Salva/restaura estado completo do swarm fora do diretório do projeto
- **Localização**: `~/.kiro-swarm/sessions/<project_name>-<hash>/`
- **`SwarmState`**: round_num, current_agent_id, pending_message, agent_ids, commit_hashes, project_dir
- **`project_dir(workdir)`**: Função pública que retorna o diretório de sessão para um projeto
- **`save_swarm()`**: Salva estado + envia `/chat save` para cada agente ativo
- **`resume_agent()`**: Spawna agente e carrega sessão salva via `/chat load`
- **`append_chat_message()`**: Persiste mensagens de chat em `chat_history.jsonl`
- **`load_chat_history()`**: Carrega histórico de chat persistido

## Módulos de Modelo (app/models/)

### `header.py` — Modelo de Header Templates (SSoT)
- **`HeaderDef`**: Dataclass com id, name, content, type, is_default, description
- **Tipos**: `protocol`, `wrapper`, `handoff`
- **Constantes canônicas**: `DEFAULT_PROTOCOL_ID`, `DEFAULT_WRAPPER_ID`, `DEFAULT_HANDOFF_ID`
- **`AVAILABLE_PLACEHOLDERS`**: Dict de placeholders válidos por tipo de header

### `schemas.py` — Schemas Pydantic para API
- **`AgentIn`**, **`FlowIn`**, **`FlowDefIn`**, **`ProjectIn`**, **`MessageIn`**, **`HeaderIn`**, **`OpenSessionIn`**, **`SettingIn`**
- `HeaderIn` inclui campos `type` e `is_default`
- `OpenSessionIn` aceita `flow_id` opcional para selecionar flow específico

### Outros modelos
- **`agent.py`**: `AgentDef` — id, name, persona, color, model, workdir, mcps
- **`flow.py`**: `Node(agent_id, x, y, header_ids)`, `Edge(src, dst, returns)`, `Flow(nodes, edges, start_node)`
- **`protocol.py`**: `Signal` — kind, target, summary, clean_response
- **`project.py`**: `Project` — id, name, path

## Módulos de Interface

### API Web (FastAPI) — Modularizada em Controllers
- **Função**: Backend REST + SSE para a interface web
- **`main.py`**: Entry point FastAPI, monta static files e inclui routers
- **Controllers** (rotas separadas em `app/controllers/`):
  - `agents.py` — CRUD de agentes
  - `projects.py` — CRUD de projetos
  - `flows.py` — CRUD de flows (múltiplos grafos)
  - `headers.py` — CRUD de header templates
  - `session.py` — Open/close/message/events/abort/interrupt
  - `settings.py` — Configurações runtime
- **`SessionState`**: Classe com `__slots__` que encapsula estado mutável da sessão (`session`, `events`, `loop`) — substitui globals anteriores
- **SSECallback**: Definida inline em `controllers/session.py`, converte eventos do `SwarmSession` em SSE events
- **Threading**: Spawn e mensagens rodam em threads separadas

### `static/` — Interface Web (SPA)
- **Função**: Interface terminal interativa
- **CRUD de agentes**: Modal form para criar/editar agentes
- **Execução**: Roda `run_swarm()` em thread background com `TuiLogger`
- **Bindings**: `a`=adicionar, `e`=editar, `d`=remover, `r`=rodar, `q`=sair

## Módulos Utilitários

### `output_parser.py` — Limpeza de Output
- **`strip_ansi(text)`**: Remove escape codes ANSI
- **`is_processing(chunk)`**: Detecta keywords de processamento
- **`is_prompt(chunk)`**: Detecta prompt do kiro-cli no tail
- **`clean_response(text, skip_text)`**: Remove spinners, timing, prompts, input ecoado

### `logger.py` — Logging Colorido + Transcript
- **Classe `Logger`**: Output colorido no terminal (ANSI colors por tipo de evento)
- **`record()`**: Acumula transcript em memória
- **`save_transcript(outdir)`**: Salva JSON em `<projeto>/.kiro-swarm/transcript_*.json`
