# ReDo! — Responsabilidade de Cada Módulo

## Módulos Core

### `pty_agent.py` — Gerenciamento de Processo PTY
- **Função**: Spawn e lifecycle de processos `kiro-cli` em PTYs isolados
- **Classe `PtyProcess`**: Encapsula `pexpect.spawn` com read/write raw
- **Função `make_clean_env(mcps)`**: Cria HOME temporário com:
  - Symlinks seletivos do HOME real (allowlist em `config.py`)
  - Cópia do `.kiro/` com `mcp.json` customizado por agente
  - Retorna `(env_dict, tmp_home_path)`
- **Isolamento**: Cada agente tem seu próprio filesystem, impedindo interferência entre MCPs
- **Cleanup**: `kill()` envia `/quit`, termina processo, e remove `tmp_home` com `shutil.rmtree`

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
- **Limites**: `MAX_RETRIES=2`, `MAX_HANDOFF_ROUNDS=10`, `MIN_RESPONSE_LEN=50`
- **`PROTOCOL_INSTRUCTIONS`**: Template com placeholder `{agent_list}` — injetado na persona de cada agente
- **`GOD_PERSONA`**: Instruções do watchdog (monitora saúde, não qualidade)
- **`HOME_ALLOWLIST`**: Arquivos do HOME real que são symlinked no HOME temporário

## Módulos de Orquestração

### `orchestrator.py` — Loop Principal do Swarm
- **Função**: Execução batch do swarm (CLI mode)
- **`run_swarm(question, workdir, flow, log, resume)`**:
  1. Carrega agentes do registry e flow
  2. Inicializa GitCheckpoint e GOD_AGENT
  3. Spawna agentes do flow (ou resume de estado salvo)
  4. Loop: envia mensagem → recebe resposta → parse sinal → roteia handoff ou termina
  5. A cada round: git commit, save state, submit review ao GOD
  6. GOD commands processados no início de cada round (non-blocking poll)
- **Retry**: `_send_with_retry()` — até `MAX_RETRIES` tentativas com backoff exponencial
- **Rollback**: Em caso de erro, faz `git reset --hard` para o commit anterior

### `session.py` — Sessão Persistente para Web/TUI
- **Função**: Versão stateful do orchestrator para uso interativo
- **Classe `SwarmSession(project_path, callback)`**:
  - `open()` — Spawna todos os agentes do flow + GOD
  - `close()` — Salva sessões e mata agentes
  - `send_to_swarm(message)` — Envia ao start agent, segue handoffs automaticamente
  - `send_to_agent(agent_id, message)` — Mensagem direta, bypass do flow
- **`EventCallback`**: Interface para receber eventos (SSE, logging)
- **Thread-safe**: Usa `threading.Lock` para serializar mensagens
- **Auto-save**: Salva estado após cada interação

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
- **`SwarmState`**: round_num, current_agent_id, pending_message, agent_ids, commit_hashes
- **`save_swarm()`**: Salva estado + envia `/chat save` para cada agente ativo
- **`resume_agent()`**: Spawna agente e carrega sessão salva via `/chat load`

### `registry.py` — Registro de Agentes
- **Função**: CRUD de definições de agentes
- **Persistência**: `agents.json` no diretório do projeto
- **`AgentDef`**: id, name, persona, color, model, workdir, mcps

### `projects.py` — Registro de Projetos
- **Função**: CRUD de projetos nomeados com paths
- **Persistência**: `~/.kiro-swarm/projects.json`
- **`Project`**: id, name, path

## Módulos de Interface

### `server.py` — API Web (FastAPI)
- **Função**: Backend REST + SSE para a interface web
- **Endpoints**:
  - `GET/POST/PUT/DELETE /api/agents` — CRUD de agentes
  - `GET/POST/DELETE /api/projects` — CRUD de projetos
  - `GET/PUT /api/flow` — Leitura/escrita do grafo de fluxo
  - `POST /api/session/open/{project_id}` — Abre sessão (spawna agentes)
  - `POST /api/session/close` — Fecha sessão
  - `POST /api/session/message` — Envia mensagem ao swarm ou agente específico
  - `GET /api/session/events` — Stream SSE de eventos em tempo real
- **SSECallback**: Converte eventos do `SwarmSession` em SSE events
- **Threading**: Spawn e mensagens rodam em threads separadas

### `app.py` — TUI (Textual)
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
