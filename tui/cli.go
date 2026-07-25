package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// The TUI never reimplements framework logic. It shells into the same
// `hook-factory --json` commands a scripted user would, which means the two can
// never disagree about what a sync would write.

type Capability struct {
	Event     string `json:"event"`
	Supported bool   `json:"supported"`
	Blocking  bool   `json:"blocking"`
	Native    string `json:"native"`
}

type Agent struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Status       string       `json:"status"`
	Install      string       `json:"install"`
	Docs         string       `json:"docs"`
	Notes        []string     `json:"notes"`
	Blocking     []string     `json:"blocking"`
	Capabilities []Capability `json:"capabilities"`
}

type PluginInfo struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	NeedsOptions bool   `json:"needsOptions"`
	Example      string `json:"example"`
}

type EventInfo struct {
	Name string `json:"name"`
	Doc  string `json:"doc"`
}

type ConfigHook struct {
	ID          string   `json:"id"`
	Event       string   `json:"event"`
	Description string   `json:"description"`
	Plugin      string   `json:"plugin"`
	Enabled     bool     `json:"enabled"`
	Agents      []string `json:"agents"`
}

type ConfigInfo struct {
	Path   string       `json:"path"`
	Scope  string       `json:"scope"`
	Agents []string     `json:"agents"`
	Hooks  []ConfigHook `json:"hooks"`
}

type ListResult struct {
	Agents  []Agent      `json:"agents"`
	Plugins []PluginInfo `json:"plugins"`
	Events  []EventInfo  `json:"events"`
	Config  *ConfigInfo  `json:"config"`
}

type PlannedWrite struct {
	Path    string `json:"path"`
	Changed bool   `json:"changed"`
	Diff    string `json:"diff"`
}

type Snippet struct {
	Path         string `json:"path"`
	Content      string `json:"content"`
	Instructions string `json:"instructions"`
}

type UnsupportedHook struct {
	ID    string `json:"id"`
	Event string `json:"event"`
}

type AgentPlan struct {
	Agent            string            `json:"agent"`
	Name             string            `json:"name"`
	Status           string            `json:"status"`
	Install          string            `json:"install"`
	Writes           []PlannedWrite    `json:"writes"`
	Snippets         []Snippet         `json:"snippets"`
	HookCount        int               `json:"hookCount"`
	UnsupportedHooks []UnsupportedHook `json:"unsupportedHooks"`
	Notes            []string          `json:"notes"`
}

type SyncPlan struct {
	Scope         string      `json:"scope"`
	Runner        string      `json:"runner"`
	Agents        []AgentPlan `json:"agents"`
	UnknownAgents []string    `json:"unknownAgents"`
}

type Finding struct {
	Level   string `json:"level"`
	Message string `json:"message"`
	Fix     string `json:"fix"`
}

type DoctorAgent struct {
	Agent     string   `json:"agent"`
	Name      string   `json:"name"`
	Status    string   `json:"status"`
	Installed bool     `json:"installed"`
	Detected  bool     `json:"detected"`
	HookCount int      `json:"hookCount"`
	Issues    []string `json:"issues"`
}

type DoctorResult struct {
	Findings []Finding     `json:"findings"`
	Agents   []DoctorAgent `json:"agents"`
}

type TestRan struct {
	ID    string `json:"id"`
	Ms    int    `json:"ms"`
	Error string `json:"error"`
}

type TestDecision struct {
	Kind    string `json:"kind"`
	Reason  string `json:"reason"`
	Text    string `json:"text"`
	Message string `json:"message"`
}

type TestAgentResult struct {
	Agent    string        `json:"agent"`
	Skipped  bool          `json:"skipped"`
	Reason   string        `json:"reason"`
	Decision *TestDecision `json:"decision"`
	CanBlock bool          `json:"canBlock"`
	ExitCode int           `json:"exitCode"`
	Ran      []TestRan     `json:"ran"`
}

type TestResult struct {
	Event   string            `json:"event"`
	Results []TestAgentResult `json:"results"`
}

// runCLI invokes the Node CLI and decodes its JSON output.
func runCLI(out any, args ...string) error {
	bin := os.Getenv("HOOK_FACTORY_CLI")
	if bin == "" {
		bin = "npx hook-factory"
	}
	parts := strings.Fields(bin)
	full := append(append([]string{}, parts[1:]...), args...)
	full = append(full, "--json")

	cmd := exec.Command(parts[0], full...)
	if cwd := os.Getenv("HOOK_FACTORY_CWD"); cwd != "" {
		cmd.Dir = cwd
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr

	stdout, err := cmd.Output()
	if err != nil && len(stdout) == 0 {
		return fmt.Errorf("%s: %s", strings.Join(full, " "), strings.TrimSpace(stderr.String()))
	}
	// Some commands exit non-zero by design (doctor with errors) but still
	// produce valid JSON, so we decode before treating err as fatal.
	if jsonErr := json.Unmarshal(stdout, out); jsonErr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = string(stdout)
		}
		return fmt.Errorf("could not parse output of `%s`: %s", strings.Join(full, " "), truncate(msg, 300))
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func fetchList() (ListResult, error) {
	var r ListResult
	err := runCLI(&r, "list")
	return r, err
}

func fetchPlan(dryRun bool) (SyncPlan, error) {
	var r SyncPlan
	args := []string{"sync"}
	if dryRun {
		args = append(args, "--dry-run")
	}
	err := runCLI(&r, args...)
	return r, err
}

func fetchDoctor() (DoctorResult, error) {
	var r DoctorResult
	err := runCLI(&r, "doctor")
	return r, err
}

func runTest(event, tool, command string) (TestResult, error) {
	var r TestResult
	args := []string{"test", event}
	if tool != "" {
		args = append(args, "--tool", tool)
	}
	if command != "" {
		args = append(args, "--command", command)
	}
	err := runCLI(&r, args...)
	return r, err
}

func addPlugin(name string) error {
	bin := os.Getenv("HOOK_FACTORY_CLI")
	if bin == "" {
		bin = "npx hook-factory"
	}
	parts := strings.Fields(bin)
	full := append(append([]string{}, parts[1:]...), "add", name)
	cmd := exec.Command(parts[0], full...)
	if cwd := os.Getenv("HOOK_FACTORY_CWD"); cwd != "" {
		cmd.Dir = cwd
	}
	return cmd.Run()
}

func removePlugin(name string) error {
	bin := os.Getenv("HOOK_FACTORY_CLI")
	if bin == "" {
		bin = "npx hook-factory"
	}
	parts := strings.Fields(bin)
	full := append(append([]string{}, parts[1:]...), "remove", name)
	cmd := exec.Command(parts[0], full...)
	if cwd := os.Getenv("HOOK_FACTORY_CWD"); cwd != "" {
		cmd.Dir = cwd
	}
	return cmd.Run()
}
