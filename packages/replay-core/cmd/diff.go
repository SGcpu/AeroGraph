package cmd

import (
	"bytes"
	"fmt"
	"os"
	"reflect"

	"aerograph.dev/replay-core/pkg/core"
	"aerograph.dev/replay-core/pkg/storage"

	"github.com/spf13/cobra"
)

var verbose bool

var noiseHeaders = map[string]bool{
	"Date":                true,
	"X-Request-Id":        true,
	"X-Timer":             true,
	"Age":                 true,
	"Via":                 true,
	"Server":              true,
	"Connection":          true,
	"Transfer-Encoding":   true,
	"X-Fastly-Request-Id": true,
	"X-Github-Request-Id": true,
	"X-Served-By":         true,
	"X-Cache":             true,
	"X-Cache-Hits":        true,
}

var annotations = map[string]string{
	"Location": "Redirect target changed",
	"X-Cache":  "CDN Cache state changed (HIT/MISS)",
}

var diffCmd = &cobra.Command{
	Use:   "diff <run-id-1> <run-id-2>",
	Short: "Compares two agent runs and shows differences",
	Long:  `The diff command compares two recorded agent executions, highlighting differences in steps, status codes, and responses.`,
	Args:  cobra.ExactArgs(2),
	Run: func(cmd *cobra.Command, args []string) {
		runID1 := args[0]
		runID2 := args[1]

		s, err := storage.NewJSONStorage(".")
		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError: %v\033[0m\n", err)
			os.Exit(1)
		}

		run1, err := s.LoadRun(runID1)
		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError loading %s: %v\033[0m\n", runID1, err)
			os.Exit(1)
		}

		run2, err := s.LoadRun(runID2)
		if err != nil {
			fmt.Fprintf(os.Stderr, "\033[31mError loading %s: %v\033[0m\n", runID2, err)
			os.Exit(1)
		}

		fmt.Printf("\033[36mComparing %s and %s\033[0m\n\n", runID1, runID2)

		diffFound := false
		stats := struct {
			StepsChanged   int
			StatusChanges  int
			BodyChanges    int
			HeaderDiffs    int
			FilteredNoise int
			StepsAdded     int
			StepsRemoved   int
		}{}

		matchedIndices2 := make(map[int]bool)

		// Iterate through Run 1 and find matches in Run 2
		for i, s1 := range run1.Steps {
			foundMatch := false
			for j, s2 := range run2.Steps {
				if matchedIndices2[j] {
					continue
				}

				// Basic matching by type and URL/Model
				if s1.Type == s2.Type && stepSummary(s1) == stepSummary(s2) {
					matchedIndices2[j] = true
					foundMatch = true

					// Perform deep diff
					switch s1.Type {
					case core.StepTypeHTTP:
						changed, statusChanged, bodyChanged, hDiff, hNoise := diffHTTP(i, s1, s2)
						if changed {
							diffFound = true
							stats.StepsChanged++
							if statusChanged {
								stats.StatusChanges++
							}
							if bodyChanged {
								stats.BodyChanges++
							}
							stats.HeaderDiffs += hDiff
							stats.FilteredNoise += hNoise
						}
					case core.StepTypeLLM:
						if diffLLM(i, s1, s2) {
							diffFound = true
							stats.StepsChanged++
						}
					}
					break
				}
			}

			if !foundMatch {
				fmt.Printf("\033[31m[- STEP %d] (Removed from %s): %s\033[0m\n", i, runID1, stepSummary(s1))
				diffFound = true
				stats.StepsRemoved++
			}
		}

		// Find additions (steps in Run 2 that weren't matched)
		for j, s2 := range run2.Steps {
			if !matchedIndices2[j] {
				fmt.Printf("\033[32m[+ STEP %d] (Added in %s): %s\033[0m\n", j, runID2, stepSummary(s2))
				diffFound = true
				stats.StepsAdded++
			}
		}

		if !diffFound {
			if stats.FilteredNoise > 0 {
				fmt.Printf("\n\033[32m✓ No meaningful differences found (all changes filtered as non-deterministic).\033[0m\n")
				fmt.Printf("\033[90m(%d noise headers ignored)\033[0m\n", stats.FilteredNoise)
			} else {
				fmt.Println("\n\033[32m✓ No differences found between runs.\033[0m")
			}
		} else {
			fmt.Printf("\n\033[1m[SUMMARY]\033[0m\n")
			if stats.StepsRemoved > 0 {
				fmt.Printf("%d step(s) removed\n", stats.StepsRemoved)
			}
			if stats.StepsAdded > 0 {
				fmt.Printf("%d step(s) added\n", stats.StepsAdded)
			}
			fmt.Printf("%d step(s) modified\n", stats.StepsChanged)
			fmt.Printf("%d status change(s)\n", stats.StatusChanges)
			fmt.Printf("%d body change(s)\n", stats.BodyChanges)
			fmt.Printf("%d header difference(s) (filtered: %d noise)\n", stats.HeaderDiffs, stats.FilteredNoise)
		}
	},
}

