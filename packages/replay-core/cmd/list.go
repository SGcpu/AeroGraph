package cmd

import (
	"fmt"
	"os"
	"text/tabwriter"

	"aerograph.dev/replay-core/pkg/storage"

	"github.com/spf13/cobra"
)

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "Lists all recorded agent runs",
	Long:  `The list command displays a table of all recorded agent executions stored in the local index.`,
	Run: func(cmd *cobra.Command, args []string) {
		db, err := storage.NewDB(".")
		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError opening index: %v\033[0m\n", err)
			os.Exit(1)
		}
		defer db.Close()

		runs, err := db.ListRuns()
		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError listing runs: %v\033[0m\n", err)
			os.Exit(1)
		}

		if len(runs) == 0 {
			fmt.Println("No runs recorded yet.")
			return
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 3, ' ', 0)
		fmt.Fprintln(w, "RUN ID\tCOMMAND\tCREATED\tSTEPS\tSTATUS")
		for _, r := range runs {
			fmt.Fprintf(w, "%s\t%s\t%s\t%d\t%s\n", 
				r.RunID, 
				truncate(r.Command), 
				r.CreatedAt.Format("2006-01-02 15:04"), 
				r.TotalSteps, 
				r.Status,
			)
		}
		w.Flush()
	},
}

func init() {
	rootCmd.AddCommand(listCmd)
}

