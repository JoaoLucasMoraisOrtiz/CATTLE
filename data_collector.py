"""Training data collector — saves input/output pairs as JSONL + MySQL."""

import json, os, time, threading
from pathlib import Path

_lock = threading.Lock()
_db_conn = None
_db_checked = False


def _training_dir(project_path: str) -> Path:
    d = Path(project_path) / '.kiro-swarm' / 'training_data'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _get_db():
    """Lazy-init MySQL connection from env vars. Returns None if unavailable."""
    global _db_conn, _db_checked
    if _db_checked:
        return _db_conn
    _db_checked = True
    try:
        import pymysql
        from dotenv import load_dotenv
        load_dotenv()
        host = os.getenv('MYSQL_HOST')
        if not host:
            return None
        _db_conn = pymysql.connect(
            host=host,
            port=int(os.getenv('MYSQL_PORT', '3306')),
            database=os.getenv('MYSQL_DB'),
            user=os.getenv('MYSQL_USER'),
            password=os.getenv('MYSQL_PASSWORD'),
            charset='utf8mb4',
            autocommit=True,
        )
        with _db_conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS training_data (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    agent_id VARCHAR(128) NOT NULL,
                    agent_name VARCHAR(128) NOT NULL,
                    input_msg LONGTEXT,
                    output_msg LONGTEXT,
                    signal_kind VARCHAR(32),
                    ts DOUBLE NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
    except Exception as e:
        print(f"[data_collector] MySQL indisponível, usando apenas JSONL: {e}")
        _db_conn = None
    return _db_conn


def collect(project_path: str, agent_id: str, agent_name: str,
            input_msg: str, output_msg: str, signal_kind: str = ''):
    """Append one training sample to JSONL + MySQL."""
    entry = {
        'agent_id': agent_id,
        'agent_name': agent_name,
        'input': input_msg.strip(),
        'output': output_msg.strip(),
        'signal': signal_kind,
        'ts': time.time(),
    }

    # JSONL local (sempre)
    path = _training_dir(project_path) / f'{agent_id}.jsonl'
    line = json.dumps(entry, ensure_ascii=False) + '\n'
    with _lock:
        with open(path, 'a', encoding='utf-8') as f:
            f.write(line)

    # MySQL (se configurado)
    try:
        conn = _get_db()
        if conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO training_data (agent_id, agent_name, input_msg, output_msg, signal_kind, ts) "
                    "VALUES (%s, %s, %s, %s, %s, %s)",
                    (agent_id, agent_name, entry['input'], entry['output'], signal_kind, entry['ts']),
                )
    except Exception as e:
        print(f"[data_collector] Erro ao salvar no MySQL: {e}")
