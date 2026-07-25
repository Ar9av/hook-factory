package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Events shown in the capability matrix. Kept short so the matrix fits an
// 80-column terminal alongside the agent names.
var matrixEvents = []string{"sessionStart", "userPromptSubmit", "preToolUse", "postToolUse", "preShell", "subagentStop", "stop"}
var matrixLabels = []string{"sess", "prompt", "pre", "post", "shell", "sub", "stop"}

func (m model) View() string {
	var b strings.Builder
	b.WriteString(m.header())
	b.WriteString("\n")
	b.WriteString(m.tabs())
	b.WriteString("\n\n")

	body := ""
	switch {
	case m.err != nil:
		body = m.errorView()
	case m.loading && m.rowCount() == 0:
		body = fmt.Sprintf("  %s loading…", m.spin.View())
	default:
		switch m.tab {
		case tabAgents:
			body = m.agentsView()
		case tabPlugins:
			body = m.pluginsView()
		case tabSync:
			body = m.syncView()
		case tabDoctor:
			body = m.doctorView()
		case tabPlayground:
			body = m.playgroundView()
		}
	}
	b.WriteString(body)
	b.WriteString("\n")
	b.WriteString(m.footer())
	return b.String()
}

func (m model) header() string {
	title := titleStyle.Render(" hook-factory ")
	sub := ""
	if m.list.Config != nil {
		sub = subtitleStyle.Render(fmt.Sprintf("  %d hooks → %d agents  ·  %s",
			len(m.list.Config.Hooks), len(m.list.Config.Agents), m.list.Config.Path))
	} else {
		sub = subtitleStyle.Render("  no hooks.config.ts — run `hook-factory init`")
	}
	return title + clamp(sub, m.width-len(stripANSI(title))-1)
}

func (m model) tabs() string {
	var parts []string
	for i, name := range tabNames {
		label := fmt.Sprintf("%d %s", i+1, name)
		if tab(i) == m.tab {
			parts = append(parts, tabActive.Render(label))
		} else {
			parts = append(parts, tabInactive.Render(label))
		}
	}
	return lipgloss.JoinHorizontal(lipgloss.Bottom, parts...)
}

func (m model) errorView() string {
	return paneStyle.Width(m.width - 4).Render(
		badStyle.Render("✗ ") + m.err.Error() + "\n\n" +
			mutedText.Render("press r to retry, q to quit"))
}

// --- Agents ----------------------------------------------------------------

func (m model) agentsView() string {
	left := m.agentList()
	right := m.agentDetail()
	lw := 46
	if m.width < 88 {
		return left
	}
	return lipgloss.JoinHorizontal(lipgloss.Top,
		paneFocused.Width(lw).Height(m.bodyHeight()).Render(left),
		paneStyle.Width(m.width-lw-8).Height(m.bodyHeight()).Render(right),
	)
}

func (m model) agentList() string {
	var b strings.Builder
	hdr := fmt.Sprintf("%-20s %s", "", strings.Join(matrixLabels, " "))
	b.WriteString(dimRow.Render(hdr) + "\n")

	start, end := window(m.agentCursor, len(m.list.Agents), m.bodyHeight()-3)
	for i := start; i < end; i++ {
		a := m.list.Agents[i]
		caps := make([]string, len(matrixEvents))
		for j, ev := range matrixEvents {
			caps[j] = pad(capGlyph(findCap(a, ev)), len(matrixLabels[j]))
		}
		mark := "  "
		if m.agentConfigured(a.ID) {
			mark = okStyle.Render("● ")
		}
		name := clamp(a.Name, 18)
		row := fmt.Sprintf("%s%-18s %s", mark, name, strings.Join(caps, " "))
		if i == m.agentCursor {
			b.WriteString(selectedRow.Render("▸ "+stripANSI(row)) + "\n")
		} else {
			b.WriteString("  " + row + "\n")
		}
	}
	b.WriteString("\n")
	b.WriteString(dimRow.Render(fmt.Sprintf("%s can block   %s fires only   %s n/a",
		lipgloss.NewStyle().Foreground(accent).Render("■"), okStyle.Render("●"), "·")))
	return b.String()
}

func findCap(a Agent, event string) Capability {
	for _, c := range a.Capabilities {
		if c.Event == event {
			return c
		}
	}
	return Capability{Event: event}
}

