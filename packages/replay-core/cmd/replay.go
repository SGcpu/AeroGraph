package cmd

import (
	"encoding/json"
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

var fallback bool
var summary bool
var realtimePlayback bool

var replayCmd = &cobra.Command{
	Use:   "replay <run-id> <command> [args...]",
	Short: "Replays a previously recorded agent execution",
	Long: `The replay command re-executes a previously recorded agent run,
returning recorded responses instead of making real calls, ensuring determinism.

SECURITY: An ephemeral MITM CA is created for this session and wiped on exit.
No CA key material persists after the process ends (FR-037).`,
	Args: cobra.MinimumNArgs(2), // run-id + command
	Run: func(cmd *cobra.Command, args []string) {
		runID := args[0]

		// Initialize storage
		s, err := storage.NewJSONStorage(".")
		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError initializing storage: %v\033[0m\n", err)
			os.Exit(1)
		}

		run, err := s.LoadRun(runID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError loading run '%s': %v\033[0m\n", runID, err)
			os.Exit(1)
		}

		// FR-037: Create ephemeral CA — wiped on exit, never persisted
		caManager, err := proxy.NewCAManager()
		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError creating ephemeral CA: %v\033[0m\n", err)
			os.Exit(1)
		}

		// T017: Deferred cleanup on normal exit
		defer caManager.Cleanup()

		// T018: Signal trap for cleanup on interrupt
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
		go func() {
			sig := <-sigCh
			fmt.Printf("\n\033[33m[REPLAY] Received signal %v — cleaning up CA and exiting\033[0m\n", sig)
			caManager.Cleanup()
			os.Exit(1)
		}()

		// Start HTTP Proxy in replay mode
		rand.Seed(time.Now().UnixNano()) //nolint:staticcheck
		proxyPort := 9000 + rand.Intn(1000)
		proxyAddr := "127.0.0.1:" + strconv.Itoa(proxyPort)

		httpInterceptor := interceptor.NewHTTPInterceptor(interceptor.ModeReplay, s, run)
		httpInterceptor.Fallback = fallback
		httpInterceptor.RealtimePlayback = realtimePlayback

		// Apply live-hosts from --live-hosts flag (must_execute patterns)
		if liveHostsStr, _ := cmd.Flags().GetString("live-hosts"); liveHostsStr != "" {
			httpInterceptor.LiveHosts = strings.Split(liveHostsStr, ",")
			for i, h := range httpInterceptor.LiveHosts {
				httpInterceptor.LiveHosts[i] = strings.TrimSpace(h)
			}
		}

		// Apply prompt/span override file if provided
		if overrideFilePath, _ := cmd.Flags().GetString("override-file"); overrideFilePath != "" {
			if err := httpInterceptor.LoadOverrideFile(overrideFilePath); err != nil {
				fmt.Fprintf(os.Stderr, "\033[33m[REPLAY] Warning: failed to load override file '%s': %v\033[0m\n", overrideFilePath, err)
			} else {
				fmt.Printf("\033[36m[REPLAY] Loaded override file: %s\033[0m\n", overrideFilePath)
			}
		}

		modeStr := "STRICT (no network allowed)"
		if fallback {
			modeStr = "FALLBACK ENABLED (real network allowed)"
		}
		if len(httpInterceptor.LiveHosts) > 0 {
			modeStr += fmt.Sprintf(" | live-hosts: %v", httpInterceptor.LiveHosts)
		}
		fmt.Printf("\033[36m[REPLAY] Mode: %s\033[0m\n", modeStr)

		httpProxy := proxy.NewHTTPProxy(proxyAddr, httpInterceptor, caManager)

		httpProxy.Start()
		defer func() {
			if err := httpProxy.Stop(); err != nil {
				fmt.Fprintf(os.Stderr, "\033[31mError stopping HTTP proxy: %v\033[0m\n", err)
			}
		}()

		commandToExecute := args[1]
		commandArgs := args[2:]

		fmt.Printf("\033[32m[REPLAY] Replaying run %s with command: %s %v\033[0m\n",
			runID, commandToExecute, commandArgs)

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

		// Use ephemeral CA cert path (not .agent-replay/ca/)
		caPath := caManager.CertPath()
		execCmd.Env = append(execCmd.Env, "SSL_CERT_FILE="+caPath)
		execCmd.Env = append(execCmd.Env, "REQUESTS_CA_BUNDLE="+caPath)
		execCmd.Env = append(execCmd.Env, "NODE_EXTRA_CA_CERTS="+caPath)

		execCmd.Env = append(execCmd.Env, "PYTHONIOENCODING=utf-8")
		execCmd.Env = append(execCmd.Env, "PYTHONUTF8=1")
		execCmd.Env = append(execCmd.Env, "AEROREPL_MODE=replay")
		execCmd.Env = append(execCmd.Env, "AEROREPL_RUN_ID="+runID)
		execCmd.Env = append(execCmd.Env, "AFR_RUN_ID="+runID)

		runErr := execCmd.Run()

		// Write annotation log if requested
		if annotationLogPath, _ := cmd.Flags().GetString("annotation-log"); annotationLogPath != "" {
			logData := httpInterceptor.WriteAnnotationLog()
			if writeErr := os.WriteFile(annotationLogPath, logData, 0644); writeErr != nil {
				fmt.Fprintf(os.Stderr, "\033[33m[REPLAY] Warning: failed to write annotation log: %v\033[0m\n", writeErr)
			} else {
				fmt.Printf("\033[36m[REPLAY] Annotation log written to %s\033[0m\n", annotationLogPath)
			}
		}

		// If live network steps occurred during replay (override, must_execute, or fallback),
		// export the complete updated run to .aerograph/cassettes/<runID>.json so the fork
		// has its own complete, zero-cost-replayable cassette.
		if httpInterceptor.NetworkCallCount > 0 {
			finalRun, loadErr := s.LoadRun(runID)
			if loadErr != nil {
				finalRun = run
			}
			cassetteDir := filepath.Join(".aerograph", "cassettes")
			if mkErr := os.MkdirAll(cassetteDir, 0755); mkErr == nil {
				cassettePath := filepath.Join(cassetteDir, runID+".json")
				if cassetteData, marshalErr := encodeCassette(finalRun); marshalErr == nil {
					os.WriteFile(cassettePath, cassetteData, 0644) //nolint:errcheck
					fmt.Printf("\033[36m[REPLAY] Saved updated fork cassette with %d steps to %s\033[0m\n", len(finalRun.Steps), cassettePath)
				}
			}
		}

		if summary {
			fmt.Printf("\n\033[32m✓ Replay complete\033[0m\n")
			fmt.Printf("Steps: %d\n", len(run.Steps))
			fmt.Printf("Network calls: %d\n", httpInterceptor.NetworkCallCount)
			deterministic := "yes"
			if httpInterceptor.NetworkCallCount > 0 {
				deterministic = "no (fallback/live-host used)"
			}
			fmt.Printf("Deterministic: %s\n", deterministic)
		} else {
			fmt.Printf("\n\033[32m[SUCCESS] Replay complete.\033[0m\n")
		}

		if runErr != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError executing command during replay: %v\033[0m\n", runErr)
			os.Exit(1)
		}
	},
}

func init() {
	replayCmd.Flags().SetInterspersed(false)
	replayCmd.Flags().BoolVarP(&fallback, "fallback", "f", false, "Hit real network if recorded request is not found")
	replayCmd.Flags().BoolVarP(&summary, "summary", "s", false, "Show concise summary of replay results")
	replayCmd.Flags().BoolVar(&realtimePlayback, "realtime-playback", false, "Reconstruct recorded inter-chunk timing during streaming replay")
	replayCmd.Flags().String("live-hosts", "", "Comma-separated host glob patterns to always forward live (must_execute)")
	replayCmd.Flags().String("annotation-log", "", "Path to write per-request annotation log (JSON array)")
	replayCmd.Flags().String("override-file", "", "Path to JSON file containing prompt/span overrides")
	rootCmd.AddCommand(replayCmd)
}

// encodeCassette marshals a Run to the AeroGraph cassette JSON format.
// This is used by record.go and replay.go to copy the cassette to .aerograph/cassettes/.
func encodeCassette(run *core.Run) ([]byte, error) {
	return json.MarshalIndent(run, "", "  ")
}
