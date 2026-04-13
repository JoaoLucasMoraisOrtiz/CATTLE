# ReDo! MVP

Duas instâncias do `kiro-cli` conversando entre si sobre melhorias de um projeto.

## Requisitos

- `kiro-cli` instalado e autenticado
- Python 3.10+
- `pexpect` (`pip install pexpect`)

## Uso

```bash
cd kiro-swarm
chmod +x run.sh
./run.sh /caminho/do/projeto
```

Ou diretamente:

```bash
python3 orchestrator.py /caminho/do/projeto
```

## O que acontece

1. Dois agentes kiro-cli são iniciados em PTYs separados (sem MCPs, startup rápido)
2. **Analyst** examina o projeto e lista problemas/oportunidades
3. **Architect** recebe a análise e propõe soluções priorizadas
4. **Analyst** revisa as propostas e produz um plano final
5. Transcript salvo em `<projeto>/.kiro-swarm/transcript_*.json`

## Observabilidade

- Output colorido: azul = Analyst, verde = Architect, amarelo = Orchestrator
- Timestamps em cada evento
- Cada prompt enviado e resposta recebida é exibido no terminal
- Transcript completo salvo em JSON

## Detalhes técnicos

- Cada agente roda num PTY com HOME isolado (symlinks do HOME real, mas sem MCPs)
- Submit via `\r` (a TUI do kiro espera carriage return, não newline)
- Detecção de resposta: espera "Thinking..." iniciar, depois idle timeout de 5s
- Respostas limpas: remove spinners, ANSI codes, timing info, prompts

## Tuning

No `pty_agent.py`:
- `idle_timeout` em `_read_thinking_then_idle`: segundos de silêncio = resposta completa (default: 5s)
- `RESPONSE_TIMEOUT`: timeout máximo para uma resposta (default: 180s)
- Aumente o idle_timeout se respostas estiverem sendo cortadas
