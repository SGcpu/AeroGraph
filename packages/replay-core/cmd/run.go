package cmd

import (
	"fmt"
	"os"
	"strings"

	"aerograph.dev/replay-core/pkg/storage"

	"github.com/spf13/cobra"
)

var runCmd = &cobra.Command{
	Use:   "run <run-id>",
	Short: "Replays a run using its original command",
	Long:  `The run command is a shortcut that loads a run, finds its original command, and executes it in replay mode.`,
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		runID := args[0]

		// 1. Load run to get the original command
		s, err := storage.NewJSONStorage(".")
		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError: %v\033[0m\n", err)
			os.Exit(1)
		}

		run, err := s.LoadRun(runID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError loading run %s: %v\033[0m\n", runID, err)
			os.Exit(1)
		}

		if run.OriginalCommand == "" {
			fmt.Fprintf(os.Stderr, "\033[31mError: No original command found for run %s. Please use 'aerorepl replay' manually.\033[0m\n", runID)
			os.Exit(1)
		}

		fmt.Printf("\033[36m[RUN] Shortcut for: aerorepl replay %s --summary %s\033[0m\n", runID, run.OriginalCommand)

		// 2. Delegate to replay logic
		// We'll split the command string back into args (simple split for now)
		parts := strings.Fields(run.OriginalCommand)
		if len(parts) == 0 {
			fmt.Fprintf(os.Stderr, "\033[31mError: Original command is empty.\033[0m\n")
			os.Exit(1)
		}

		// Update args for replayCmd and set summary flag
		summary = true
		replayArgs := append([]string{runID}, parts...)
		replayCmd.Run(cmd, replayArgs)
	},
}

func init() {
	rootCmd.AddCommand(runCmd)
}

