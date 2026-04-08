# ReDo! — Protocolos de Comunicação Entre Agentes

## 1. Protocolo de Sinalização (@handoff / @done)

### 1.1 Definição
Cada agente recebe instruções de protocolo injetadas na sua persona durante o startup. O template está em `config.py:PROTOCOL_INSTRUCTIONS`:

```
## Protocolo de comunicação

Você faz parte de um swarm de agentes especializados. Ao finalizar sua tarefa:

- Se precisar que OUTRO agente continue o trabalho, termine sua resposta com:
  @handoff(id_do_agente): breve descrição do que ele precisa fazer

- Se sua tarefa estiver COMPLETA e não precisar de mais ninguém, termine com:
  @done: breve resumo do que foi feito

Agentes disponíveis no swarm:
{agent_list}

IMPORTANTE: Sempre termine com @handoff ou @done. Nunca deixe sem sinalização.
```

### 1.2 Visibilidade de Agentes
Cada agente só vê os agentes para os quais pode fazer handoff (definido pelas arestas do flow graph). A `{agent_list}` é construída dinamicamente:
- `flow.targets_for(agent_id)` retorna os destinos permitidos
- Se não há destinos: `"(nenhum — você é o agente final, use @done)"`
- Formato: `- {id}: {name} — {persona[:80]}...`

### 1.3 Parsing (protocol.py)
```python
HANDOFF_RE = re.compile(r'@handoff\((\w+)\)\s*:\s*(.+)', re.DOTALL)
DONE_RE    = re.compile(r'@done\s*:\s*(.+)', re.DOTALL)
```
- Busca nas **últimas 5 linhas** da resposta
- Prioridade: `@handoff` > `@done` > `none`
- Retorna `Signal(kind, target, summary, clean_response)`
- `clean_response` = resposta original com o sinal removido

### 1.4 Validação de Roteamento
O orchestrator valida o handoff contra o flow graph:
```python
allowed = flow.targets_for(current_id)
if signal.target not in allowed:
    log.error(f'Handoff to "{signal.target}" blocked by flow')
    break
```

## 2. Protocolo do GOD_AGENT

### 2.1 Input (Summary)
O orchestrator envia um summary compacto a cada round:
```
Round {N} | {agent_name} | signal={kind} → {target}
Agents: {lista de agentes ativos}
⚠ LOOP: {agent} chamado {N}x seguidas
Errors: {últimos 3 erros}
Status?
```

### 2.2 Output (Comandos)
```python
_CMD_RE = re.compile(
    r'@(continue|restart|compact|stop)'
    r'(?:\((\w+)\))?'
    r'(?:\s*:\s*(.+))?',
    re.DOTALL
)
```
- `@continue` — Sistema saudável, nada a fazer
- `@restart(agent_id)` — Re-spawnar agente (travou, contexto corrompido)
- `@compact(agent_id): instruções` — Compactar contexto do agente
- `@stop(agent_id)` — Matar agente permanentemente

### 2.3 Execução dos Comandos
- **restart**: `agent.quit()` → `_init_agent()` (novo spawn com persona fresca)
- **compact**: Envia `/compact {payload}` ao PTY do agente → aguarda prompt
- **stop**: `agent.quit()` → `del live_agents[target]`

## 3. Protocolo PTY (kiro-cli)

### 3.1 Comunicação com o Processo
- **Envio**: `proc.send(text + '\r')` — carriage return (TUI do kiro espera `\r`, não `\n`)
- **Leitura**: `proc.read_nonblocking(size=4096, timeout=5)` — chunks não-bloqueantes
- **Detecção de processamento**: Keywords "Thinking", "Using tool:" no output
- **Detecção de prompt**: Regex `\d+%\s*!>` nos últimos 50 caracteres

### 3.2 Limpeza de Output (output_parser.py)
1. `strip_ansi()` — Remove escape codes ANSI (cores, cursor, etc)
2. Remove spinners: `[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Thinking\.\.\.`
3. Remove linhas `▸ Time:...`
4. Remove input ecoado (skip_text)
5. Trunca linhas no padrão de prompt

### 3.3 Comandos Especiais do kiro-cli Usados
- `/quit` — Encerrar o processo
- `/chat save {path} --force` — Salvar sessão para persistência
- `/chat load {path}` — Restaurar sessão salva
- `/compact {instruções}` — Compactar contexto (usado pelo GOD)
- `--wrap never -a` — Flags de startup (sem word wrap, modo agente)

## 4. Protocolo de Persistência de Sessão

### 4.1 Save
1. Para cada agente ativo: `agent._pty.write('/chat save {path} --force\r')`
2. Aguarda prompt de confirmação (timeout 30s)
3. Salva `swarm_state.json` com: round_num, current_agent_id, pending_message, agent_ids, commit_hashes

### 4.2 Resume
1. `load_swarm_state(workdir)` — Lê `swarm_state.json`
2. Para cada agente salvo: `resume_agent()`:
   - Spawna novo processo kiro-cli
   - Envia `/chat load {path}` para restaurar contexto
3. Continua do round e mensagem pendente salvos

### 4.3 Localização dos Arquivos
```
~/.kiro-swarm/
  sessions/
    {project_name}-{sha256[:12]}/
      swarm_state.json
      agent-{agent_id}  (sessão salva do kiro-cli)
  projects.json
```

## 5. Protocolo SSE (Web)

### 5.1 Tipos de Evento
| Evento    | Payload                              | Quando                        |
|-----------|--------------------------------------|-------------------------------|
| `orch`    | `{msg: string}`                      | Mensagens do orchestrator     |
| `agent`   | `{name, event, text}`                | Ações/respostas de agentes    |
| `error`   | `{msg: string}`                      | Erros                         |
| `summary` | `{text: string}`                     | Resumo final (@done)          |
| `done`    | `{}`                                 | Processamento completo        |

### 5.2 Fluxo
```
SSECallback (em SwarmSession)
  → session_loop.call_soon_threadsafe(session_events.put_nowait, event)
  → EventSourceResponse(stream()) no endpoint /api/session/events
  → Browser recebe via EventSource API
```

## 6. Flow Graph Atual (flow.json)

### 6.1 Topologia
```
architect ──→ consultor ──→ analyst
                  ↑              │
                  └──────────────┘
```
- **Start node**: `architect`
- **architect** pode fazer handoff para: `consultor`
- **consultor** pode fazer handoff para: `architect`, `analyst`
- **analyst** pode fazer handoff para: `consultor`

### 6.2 Implicação
- O `consultor` é o hub central de comunicação
- `architect` e `analyst` não se comunicam diretamente
- Toda comunicação entre architect e analyst passa pelo consultor
