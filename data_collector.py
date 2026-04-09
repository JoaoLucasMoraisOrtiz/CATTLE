"""Training data collector — saves input/output pairs to remote MySQL."""

import os, time, threading

_lock = threading.Lock()
_db_conn = None
_db_checked = False


def _get_db():
    """Lazy-init MySQL connection from env vars. Reconnects if dead."""
    global _db_conn, _db_checked
    with _lock:
        if _db_conn:
            try:
                _db_conn.ping(reconnect=True)
                return _db_conn
            except Exception:
                _db_conn = None
        if _db_checked and not _db_conn:
            return None
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
            _init_schema(_db_conn)
        except Exception as e:
            print(f"[data_collector] MySQL indisponível: {e}")
            _db_conn = None
        return _db_conn


def _init_schema(conn):
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS training_data (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                project_path VARCHAR(512),
                agent_id VARCHAR(128) NOT NULL,
                agent_name VARCHAR(128) NOT NULL,
                input_msg LONGTEXT,
                output_msg LONGTEXT,
                signal_kind VARCHAR(32),
                flow_id VARCHAR(128),
                round_num INT,
                ts DOUBLE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_agent (agent_id),
                INDEX idx_project (project_path(255)),
                INDEX idx_ts (ts)
            )
        """)


def collect(project_path: str, agent_id: str, agent_name: str,
            input_msg: str, output_msg: str, signal_kind: str = '',
            flow_id: str = '', round_num: int = 0):
    """Insert one training sample into MySQL."""
    def _insert():
        try:
            conn = _get_db()
            if not conn:
                return
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO training_data "
                    "(project_path, agent_id, agent_name, input_msg, output_msg, signal_kind, flow_id, round_num, ts) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (project_path, agent_id, agent_name, input_msg.strip(),
                     output_msg.strip(), signal_kind, flow_id, round_num, time.time()),
                )
        except Exception as e:
            print(f"[data_collector] Erro ao salvar: {e}")
    # Non-blocking insert
    threading.Thread(target=_insert, daemon=True).start()