func (m model) agentDetail() string {
	if m.agentCursor >= len(m.list.Agents) {
		return ""
	}
	a := m.list.Agents[m.agentCursor]
	var b strings.Builder
	b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(accent).Render(a.Name))
	b.WriteString("  " + statusBadge(a.Status) + "\n")
	b.WriteString(mutedText.Render(a.ID) + "\n\n")

	if m.agentConfigured(a.ID) {
		b.WriteString(okStyle.Render("● in your config") + "\n\n")
	} else {
		b.WriteString(dimRow.Render("○ not in your config — add '"+a.ID+"' to agents[]") + "\n\n")
	}

	if a.Install == "none" {
		b.WriteString(badStyle.Render("no hook system") + "\n")
	} else if a.Install == "snippet" {
		b.WriteString(warnStyle.Render("paste-in config") + mutedText.Render(" — sync prints a block to copy") + "\n")
	} else {
		b.WriteString(okStyle.Render("auto-installed") + mutedText.Render(" — sync writes its config directly") + "\n")
	}
	b.WriteString("\n")

	supported := 0
	for _, c := range a.Capabilities {
		if c.Supported {
			supported++
		}
	}
	b.WriteString(fmt.Sprintf("%s %d events, %d can block\n\n",
		mutedText.Render("events:"), supported, len(a.Blocking)))

	// Show the native names, which is the thing you actually need when you go
	// read the agent's own docs.
	var native []string
	for _, c := range a.Capabilities {
		if !c.Supported {
			continue
		}
		s := c.Event + " → " + c.Native
		if c.Blocking {
			s = lipgloss.NewStyle().Foreground(accent).Render(s)
		} else {
			s = dimRow.Render(s)
		}
		native = append(native, s)
	}
	limit := m.bodyHeight() - 16
	if limit < 3 {
		limit = 3
	}
	for i, n := range native {
		if i >= limit {
			b.WriteString(dimRow.Render(fmt.Sprintf("  … %d more", len(native)-limit)) + "\n")
			break
		}
		b.WriteString("  " + n + "\n")
	}

	if len(a.Notes) > 0 {
		b.WriteString("\n" + warnStyle.Render("worth knowing") + "\n")
		for _, n := range a.Notes {
			b.WriteString(mutedText.Render(wrapText("  · "+n, m.width-58)) + "\n")
		}
	}
	return b.String()
}

// --- Plugins ---------------------------------------------------------------

func (m model) pluginsView() string {
	var b strings.Builder
	b.WriteString(mutedText.Render("  space toggles a plugin in hooks.config.ts, then s to sync") + "\n\n")

	for i, p := range m.list.Plugins {
		on := m.pluginEnabled(p.Name)
		box := dimRow.Render("[ ]")
		if on {
			box = okStyle.Render("[✓]")
		}
		name := fmt.Sprintf("%-18s", p.Name)
		if i == m.pluginCursor {
			name = selectedRow.Render(name)
		} else if on {
			name = normalRow.Render(name)
		} else {
			name = dimRow.Render(name)
		}
		cursor := "  "
		if i == m.pluginCursor {
			cursor = selectedRow.Render("▸ ")
		}
		b.WriteString(fmt.Sprintf("%s%s %s %s\n", cursor, box, name, mutedText.Render(clamp(p.Description, m.width-32))))
		if i == m.pluginCursor {
			b.WriteString(fmt.Sprintf("        %s\n", dimRow.Render(p.Example)))
			if p.NeedsOptions {
				b.WriteString(fmt.Sprintf("        %s\n", warnStyle.Render("needs options — edit the call after adding")))
			}
		}
	}

	if m.list.Config != nil {
		custom := 0
		for _, h := range m.list.Config.Hooks {
			if h.Plugin == "" {
				custom++
			}
		}
		if custom > 0 {
			b.WriteString("\n" + mutedText.Render(fmt.Sprintf("  plus %d hand-written hook(s) in your config", custom)) + "\n")
		}
	}
	return b.String()
}

// --- Sync ------------------------------------------------------------------

func (m model) syncView() string {
	if len(m.plan.Agents) == 0 {
		return mutedText.Render("  nothing to sync — add agents to hooks.config.ts")
	}
	left := m.syncList()
	if m.width < 88 {
		return left
	}
	lw := 40
	return lipgloss.JoinHorizontal(lipgloss.Top,
		paneFocused.Width(lw).Height(m.bodyHeight()).Render(left),
		paneStyle.Width(m.width-lw-8).Height(m.bodyHeight()).Render(m.syncDetail()),
	)
}

func (m model) syncList() string {
	var b strings.Builder
	b.WriteString(mutedText.Render(clamp("runner "+m.plan.Runner, 36)) + "\n\n")
	changed := 0
	for i, a := range m.plan.Agents {
		n := 0
		for _, w := range a.Writes {
			if w.Changed {
				n++
			}
		}
		changed += n
		state := okStyle.Render("up to date")
		if n > 0 {
			state = warnStyle.Render(fmt.Sprintf("%d change(s)", n))
		}
		if a.Install == "snippet" {
			state = infoStyle.Render("paste needed")
		}
		if a.Install == "none" {
			state = dimRow.Render("no hooks")
		}
		cursor := "  "
		nm := fmt.Sprintf("%-18s", clamp(a.Name, 18))
		if i == m.syncCursor {
			cursor = selectedRow.Render("▸ ")
			nm = selectedRow.Render(nm)
		}
		b.WriteString(fmt.Sprintf("%s%s %s\n", cursor, nm, state))
	}
	b.WriteString("\n")
	if changed > 0 {
		b.WriteString(warnStyle.Render(fmt.Sprintf("  %d file(s) pending — press s", changed)))
	} else {
		b.WriteString(okStyle.Render("  everything is in sync"))
	}
	return b.String()
}

