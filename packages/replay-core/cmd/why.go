package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var whyCmd = &cobra.Command{
	Use:   "why",
	Short: "Why aerorepl? Positioning vs. the orbit",
	Long:  `Understand the core philosophy of aerorepl and how it differs from observability, tracing, and mocking tools.`,
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("\n\033[1;36maerorepl: Deterministic Execution Replay for AI Agents\033[0m")
		fmt.Println("\033[90m\"Like Git for AI executions.\"\033[0m")

		fmt.Println("\n\033[1mThe Philosophy\033[0m")
		fmt.Println("----------------")
		fmt.Println("Most tools focus on \033[33mObservability\033[0m (watching what happened).")
		fmt.Println("aerorepl focuses on \033[32mDeterminism\033[0m (reproducing exactly what happened).")

		fmt.Println("\n\033[1mThe Orbit\033[0m")
		fmt.Println("----------")
		
		fmt.Printf("\033[36m%-25s\033[0m %-40s\n", "Category", "The aerorepl Edge")
		fmt.Printf("%-25s %-40s\n", "-------------------------", "----------------------------------------")
		
		fmt.Printf("%-25s %-40s\n", "LLM Observability", "Zero-instrumentation. No SDK required.")
		fmt.Printf("%-25s %-40s\n", "(LangSmith, Helicone)", "Works with any CLI tool (curl, Python).")
		
		fmt.Println()
		fmt.Printf("%-25s %-40s\n", "API Mocking", "Multi-step agent awareness.")
		fmt.Printf("%-25s %-40s\n", "(VCR.py, Polly.js)", "Captures LLM semantics + team sharing.")
		
		fmt.Println()
		fmt.Printf("%-25s %-40s\n", "General Debugging", "Purpose-built for the stochastic nature")
		fmt.Printf("%-25s %-40s\n", "(Replay.io)", "of LLM-driven workflows.")

		fmt.Println("\n\033[1mOur Moat\033[0m")
		fmt.Println("--------")
		fmt.Println("1. \033[1mZero-Instrumentation\033[0m: No code changes. Just wrap your command.")
		fmt.Println("2. \033[1mTrue Determinism\033[0m: We serve from the trace, we don't recompute.")
		fmt.Println("3. \033[1mFull System Capture\033[0m: HTTP, APIs, and LLM calls in one unified run.")
		fmt.Println("4. \033[1mPortable Truth\033[0m: share -> pull -> replay. Debug across machines.")

		fmt.Println("\nFor a tool-by-tool matrix, run: \033[1maerorepl compare\033[0m")

		fmt.Println("\n\033[90mStop chasing ghosts. Replay them.\033[0m")
		fmt.Println("\033[4mhttps://aerograph.dev/compare\033[0m")
	},
}

func init() {
	rootCmd.AddCommand(whyCmd)
}
