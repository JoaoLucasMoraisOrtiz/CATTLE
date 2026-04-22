package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "github.com/mattn/go-sqlite3"
)

func Open() (*sql.DB, error) {
	home, _ := os.UserHomeDir()
	dbPath := filepath.Join(home, ".redo", "redo.db")
	os.MkdirAll(filepath.Dir(dbPath), 0755)

	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL")
	if err != nil {
		return nil, err
	}
	return db, migrate(db)
}

func migrate(db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project TEXT NOT NULL,
			agent TEXT NOT NULL,
			session_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			embedding BLOB,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_msg_project ON messages(project)`,
		`CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id)`,

		`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content_rowid='id')`,

		`CREATE TABLE IF NOT EXISTS kb_chunks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project TEXT NOT NULL,
			source_file TEXT NOT NULL,
			chunk_index INTEGER NOT NULL,
			content TEXT NOT NULL,
			embedding BLOB,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_kb_project ON kb_chunks(project)`,
		`CREATE INDEX IF NOT EXISTS idx_kb_source ON kb_chunks(project, source_file)`,

		`CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(content, content_rowid='id')`,

		`CREATE TABLE IF NOT EXISTS summaries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project TEXT NOT NULL,
			agent TEXT NOT NULL,
			session_id TEXT NOT NULL,
			content TEXT NOT NULL,
			msg_count INTEGER NOT NULL DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sum_session ON summaries(project, session_id)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			fmt.Printf("[Store] migrate error: %v\nSQL: %s\n", err, s[:80])
			return err
		}
	}
	return nil
}
