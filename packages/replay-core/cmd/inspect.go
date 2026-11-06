package cmd

import (
	"fmt"
	"os"
	"text/tabwriter"

	"aerograph.dev/replay-core/pkg/storage"

	"github.com/spf13/cobra"
)

var inspectCmd = &cobra.Command{
	Use:   "inspect <run-id>",
	Short: "Show detailed metadata for a specific run",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		runID := args[0]

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

		fmt.Printf("\033[1mRun Inspection: %s\033[0m\n", runID)
		fmt.Println("-------------------------------------------")
		
		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintf(w, "Run ID:\t%s\n", run.RunID)
		fmt.Fprintf(w, "Total Steps:\t%d\n", len(run.Steps))
		
		// Try to find in DB for more metadata
		db, err := storage.NewDB(".")
		if err == nil {
			defer db.Close()
			runs, _ := db.ListRuns()
			for _, r := range runs {
				if r.RunID == runID {
					fmt.Fprintf(w, "Command:\t%s\n", r.Command)
					fmt.Fprintf(w, "Created:\t%s\n", r.CreatedAt.Format("2006-01-02 15:04:05"))
					fmt.Fprintf(w, "Status:\t%s\n", r.Status)
					break
				}
			}
		}
		w.Flush()

		fmt.Println("\n\033[1mStep Overview:\033[0m")
		stepWriter := tabwriter.NewWriter(os.Stdout, 0, 0, 3, ' ', 0)
		fmt.Fprintln(stepWriter, "STEP\tTYPE\tDETAILS")
		for i, step := range run.Steps {
			details := ""
			switch step.Type {
			case "http":
				details = fmt.Sprintf("%s %s", step.Request.Method, truncate(step.Request.URL))
			case "llm":
				details = fmt.Sprintf("Model: %s", step.LLMInput.Model)
			}
			fmt.Fprintf(stepWriter, "%d\t%s\t%s\n", i, step.Type, details)
		}
		stepWriter.Flush()
	},
}

func init() {
	rootCmd.AddCommand(inspectCmd)
}

