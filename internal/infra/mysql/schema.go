package mysql

import (
	"database/sql"
	"fmt"

	_ "github.com/go-sql-driver/mysql"
)

func Connect(dsn string) (*sql.DB, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(10)
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("mysql ping: %w", err)
	}
	return db, nil
}

func Migrate(db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS messages (
			id BIGINT AUTO_INCREMENT PRIMARY KEY,
			project VARCHAR(255) NOT NULL,
			agent VARCHAR(255) NOT NULL,
			session_id VARCHAR(255) NOT NULL,
			role ENUM('user','assistant') NOT NULL,
			content TEXT NOT NULL,
			embedding BLOB,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			FULLTEXT idx_content (content),
			INDEX idx_project (project),
			INDEX idx_session (session_id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

		`CREATE TABLE IF NOT EXISTS kb_chunks (
			id BIGINT AUTO_INCREMENT PRIMARY KEY,
			project VARCHAR(255) NOT NULL,
			source_file VARCHAR(512) NOT NULL,
			chunk_index INT NOT NULL,
			content TEXT NOT NULL,
			embedding BLOB,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			FULLTEXT idx_content (content),
			INDEX idx_project (project),
			INDEX idx_source (project, source_file)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

		`CREATE TABLE IF NOT EXISTS summaries (
			id BIGINT AUTO_INCREMENT PRIMARY KEY,
			project VARCHAR(255) NOT NULL,
			agent VARCHAR(255) NOT NULL,
			session_id VARCHAR(255) NOT NULL,
			content TEXT NOT NULL,
			msg_count INT NOT NULL DEFAULT 0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			INDEX idx_session (project, session_id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
	}
	return nil
}