func stepSummary(s core.Step) string {
	switch s.Type {
	case core.StepTypeHTTP:
		return fmt.Sprintf("HTTP %s %s", s.Request.Method, s.Request.URL)
	case core.StepTypeLLM:
		return fmt.Sprintf("LLM %s", s.LLMInput.Model)
	default:
		return string(s.Type)
	}
}

func diffHTTP(idx int, s1, s2 core.Step) (changed, statusChanged, bodyChanged bool, hDiff, hNoise int) {
	headerPrinted := false
	printHeader := func() {
		if !headerPrinted {
			fmt.Printf("\n\033[33m[Δ STEP %d] HTTP %s %s\033[0m\n", idx, s1.Request.Method, s1.Request.URL)
			headerPrinted = true
		}
	}

	if s1.Request.URL != s2.Request.URL {
		printHeader()
		fmt.Printf("  URL: \033[31m%s\033[0m -> \033[32m%s\033[0m\n", s1.Request.URL, s2.Request.URL)
		changed = true
	}

	if s1.Response.StatusCode != s2.Response.StatusCode {
		printHeader()
		fmt.Printf("  Status: \033[31m%d\033[0m -> \033[32m%d\033[0m\n", s1.Response.StatusCode, s2.Response.StatusCode)
		changed = true
		statusChanged = true
	}

	// Compare Headers
	// Collect all keys
	allKeys := make(map[string]bool)
	for k := range s1.Response.Headers {
		allKeys[k] = true
	}
	for k := range s2.Response.Headers {
		allKeys[k] = true
	}

	for k := range allKeys {
		v1, ok1 := s1.Response.Headers[k]
		v2, ok2 := s2.Response.Headers[k]

		isNoise := noiseHeaders[k]

		if ok1 && ok2 {
			if !reflect.DeepEqual(v1, v2) {
				if isNoise && !verbose {
					hNoise++
				} else {
					printHeader()
					hint := ""
					if msg, ok := annotations[k]; ok {
						hint = fmt.Sprintf(" \033[90m(%s)\033[0m", msg)
					}
					fmt.Printf("  Header %s: \033[31m%v\033[0m -> \033[32m%v\033[0m%s\n", k, v1, v2, hint)
					changed = true
					hDiff++
				}
			}
		} else if ok1 {
			if isNoise && !verbose {
				hNoise++
			} else {
				printHeader()
				hint := ""
				if msg, ok := annotations[k]; ok {
					hint = fmt.Sprintf(" \033[90m(%s)\033[0m", msg)
				}
				fmt.Printf("  Header %s: \033[31m%v\033[0m -> \033[32m(missing)\033[0m%s\n", k, v1, hint)
				changed = true
				hDiff++
			}
		} else if ok2 {
			if isNoise && !verbose {
				hNoise++
			} else {
				printHeader()
				hint := ""
				if msg, ok := annotations[k]; ok {
					hint = fmt.Sprintf(" \033[90m(%s)\033[0m", msg)
				}
				fmt.Printf("  Header %s: \033[31m(missing)\033[0m -> \033[32m%v\033[0m%s\n", k, v2, hint)
				changed = true
				hDiff++
			}
		}
	}

	if !bytes.Equal(s1.Response.Body, s2.Response.Body) {
		printHeader()
		fmt.Printf("  Body Differs:\n")
		fmt.Printf("    \033[31m- %s\033[0m\n", truncate(string(s1.Response.Body)))
		fmt.Printf("    \033[32m+ %s\033[0m\n", truncate(string(s2.Response.Body)))
		changed = true
		bodyChanged = true
	}
	return
}

func diffLLM(idx int, s1, s2 core.Step) bool {
	diffFound := false
	headerPrinted := false
	printHeader := func() {
		if !headerPrinted {
			fmt.Printf("\n\033[33m[Δ STEP %d] LLM %s\033[0m\n", idx, s1.LLMInput.Model)
			headerPrinted = true
		}
	}

	if s1.LLMInput.Model != s2.LLMInput.Model {
		printHeader()
		fmt.Printf("  Model: \033[31m%s\033[0m -> \033[32m%s\033[0m\n", s1.LLMInput.Model, s2.LLMInput.Model)
		diffFound = true
	}

	// Compare responses
	r1 := ""
	r2 := ""
	if len(s1.LLMOutput.Response.Candidates) > 0 && len(s1.LLMOutput.Response.Candidates[0].Content.Parts) > 0 {
		r1 = s1.LLMOutput.Response.Candidates[0].Content.Parts[0].Text
	}
	if len(s2.LLMOutput.Response.Candidates) > 0 && len(s2.LLMOutput.Response.Candidates[0].Content.Parts) > 0 {
		r2 = s2.LLMOutput.Response.Candidates[0].Content.Parts[0].Text
	}

	if r1 != r2 {
		printHeader()
		fmt.Printf("  Response: \033[31m%s\033[0m -> \033[32m%s\033[0m\n", truncate(r1), truncate(r2))
		diffFound = true
	}
	return diffFound
}

func truncate(s string) string {
	if len(s) > 50 {
		return s[:47] + "..."
	}
	return s
}

func init() {
	diffCmd.Flags().BoolVarP(&verbose, "verbose", "v", false, "Show all differences including noise headers")
	rootCmd.AddCommand(diffCmd)
}

