package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Remove aerograph-replay-core data directories",
	Long: `Removes the local data directories created by aerograph-replay-core.

This removes:
  .agent-replay/  — native cassette storage (runs/ and any legacy ca/ directory)
  .aerograph/cassettes/  — AeroGraph cassette copies

SECURITY NOTE: This command does NOT need to remove CA keys because the ephemeral
CA is wiped automatically after each record/replay session (FR-037). If you see
a persistent .agent-replay/ca/ directory, it was created by an older version of
aerorepl and this command will remove it.

The binary itself must be removed manually (e.g. rm $(which aerograph-replay-core)).`,
	Run: func(cmd *cobra.Command, args []string) {
		dryRun, _ := cmd.Flags().GetBool("dry-run")

		dirsToRemove := []string{
			filepath.Join(".", ".agent-replay"),
			filepath.Join(".", ".aerograph", "cassettes"),
		}

		fmt.Println("\033[36m[UNINSTALL] aerograph-replay-core data cleanup\033[0m")
		if dryRun {
			fmt.Println("\033[33m[UNINSTALL] DRY RUN — no files will be removed\033[0m")
		}

		anyRemoved := false
		for _, dir := range dirsToRemove {
			absDir, err := filepath.Abs(dir)
			if err != nil {
				fmt.Fprintf(os.Stderr, "\033[31m[UNINSTALL] Failed to resolve path %s: %v\033[0m\n", dir, err)
				continue
			}

			if _, err := os.Stat(absDir); os.IsNotExist(err) {
				fmt.Printf("  skip (not found): %s\n", absDir)
				continue
			}

			if dryRun {
				fmt.Printf("  would remove: %s\n", absDir)
				anyRemoved = true
				continue
			}

			if err := os.RemoveAll(absDir); err != nil {
				fmt.Fprintf(os.Stderr, "\033[31m[UNINSTALL] Failed to remove %s: %v\033[0m\n", absDir, err)
				continue
			}

			fmt.Printf("  removed: %s\n", absDir)
			anyRemoved = true
		}

		// Explicitly check for and remove any legacy persistent CA (security hygiene)
		legacyCA := filepath.Join(".", ".agent-replay", "ca")
		if absCA, err := filepath.Abs(legacyCA); err == nil {
			if _, statErr := os.Stat(absCA); statErr == nil {
				if dryRun {
					fmt.Printf("  would remove legacy CA: %s\n", absCA)
				} else {
					if removeErr := os.RemoveAll(absCA); removeErr != nil {
						fmt.Fprintf(os.Stderr, "\033[31m[UNINSTALL] Warning: failed to remove legacy CA dir %s: %v\033[0m\n", absCA, removeErr)
					} else {
						fmt.Printf("  removed legacy CA: %s\n", absCA)
					}
				}
				anyRemoved = true
			}
		}

		if !anyRemoved {
			fmt.Println("\033[32m[UNINSTALL] Nothing to remove.\033[0m")
			return
		}

		if dryRun {
			fmt.Println("\033[33m[UNINSTALL] Dry run complete. Use --dry-run=false to actually remove.\033[0m")
		} else {
			fmt.Println("\033[32m[UNINSTALL] Complete. To remove the binary: rm $(which aerograph-replay-core)\033[0m")
		}
	},
}

func init() {
	uninstallCmd.Flags().Bool("dry-run", false, "Show what would be removed without removing")
	rootCmd.AddCommand(uninstallCmd)
}