func (m model) syncDetail() string {
	if m.syncCursor >= len(m.plan.Agents) {
		return ""
	}
	a := m.plan.Agents[m.syncCursor]
	var b strings.Builder
	b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(accent).Render(a.Name) + "  " + statusBadge(a.Status) + "\n")
	b.WriteString(mutedText.Render(fmt.Sprintf("%d hook(s) apply here", a.HookCount)) + "\n\n")

	budget := m.bodyHeight() - 8
	used := 0
	for _, w := range a.Writes {
		b.WriteString(infoStyle.Render(clamp(w.Path, m.width-50)) + "\n")
		used++
		if !w.Changed {
			b.WriteString(dimRow.Render("  unchanged") + "\n")
			used++
			continue
		}
		for _, line := range strings.Split(w.Diff, "\n") {
			if used >= budget {
				b.WriteString(dimRow.Render("  …") + "\n")
				break
			}
			switch {
			case strings.HasPrefix(line, "+"):
				b.WriteString("  " + addLine.Render(clamp(line, m.width-52)) + "\n")
			case strings.HasPrefix(line, "-"):
				b.WriteString("  " + delLine.Render(clamp(line, m.width-52)) + "\n")
			default:
				b.WriteString("  " + dimRow.Render(clamp(line, m.width-52)) + "\n")
			}
			used++
		}
	}

	for _, s := range a.Snippets {
		b.WriteString("\n" + warnStyle.Render("paste into "+s.Path) + "\n")
		b.WriteString(mutedText.Render(wrapText(s.Instructions, m.width-50)) + "\n")
	}

	if len(a.UnsupportedHooks) > 0 {
		b.WriteString("\n" + warnStyle.Render(fmt.Sprintf("%d hook(s) skipped", len(a.UnsupportedHooks))) + "\n")
		for _, h := range a.UnsupportedHooks {
			b.WriteString(dimRow.Render(fmt.Sprintf("  %s — no %s event here", h.ID, h.Event)) + "\n")
		}
	}
	return b.String()
}

// --- Doctor ----------------------------------------------------------------

func (m model) doctorView() string {
	var b strings.Builder
	if len(m.doctor.Findings) == 0 {
		return fmt.Sprintf("  %s running checks…", m.spin.View())
	}
	b.WriteString(lipgloss.NewStyle().Bold(true).Render("  Environment") + "\n")
	for _, f := range m.doctor.Findings {
		icon := okStyle.Render("✓")
		if f.Level == "warn" {
			icon = warnStyle.Render("!")
		} else if f.Level == "error" {
			icon = badStyle.Render("✗")
		}
		b.WriteString(fmt.Sprintf("  %s %s\n", icon, clamp(f.Message, m.width-6)))
		if f.Fix != "" {
			b.WriteString("      " + dimRow.Render(clamp(f.Fix, m.width-8)) + "\n")
		}
	}

	if len(m.doctor.Agents) > 0 {
		b.WriteString("\n" + lipgloss.NewStyle().Bold(true).Render("  Agents") + "\n")
		for i, a := range m.doctor.Agents {
			icon := okStyle.Render("✓")
			if len(a.Issues) > 0 {
				icon = warnStyle.Render("!")
			}
			wired := badStyle.Render("not synced")
			if a.Installed {
				wired = okStyle.Render("wired up")
			}
			local := dimRow.Render("not detected")
			if a.Detected {
				local = mutedText.Render("installed")
			}
			cursor := "  "
			if i == m.doctorCursor {
				cursor = selectedRow.Render("▸ ")
			}
			b.WriteString(fmt.Sprintf("%s%s %-20s %s  %s  %s\n", cursor, icon,
				clamp(a.Name, 20), wired, local, mutedText.Render(fmt.Sprintf("%d hooks", a.HookCount))))
			if i == m.doctorCursor {
				for _, issue := range a.Issues {
					b.WriteString("      " + dimRow.Render(wrapText(issue, m.width-8)) + "\n")
				}
			}
		}
	}
	return b.String()
}

// --- Playground ------------------------------------------------------------

