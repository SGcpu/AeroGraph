package cmd

import (
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"aerograph.dev/replay-core/pkg/core"
	"aerograph.dev/replay-core/pkg/interceptor"
	"aerograph.dev/replay-core/pkg/proxy"
	"aerograph.dev/replay-core/pkg/storage"

	"github.com/spf13/cobra"
)

var recordCmd = &cobra.Command{
	Use:   "record <command> [args...]",
	Short: "Records an agent's execution",
	Long: `The record command executes a user-provided command, intercepting and recording
LLM calls and HTTP requests/responses. The execution trace is stored locally.

SECURITY: An ephemeral MITM CA is created for this session and wiped on exit.
No CA key material persists after the process ends (FR-037).`,
	Args: cobra.MinimumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Record command called")

		// Initialize storage
		s, err := storage.NewJSONStorage(".")
		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError initializing storage: %v\033[0m\n", err)
			os.Exit(1)
		}

		runID := os.Getenv("AFR_RUN_ID")
		if runID == "" {
			runID = os.Getenv("AEROREPL_RUN_ID")
		}
		if flagRunID, _ := cmd.Flags().GetString("run-id"); flagRunID != "" {
			runID = flagRunID
		}
		if runID == "" {
			var err error
			runID, err = s.GetNextRunID()
			if err != nil {
				fmt.Fprintf(os.Stderr, "\033[31mError getting next run ID: %v\033[0m\n", err)
				os.Exit(1)
			}
		}

		currentRun := &core.Run{
			RunID: runID,
			Steps: []core.Step{},
		}

		// FR-037: Create ephemeral CA — wiped by Cleanup() below.
		// CA material NEVER written to .agent-replay/ca/ or any persistent path.
		caManager, err := proxy.NewCAManager()
		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError creating ephemeral CA: %v\033[0m\n", err)
			os.Exit(1)
		}

		// T017: Deferred cleanup — runs on normal exit
		defer caManager.Cleanup()

		// T018: SIGINT / SIGTERM trap — guarantees CA cleanup on interrupt
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
		go func() {
			sig := <-sigCh
			fmt.Printf("\n\033[33m[RECORD] Received signal %v — cleaning up CA and exiting\033[0m\n", sig)
			caManager.Cleanup()
			os.Exit(1)
		}()

		// Start HTTP Proxy
		rand.Seed(time.Now().UnixNano()) //nolint:staticcheck — acceptable for port selection
		proxyPort := 8000 + rand.Intn(1000)
		proxyAddr := "127.0.0.1:" + strconv.Itoa(proxyPort)

		httpInterceptor := interceptor.NewHTTPInterceptor(interceptor.ModeRecord, s, currentRun)

		// Apply prompt/span override file if provided
		if overrideFilePath, _ := cmd.Flags().GetString("override-file"); overrideFilePath != "" {
			if err := httpInterceptor.LoadOverrideFile(overrideFilePath); err != nil {
				fmt.Fprintf(os.Stderr, "\033[33m[RECORD] Warning: failed to load override file '%s': %v\033[0m\n", overrideFilePath, err)
			} else {
				fmt.Printf("\033[36m[RECORD] Loaded override file: %s\033[0m\n", overrideFilePath)
			}
		}

		httpProxy := proxy.NewHTTPProxy(proxyAddr, httpInterceptor, caManager)

		httpProxy.Start()
		defer func() {
			if err := httpProxy.Stop(); err != nil {
				fmt.Fprintf(os.Stderr, "\033[31mError stopping HTTP proxy: %v\033[0m\n", err)
			}
		}()

		time.Sleep(100 * time.Millisecond)

		commandToExecute := args[0]
		commandArgs := args[1:]

		fmt.Printf("\033[36m[RECORD] Executing command: %s %v\033[0m\n", commandToExecute, commandArgs)

		execCmd := exec.Command(commandToExecute, commandArgs...)
		execCmd.Stdout = os.Stdout
		execCmd.Stderr = os.Stderr
		execCmd.Stdin = os.Stdin

		cleanEnv := make([]string, 0, len(os.Environ()))
		for _, e := range os.Environ() {
			k := strings.ToUpper(strings.SplitN(e, "=", 2)[0])
			switch k {
			case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
				"SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
				"AEROREPL_MODE", "AEROREPL_RUN_ID", "AFR_RUN_ID":
				continue
			default:
				cleanEnv = append(cleanEnv, e)
			}
		}
		execCmd.Env = cleanEnv
		proxyURL := "http://" + proxyAddr
		execCmd.Env = append(execCmd.Env, "HTTP_PROXY="+proxyURL)
		execCmd.Env = append(execCmd.Env, "HTTPS_PROXY="+proxyURL)
		execCmd.Env = append(execCmd.Env, "http_proxy="+proxyURL)
		execCmd.Env = append(execCmd.Env, "https_proxy="+proxyURL)
		execCmd.Env = append(execCmd.Env, "ALL_PROXY="+proxyURL)
		execCmd.Env = append(execCmd.Env, "all_proxy="+proxyURL)
		execCmd.Env = append(execCmd.Env, "NO_PROXY=localhost,127.0.0.1")
		execCmd.Env = append(execCmd.Env, "no_proxy=localhost,127.0.0.1")

		// Use the ephemeral CA cert path (not a persistent .agent-replay/ca path)
		caPath := caManager.CertPath()
		execCmd.Env = append(execCmd.Env, "SSL_CERT_FILE="+caPath)
		execCmd.Env = append(execCmd.Env, "REQUESTS_CA_BUNDLE="+caPath)
		execCmd.Env = append(execCmd.Env, "NODE_EXTRA_CA_CERTS="+caPath)

		execCmd.Env = append(execCmd.Env, "PYTHONIOENCODING=utf-8")
		execCmd.Env = append(execCmd.Env, "PYTHONUTF8=1")
		execCmd.Env = append(execCmd.Env, "AEROREPL_MODE=record")
		execCmd.Env = append(execCmd.Env, "AEROREPL_RUN_ID="+runID)
		execCmd.Env = append(execCmd.Env, "AFR_RUN_ID="+runID)

		err = execCmd.Run()

		// Reload the run from storage
		finalRun, loadErr := s.LoadRun(runID)
		if loadErr != nil {
			finalRun = currentRun
		}

		// Update SQLite index with metadata
		if db, dbErr := storage.NewDB("."); dbErr == nil {
			defer db.Close()
			status := "completed"
			commandExecuted := commandToExecute + " " + strings.Join(commandArgs, " ")
			if err != nil {
				status = "failed"
			}
			db.SaveMetadata(&storage.RunMetadata{
				RunID:      runID,
				Command:    commandExecuted,
				CreatedAt:  time.Now(),
				TotalSteps: len(finalRun.Steps),
				Status:     status,
			})
		}

		// Write annotation log if --annotation-log flag is set
		if annotationLogPath, _ := cmd.Flags().GetString("annotation-log"); annotationLogPath != "" {
			logData := httpInterceptor.WriteAnnotationLog()
			if writeErr := os.WriteFile(annotationLogPath, logData, 0644); writeErr != nil {
				fmt.Fprintf(os.Stderr, "\033[33m[RECORD] Warning: failed to write annotation log: %v\033[0m\n", writeErr)
			} else {
				fmt.Printf("\033[36m[RECORD] Annotation log written to %s\033[0m\n", annotationLogPath)
			}
		}

		// Write cassette copy for AeroGraph (in addition to native .agent-replay/runs/)
		cassetteDir := filepath.Join(".aerograph", "cassettes")
		if mkErr := os.MkdirAll(cassetteDir, 0755); mkErr == nil {
			cassettePath := filepath.Join(cassetteDir, runID+".json")
			if cassetteData, marshalErr := encodeCassette(finalRun); marshalErr == nil {
				os.WriteFile(cassettePath, cassetteData, 0644) //nolint:errcheck
				fmt.Printf("\033[36m[RECORD] Cassette copied to %s\033[0m\n", cassettePath)
			}
		}

		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError executing command: %v\033[0m\n", err)
			os.Exit(1)
		}

		fmt.Printf("\033[32m[RECORD] Recorded run with ID: %s. Total steps: %d\033[0m\n", runID, len(finalRun.Steps))
	},
}

func init() {
	recordCmd.Flags().SetInterspersed(false)
	recordCmd.Flags().String("run-id", "", "Specify custom run ID for correlation with orchestrator")
	recordCmd.Flags().String("annotation-log", "", "Path to write per-request annotation log (JSON array)")
	recordCmd.Flags().String("override-file", "", "Path to JSON file containing prompt/span overrides")
	rootCmd.AddCommand(recordCmd)
}
