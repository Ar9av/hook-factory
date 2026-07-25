// hook-factory-tui — the interactive surface for hook-factory.
//
// It is deliberately a thin client: every piece of state comes from
// `hook-factory <cmd> --json`, and every mutation goes back out through the same
// CLI. That keeps the TUI honest (it can't show you a sync that the CLI wouldn't
// perform) and keeps the npm package free of a Go dependency for normal use.
package main

import (
	"fmt"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/lipgloss"
)

type tab int

const (
	tabAgents tab = iota
	tabPlugins
	tabSync
	tabDoctor
	tabPlayground
)

var tabNames = []string{"Agents", "Plugins", "Sync", "Doctor", "Playground"}

type model struct {
	width, height int
	tab           tab
	spin          spinner.Model
	loading       bool
	err           error
	status        string

	list   ListResult
	plan   SyncPlan
	doctor DoctorResult
	test   TestResult

	agentCursor  int
	pluginCursor int
	syncCursor   int
	doctorCursor int

	// Playground state
	playEvent   int
	playCommand string
	playEditing bool

	confirming string
}

// --- messages --------------------------------------------------------------

type listMsg struct {
	res ListResult
	err error
}
type planMsg struct {
	res SyncPlan
	err error
}
type doctorMsg struct {
	res DoctorResult
	err error
}
type testMsg struct {
	res TestResult
	err error
}
type actionMsg struct {
	status string
	err    error
}

func loadList() tea.Cmd {
	return func() tea.Msg {
		r, err := fetchList()
		return listMsg{r, err}
	}
}
func loadPlan() tea.Cmd {
	return func() tea.Msg {
		r, err := fetchPlan(true)
		return planMsg{r, err}
	}
}
func loadDoctor() tea.Cmd {
	return func() tea.Msg {
		r, err := fetchDoctor()
		return doctorMsg{r, err}
	}
}
func doApply() tea.Cmd {
	return func() tea.Msg {
		_, err := fetchPlan(false)
		if err != nil {
			return actionMsg{"", err}
		}
		return actionMsg{"synced — every configured agent now has your hooks", nil}
	}
}
func doTest(event, command string) tea.Cmd {
	return func() tea.Msg {
		r, err := runTest(event, "Bash", command)
		return testMsg{r, err}
	}
}
func doTogglePlugin(name string, on bool) tea.Cmd {
	return func() tea.Msg {
		var err error
		if on {
			err = addPlugin(name)
		} else {
			err = removePlugin(name)
		}
		if err != nil {
			return actionMsg{"", err}
		}
		verb := "added"
		if !on {
			verb = "removed"
		}
		return actionMsg{fmt.Sprintf("%s %s — press s to sync", verb, name), nil}
	}
}

// --- init/update -----------------------------------------------------------

func initialModel() model {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(accent)
	// Start with a usable size rather than 0. Most terminals send a
	// WindowSizeMsg immediately, but pty wrappers and some multiplexers don't —
	// and rendering nothing but "starting…" forever is a bad first impression
	// for something whose whole job is being pleasant to use.
	return model{
		width:       100,
		height:      32,
		spin:        s,
		loading:     true,
		playCommand: "rm -rf /",
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(m.spin.Tick, loadList(), loadPlan())
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		return m, cmd

	case listMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err
		} else {
			m.list = msg.res
			m.err = nil
		}
		return m, nil

	case planMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err
		} else {
			m.plan = msg.res
		}
		return m, nil

	case doctorMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err
		} else {
			m.doctor = msg.res
		}
		return m, nil

	case testMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err
		} else {
			m.test = msg.res
		}
		return m, nil

	case actionMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}
		m.status = msg.status
		return m, tea.Batch(loadList(), loadPlan())

	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Text entry in the playground swallows most keys, so handle it first.
	if m.playEditing {
		switch msg.Type {
		case tea.KeyEnter:
			m.playEditing = false
			m.loading = true
			return m, tea.Batch(m.spin.Tick, doTest(m.playgroundEvent(), m.playCommand))
		case tea.KeyEsc:
			m.playEditing = false
			return m, nil
		case tea.KeyBackspace:
			if len(m.playCommand) > 0 {
				m.playCommand = m.playCommand[:len(m.playCommand)-1]
			}
			return m, nil
		case tea.KeyRunes, tea.KeySpace:
			m.playCommand += msg.String()
			return m, nil
		}
		return m, nil
	}

	if m.confirming != "" {
		switch msg.String() {
		case "y", "Y", "enter":
			action := m.confirming
			m.confirming = ""
			if action == "sync" {
				m.loading = true
				return m, tea.Batch(m.spin.Tick, doApply())
			}
		default:
			m.confirming = ""
		}
		return m, nil
	}

	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit

	case "tab", "l", "right":
		m.tab = (m.tab + 1) % tab(len(tabNames))
		return m, m.onTabEnter()
	case "shift+tab", "h", "left":
		m.tab = (m.tab + tab(len(tabNames)) - 1) % tab(len(tabNames))
		return m, m.onTabEnter()

	case "1":
		m.tab = tabAgents
		return m, m.onTabEnter()
	case "2":
		m.tab = tabPlugins
		return m, m.onTabEnter()
	case "3":
		m.tab = tabSync
		return m, m.onTabEnter()
	case "4":
		m.tab = tabDoctor
		return m, m.onTabEnter()
	case "5":
		m.tab = tabPlayground
		return m, m.onTabEnter()

	case "j", "down":
		m.moveCursor(1)
		return m, nil
	case "k", "up":
		m.moveCursor(-1)
		return m, nil
	case "g":
		m.setCursor(0)
		return m, nil
	case "G":
		m.setCursor(m.rowCount() - 1)
		return m, nil

	case "r":
		m.loading = true
		m.status = ""
		return m, tea.Batch(m.spin.Tick, loadList(), loadPlan(), loadDoctor())

	case "s":
		m.confirming = "sync"
		return m, nil

	case " ", "enter":
		return m.activate()
	}
	return m, nil
}

