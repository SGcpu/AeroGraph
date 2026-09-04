package storage

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type RunMetadata struct {
	RunID      string
	Command    string
	CreatedAt  time.Time
	TotalSteps int
	Status     string // e.g., "success", "failed"
}

type DB struct {
	conn *sql.DB
}

func NewDB(baseDir string) (*DB, error) {
	dbPath := filepath.Join(baseDir, ".agent-replay", "index.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite db: %w", err)
	}

	// Create schema
	schema := `
	CREATE TABLE IF NOT EXISTS runs (
		run_id TEXT PRIMARY KEY,
		command TEXT,
		created_at DATETIME,
		total_steps INTEGER,
		status TEXT
	);`
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("failed to create schema: %w", err)
	}

	return &DB{conn: db}, nil
}

func (db *DB) SaveMetadata(m *RunMetadata) error {
	query := `INSERT OR REPLACE INTO runs (run_id, command, created_at, total_steps, status) VALUES (?, ?, ?, ?, ?)`
	_, err := db.conn.Exec(query, m.RunID, m.Command, m.CreatedAt, m.TotalSteps, m.Status)
	return err
}

func (db *DB) ListRuns() ([]RunMetadata, error) {
	rows, err := db.conn.Query("SELECT run_id, command, created_at, total_steps, status FROM runs ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var runs []RunMetadata
	for rows.Next() {
		var m RunMetadata
		if err := rows.Scan(&m.RunID, &m.Command, &m.CreatedAt, &m.TotalSteps, &m.Status); err != nil {
			return nil, err
		}
		runs = append(runs, m)
	}
	return runs, nil
}

func (db *DB) Close() error {
	return db.conn.Close()
}
