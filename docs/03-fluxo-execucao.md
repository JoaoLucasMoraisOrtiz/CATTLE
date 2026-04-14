# ReDo! — Fluxo de Execução Ponta a Ponta

## 1. Inicialização (Startup)

### 1.1 Entry Points
```
run.sh web  → server.py  → FastAPI + uvicorn (porta 8420)
run.sh tui  → app.py     → Textual TUI
run.sh run  → orchestrator.py → Execução batch CLI
```

### 1.2 Carregamento de Configuração
1. `registry.load()` — Lê `agents.json` → lista de `AgentDef`
2. `flow.load()` — Lê `flow.json` → `Flow(nodes, edges, start_node)`
3. `flow.start_agent()` — Determina agente inicial (explícito ou inferido)

### 1.3 Spawn de Agentes
Para cada nó no grafo de fluxo:
1. `make_clean_env(mcps, workdir)` — Cria HOME temporário:
   - `tempfile.mkdtemp(prefix='kiro_agent_')`
   - Symlinks: `.config`, `.local`, `.bashrc`, `.profile`, `.zshrc`
   - Copia `.kiro/` e escreve `mcp.json` com MCPs do agente
   - Se `workdir` fornecido e `ENV_MCP_AUTO_INJECT=True`: injeta MCP `env-manager` automaticamente no `mcp.json`:
     ```json
     "env-manager": {
       "command": "python3",
       "args": ["<path_abs>/env_mcp_server.py", "--state-dir", "/tmp/kiro-env-{hash}/"],
       "timeout": 300
     }
     ```
   - `state_dir` compartilhado entre agentes do mesmo projeto (hash do workdir) — permite que agente B veja processos iniciados por agente A
2. `pexpect.spawn('kiro-cli chat --wrap never -a', env=env)` — Inicia processo
3. `_read_until_prompt(timeout=60)` — Aguarda prompt inicial do kiro-cli
4. `agent.send(persona + protocol_instructions + "Responda apenas: Entendido.")` — Injeta persona

### 1.4 GOD_AGENT
1. `GodAgent(workdir).start(GOD_PERSONA)` — Spawna watchdog
2. Thread daemon inicia loop: `_pending.get() → agent.send(summary) → parse_command() → commands.put()`

### 1.5 Git Checkpoint
1. `GitCheckpoint(workdir).init()` — Salva hash HEAD atual
2. `git stash push -m 'kiro-swarm: pre-run stash'` — Protege trabalho não commitado

## 2. Loop Principal (Round-by-Round)

### 2.1 Estrutura de um Round
```
┌─────────────────────────────────────────────────┐
│ Round N                                          │
│                                                  │
│ 1. Poll GOD commands (non-blocking)              │
│    → restart/compact/stop se necessário           │
│                                                  │
│ 2. Enviar mensagem ao agente atual               │
│    → agent.send(message)                         │
│    → _skip_until_processing() (espera "Thinking")│
│    → _read_until_prompt() (espera prompt)        │
│    → clean_response() (limpa output)             │
│                                                  │
│ 3. Parse do sinal                                │
│    → protocol.parse(response) → Signal           │
│                                                  │
│ 4. Git checkpoint                                │
│    → git add -A && git commit                    │
│                                                  │
│ 5. Save swarm state                              │
│    → /chat save para cada agente                 │
│    → swarm_state.json                            │
│                                                  │
│ 6. Submit review ao GOD (async)                  │
│    → build_summary() → god.submit_review()       │
│                                                  │
│ 7. Roteamento                                    │
│    → @handoff(target): próximo round com target  │
│    → @done: encerra loop                         │
│    → sem sinal: encerra loop                     │
└─────────────────────────────────────────────────┘
```

### 2.2 Roteamento de Handoff
1. `protocol.parse(response)` extrai `Signal(kind='handoff', target='agent_id', summary='...')`
2. `flow.targets_for(current_id)` verifica se o target é permitido pelo grafo
3. Se permitido: monta mensagem de contexto e muda `current_id` para o target
4. Se bloqueado: log de erro e encerra loop

### 2.3 Formato da Mensagem de Handoff
```
O agente {nome} completou sua parte:

---
{resposta limpa do agente anterior}
---

Contexto do handoff: {summary do sinal}
```

### 2.4 Retry com Backoff
- Até `MAX_RETRIES=2` tentativas
- Backoff exponencial: `time.sleep(2 ** attempt)`
- Falha se resposta < `MIN_RESPONSE_LEN=50` caracteres

## 3. Supervisão pelo GOD_AGENT

### 3.1 Fluxo Assíncrono
```
Orchestrator                    GOD Thread
    │                               │
    ├── submit_review(summary) ──→  │
    │                               ├── agent.send(summary)
    │                               ├── parse_command(response)
    │   ←── poll_command() ─────────┤ (se action != continue)
    │                               │
```

### 3.2 Summary enviado ao GOD
```
Round {N} | {agent_name} | signal={kind} → {target}
Agents: {lista de agentes ativos}
⚠ LOOP: {agent} chamado {N}x seguidas  (se >= 3)
Errors: {últimos 3 erros}
Status?
```

### 3.3 Ações do GOD
- `@continue` — Nada a fazer (maioria dos casos)
- `@restart(agent_id)` — Mata e re-spawna o agente (travou/contexto corrompido)
- `@compact(agent_id): instruções` — Envia `/compact` ao agente (contexto grande)
- `@stop(agent_id)` — Mata permanentemente (irrecuperável)

## 4. Finalização

### 4.1 Encerramento Normal
1. Sinal `@done` recebido → log do summary
2. Transcript salvo em `<projeto>/.kiro-swarm/transcript_*.json`
3. Todos os agentes recebem `quit()` → `/quit` + `terminate(force=True)`
4. GOD_AGENT encerrado
5. HOMEs temporários removidos com `shutil.rmtree`

### 4.2 Encerramento por Erro
1. Se git habilitado: rollback para commit do round anterior
2. Cleanup de agentes e GOD igual ao normal

### 4.3 Interrupção (Ctrl+C)
1. `git rollback_to_initial()` — Volta ao estado antes do swarm
2. `git stash pop` — Restaura trabalho original (se `finish()` chamado)

## 5. Modo Web (Session-based)

### 5.1 Diferenças do Modo Batch
- Agentes ficam vivos entre mensagens (sessão persistente)
- Múltiplas mensagens podem ser enviadas sequencialmente
- `send_to_agent()` permite bypass do flow (mensagem direta)
- Eventos streamados via SSE (`/api/session/events`)
- Thread-safe com `threading.Lock`

### 5.2 Fluxo Web
```
Browser → POST /api/session/open/{project_id}
       → Thread: SwarmSession.open() (spawna agentes)
       → GET /api/session/events (SSE stream)
       → POST /api/session/message {text, agent_id?}
       → Thread: send_to_swarm() ou send_to_agent()
       → SSE events: orch, agent, error, summary, done
```