func (m model) onTabEnter() tea.Cmd {
	if m.tab == tabDoctor && len(m.doctor.Findings) == 0 {
		m.loading = true
		return tea.Batch(m.spin.Tick, loadDoctor())
	}
	if m.tab == tabPlayground && len(m.test.Results) == 0 {
		return doTest(m.playgroundEvent(), m.playCommand)
	}
	return nil
}

// activate is the space/enter action, which means something different per tab.
func (m model) activate() (tea.Model, tea.Cmd) {
	switch m.tab {
	case tabPlugins:
		if m.pluginCursor < len(m.list.Plugins) {
			p := m.list.Plugins[m.pluginCursor]
			on := !m.pluginEnabled(p.Name)
			m.loading = true
			return m, tea.Batch(m.spin.Tick, doTogglePlugin(p.Name, on))
		}
	case tabPlayground:
		m.playEditing = true
		return m, nil
	case tabSync:
		m.confirming = "sync"
		return m, nil
	}
	return m, nil
}

func (m model) playgroundEvent() string {
	events := []string{"preToolUse", "userPromptSubmit", "postToolUse", "stop"}
	return events[m.playEvent%len(events)]
}

func (m *model) moveCursor(d int) {
	n := m.rowCount()
	if n == 0 {
		return
	}
	c := m.cursor() + d
	if c < 0 {
		c = 0
	}
	if c >= n {
		c = n - 1
	}
	m.setCursor(c)
}

func (m model) cursor() int {
	switch m.tab {
	case tabAgents:
		return m.agentCursor
	case tabPlugins:
		return m.pluginCursor
	case tabSync:
		return m.syncCursor
	case tabDoctor:
		return m.doctorCursor
	}
	return 0
}

func (m *model) setCursor(c int) {
	if c < 0 {
		c = 0
	}
	switch m.tab {
	case tabAgents:
		m.agentCursor = c
	case tabPlugins:
		m.pluginCursor = c
	case tabSync:
		m.syncCursor = c
	case tabDoctor:
		m.doctorCursor = c
	case tabPlayground:
		m.playEvent = c
	}
}

func (m model) rowCount() int {
	switch m.tab {
	case tabAgents:
		return len(m.list.Agents)
	case tabPlugins:
		return len(m.list.Plugins)
	case tabSync:
		return len(m.plan.Agents)
	case tabDoctor:
		return len(m.doctor.Agents)
	}
	return 0
}

func (m model) pluginEnabled(name string) bool {
	if m.list.Config == nil {
		return false
	}
	for _, h := range m.list.Config.Hooks {
		if h.Plugin == name {
			return true
		}
	}
	return false
}

func (m model) agentConfigured(id string) bool {
	if m.list.Config == nil {
		return false
	}
	for _, a := range m.list.Config.Agents {
		if a == id {
			return true
		}
	}
	return false
}

func main() {
	p := tea.NewProgram(initialModel(), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "hook-factory-tui:", err)
		os.Exit(1)
	}
}

func clamp(s string, n int) string {
	if n <= 0 {
		return ""
	}
	r := []rune(stripANSI(s))
	if len(r) <= n {
		return s
	}
	if n <= 1 {
		return string(r[:n])
	}
	return string(r[:n-1]) + "…"
}

func stripANSI(s string) string {
	var b strings.Builder
	in := false
	for _, r := range s {
		if r == '\x1b' {
			in = true
			continue
		}
		if in {
			if r == 'm' {
				in = false
			}
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
