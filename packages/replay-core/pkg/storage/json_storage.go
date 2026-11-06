package storage

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"os"
	"path/filepath"

	"aerograph.dev/replay-core/pkg/core"
)

const (
	baseDir = ".agent-replay"
	runsDir = "runs"
)

// Storage defines the interface for storing and retrieving agent runs.
type Storage interface {
	SaveRun(run *core.Run) error
	LoadRun(runID string) (*core.Run, error)
	GetNextRunID() (string, error)
	AppendStep(runID string, step core.Step) error
}

// JSONStorage implements the Storage interface using file-based JSON.
type JSONStorage struct {
	basePath string
}

// NewJSONStorage creates a new JSONStorage instance.
func NewJSONStorage(basePath string) (*JSONStorage, error) {
	fullPath := filepath.Join(basePath, baseDir, runsDir)
	if err := os.MkdirAll(fullPath, 0755); err != nil {
		return nil, fmt.Errorf("failed to create runs directory: %w", err)
	}
	return &JSONStorage{basePath: basePath}, nil
}

func (s *JSONStorage) getRunFilePath(runID string) string {
	return filepath.Join(s.basePath, baseDir, runsDir, fmt.Sprintf("%s.json", runID))
}

// SaveRun saves an agent run to a JSON file.
func (s *JSONStorage) SaveRun(run *core.Run) error {
	filePath := s.getRunFilePath(run.RunID)
	data, err := json.MarshalIndent(run, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal run to JSON: %w", err)
	}

	if err := ioutil.WriteFile(filePath, data, 0644); err != nil {
		return fmt.Errorf("failed to write run to file %s: %w", filePath, err)
	}
	return nil
}

// LoadRun loads an agent run from a JSON file.
func (s *JSONStorage) LoadRun(runID string) (*core.Run, error) {
	filePath := s.getRunFilePath(runID)
	data, err := ioutil.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("run with ID '%s' not found", runID)
		}
		return nil, fmt.Errorf("failed to read run file %s: %w", filePath, err)
	}

	var run core.Run
	if err := json.Unmarshal(data, &run); err != nil {
		return nil, fmt.Errorf("failed to unmarshal run from JSON: %w", err)
	}
	return &run, nil
}

// AppendStep adds a single step to an existing run file.
func (s *JSONStorage) AppendStep(runID string, step core.Step) error {
	run, err := s.LoadRun(runID)
	if err != nil {
		// If run doesn't exist, create a new one
		run = &core.Run{
			RunID: runID,
			Steps: []core.Step{},
		}
	}

	run.Steps = append(run.Steps, step)
	return s.SaveRun(run)
}

// GetNextRunID generates the next available run ID.
func (s *JSONStorage) GetNextRunID() (string, error) {
	runsPath := filepath.Join(s.basePath, baseDir, runsDir)
	files, err := ioutil.ReadDir(runsPath)
	if err != nil {
		return "", fmt.Errorf("failed to read runs directory: %w", err)
	}

	maxID := 0
	for _, file := range files {
		if file.IsDir() {
			continue
		}
		var id int
		// Expecting format like "run-001.json"
		_, err := fmt.Sscanf(file.Name(), "run-%d.json", &id)
		if err == nil && id > maxID {
			maxID = id
		}
	}
	return fmt.Sprintf("run-%03d", maxID+1), nil
}

