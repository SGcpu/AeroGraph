package cmd

import (
	"fmt"
	"text/tabwriter"
	"os"

	"github.com/spf13/cobra"
)

var compareCmd = &cobra.Command{
	Use:   "compare",
	Short: "Detailed comparison: aerorepl vs. The Orbit",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("\n\033[1;36maerorepl vs. The Orbit (Detailed Matrix)\033[0m")
		fmt.Println("--------------------------------------")

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 3, ' ', 0)
		fmt.Fprintln(w, "\033[1mFEATURE\tOBSERVABILITY\tMOCKING (VCR)\tAEROREPL\033[0m")
		fmt.Fprintln(w, "Goal\tTrace/Eval\tUnit Testing\tDeterministic Replay")
		fmt.Fprintln(w, "Setup\tSDK/Code changes\tLibrary-specific\tZero-instrumentation")
		fmt.Fprintln(w, "Execution\tPass-through\tStubbed\tFrozen local state")
		fmt.Fprintln(w, "Team Sync\tCloud-first\tManual sharing\tshare → pull")
		fmt.Fprintln(w, "Scope\tLLM Calls\tHTTP only\tLLM + HTTP + System")
		w.Flush()

		fmt.Println("\n\033[1mKey Pivot Points:\033[0m")
		fmt.Println("\033[36m1. vs. LangSmith:\033[0m Observability is a dashboard; aerorepl is a \033[32mdebugger\033[0m.")
		fmt.Println("\033[36m2. vs. VCR.py:\033[0m Mocking is for units; aerorepl is for \033[32magent journeys\033[0m.")
		fmt.Println("\033[36m3. vs. Replay.io:\033[0m Program replay is heavy; aerorepl is \033[32mAPI-semantic replay\033[0m.")

		fmt.Println("\nFor a deep dive, visit: \033[4mhttps://aerograph.dev/compare\033[0m")
	},
}

func init() {
	rootCmd.AddCommand(compareCmd)
}