func (m model) playgroundView() string {
	events := []string{"preToolUse", "userPromptSubmit", "postToolUse", "stop"}
	var b strings.Builder

	b.WriteString(mutedText.Render("  Fire a synthetic event through your real hooks. Nothing is executed.") + "\n\n")

	b.WriteString("  event   ")
	for i, e := range events {
		if i == m.playEvent%len(events) {
			b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("#FFF")).Background(accent).Padding(0, 1).Render(e))
		} else {
			b.WriteString(dimRow.Render(" " + e + " "))
		}
		b.WriteString(" ")
	}
	b.WriteString("\n\n")

	field := m.playCommand
	if m.playEditing {
		field += lipgloss.NewStyle().Foreground(accent).Render("▏")
		b.WriteString("  command " + paneFocused.Width(m.width-14).Render(field) + "\n")
		b.WriteString("          " + dimRow.Render("enter to run · esc to cancel") + "\n\n")
	} else {
		b.WriteString("  command " + paneStyle.Width(m.width-14).Render(field) + "\n")
		b.WriteString("          " + dimRow.Render("space to edit · j/k changes event") + "\n\n")
	}

	if len(m.test.Results) == 0 {
		b.WriteString(dimRow.Render("  no run yet"))
		return b.String()
	}

	b.WriteString(lipgloss.NewStyle().Bold(true).Render("  Result per agent") + "\n")
	for _, r := range m.test.Results {
		if r.Skipped {
			b.WriteString(fmt.Sprintf("  %s %-20s %s\n", dimRow.Render("·"), r.Agent, dimRow.Render(r.Reason)))
			continue
		}
		icon, verdict := okStyle.Render("·"), dimRow.Render("no opinion")
		if r.Decision != nil {
			switch r.Decision.Kind {
			case "deny":
				if r.CanBlock {
					icon = badStyle.Render("■")
					verdict = badStyle.Render("BLOCKED — " + clamp(r.Decision.Reason, m.width-40))
				} else {
					icon = warnStyle.Render("!")
					verdict = warnStyle.Render("deny requested but this agent can't block here → warning only")
				}
			case "context":
				icon = infoStyle.Render("+")
				verdict = infoStyle.Render("inject: " + clamp(r.Decision.Text, m.width-40))
			case "continue":
				icon = infoStyle.Render("↻")
				verdict = infoStyle.Render("keep going: " + clamp(r.Decision.Message, m.width-40))
			case "warn":
				icon = warnStyle.Render("!")
				verdict = warnStyle.Render(clamp(r.Decision.Message, m.width-40))
			default:
				icon = okStyle.Render("✓")
				verdict = okStyle.Render(r.Decision.Kind)
			}
		}
		b.WriteString(fmt.Sprintf("  %s %-20s %s %s\n", icon, clamp(r.Agent, 20), verdict,
			dimRow.Render(fmt.Sprintf("exit %d", r.ExitCode))))
		for _, run := range r.Ran {
			b.WriteString(fmt.Sprintf("      %s %s\n", dimRow.Render(run.ID), dimRow.Render(fmt.Sprintf("%dms", run.Ms))))
		}
	}
	return b.String()
}

// --- chrome ----------------------------------------------------------------

func (m model) footer() string {
	if m.confirming == "sync" {
		return "\n" + warnStyle.Render("  write these files to every configured agent? ") +
			keyStyle.Render("y") + mutedText.Render(" yes  ") + keyStyle.Render("any") + mutedText.Render(" cancel")
	}
	if m.status != "" {
		return "\n  " + okStyle.Render("✓ "+m.status)
	}
	keys := [][2]string{
		{"tab", "switch"}, {"j/k", "move"}, {"space", "act"}, {"s", "sync"}, {"r", "reload"}, {"q", "quit"},
	}
	var parts []string
	for _, k := range keys {
		parts = append(parts, keyStyle.Render(k[0])+helpStyle.Render(" "+k[1]))
	}
	return "\n  " + strings.Join(parts, helpStyle.Render("  ·  "))
}

func (m model) bodyHeight() int {
	h := m.height - 8
	if h < 8 {
		return 8
	}
	return h
}

func window(cursor, total, size int) (int, int) {
	if size <= 0 || total == 0 {
		return 0, 0
	}
	if total <= size {
		return 0, total
	}
	start := cursor - size/2
	if start < 0 {
		start = 0
	}
	if start+size > total {
		start = total - size
	}
	return start, start + size
}

func pad(s string, n int) string {
	w := len([]rune(stripANSI(s)))
	if w >= n {
		return s
	}
	return s + strings.Repeat(" ", n-w)
}

func wrapText(s string, width int) string {
	if width < 20 {
		width = 20
	}
	words := strings.Fields(s)
	var lines []string
	cur := ""
	for _, w := range words {
		if len(cur)+len(w)+1 > width {
			lines = append(lines, cur)
			cur = w
		} else if cur == "" {
			cur = w
		} else {
			cur += " " + w
		}
	}
	if cur != "" {
		lines = append(lines, cur)
	}
	return strings.Join(lines, "\n  ")
}
