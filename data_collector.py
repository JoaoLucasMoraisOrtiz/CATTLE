"""Training data collector — saves input/output pairs to remote MySQL."""

import os, time, threading

_lock = threading.Lock()
_db_conn = None
_db_checked = False


def _get_db():
    """Lazy-init MySQL connection from env vars."""
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
        print(f"[data_collector] MySQL indisponível: {e}")
        _db_conn = None
    return _db_conn


def collect(project_path: str, agent_id: str, agent_name: str,
            input_msg: str, output_msg: str, signal_kind: str = ''):
    """Insert one training sample into MySQL."""
    try:
        conn = _get_db()
        if conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO training_data (agent_id, agent_name, input_msg, output_msg, signal_kind, ts) "
                    "VALUES (%s, %s, %s, %s, %s, %s)",
                    (agent_id, agent_name, input_msg.strip(), output_msg.strip(), signal_kind, time.time()),
                )
    except Exception as e:
        print(f"[data_collector] Erro ao salvar no MySQL: {e}")
