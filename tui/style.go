package main

import "github.com/charmbracelet/lipgloss"

// One palette, adaptive so it reads on light and dark terminals. Everything
// else in the TUI composes from these — no ad-hoc colors scattered through the
// view code.
var (
	accent    = lipgloss.AdaptiveColor{Light: "#7C3AED", Dark: "#A78BFA"}
	accentDim = lipgloss.AdaptiveColor{Light: "#A78BFA", Dark: "#6D28D9"}
	fg        = lipgloss.AdaptiveColor{Light: "#1F2937", Dark: "#E5E7EB"}
	muted     = lipgloss.AdaptiveColor{Light: "#6B7280", Dark: "#9CA3AF"}
	faint     = lipgloss.AdaptiveColor{Light: "#9CA3AF", Dark: "#4B5563"}
	good      = lipgloss.AdaptiveColor{Light: "#059669", Dark: "#34D399"}
	warnC     = lipgloss.AdaptiveColor{Light: "#D97706", Dark: "#FBBF24"}
	bad       = lipgloss.AdaptiveColor{Light: "#DC2626", Dark: "#F87171"}
	info      = lipgloss.AdaptiveColor{Light: "#2563EB", Dark: "#60A5FA"}
	border    = lipgloss.AdaptiveColor{Light: "#D1D5DB", Dark: "#374151"}
)

var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#FFFFFF")).
			Background(accent).
			Padding(0, 1)

	subtitleStyle = lipgloss.NewStyle().Foreground(muted)

	tabActive = lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			Border(lipgloss.Border{Bottom: "━"}, false, false, true, false).
			BorderForeground(accent).
			Padding(0, 2)

	tabInactive = lipgloss.NewStyle().
			Foreground(faint).
			Border(lipgloss.Border{Bottom: "─"}, false, false, true, false).
			BorderForeground(border).
			Padding(0, 2)

	paneStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(border).
			Padding(0, 1)

	paneFocused = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(accent).
			Padding(0, 1)

	selectedRow = lipgloss.NewStyle().Bold(true).Foreground(accent)
	normalRow   = lipgloss.NewStyle().Foreground(fg)
	dimRow      = lipgloss.NewStyle().Foreground(faint)
	mutedText   = lipgloss.NewStyle().Foreground(muted)

	okStyle   = lipgloss.NewStyle().Foreground(good)
	warnStyle = lipgloss.NewStyle().Foreground(warnC)
	badStyle  = lipgloss.NewStyle().Foreground(bad)
	infoStyle = lipgloss.NewStyle().Foreground(info)

	addLine = lipgloss.NewStyle().Foreground(good)
	delLine = lipgloss.NewStyle().Foreground(bad)

	helpStyle = lipgloss.NewStyle().Foreground(faint)
	keyStyle  = lipgloss.NewStyle().Foreground(accentDim).Bold(true)

	badgeOK = lipgloss.NewStyle().Foreground(lipgloss.Color("#FFFFFF")).Background(good).Padding(0, 1)
	badgeWn = lipgloss.NewStyle().Foreground(lipgloss.Color("#000000")).Background(warnC).Padding(0, 1)
	badgeNo = lipgloss.NewStyle().Foreground(lipgloss.Color("#FFFFFF")).Background(bad).Padding(0, 1)
)

func statusBadge(status string) string {
	switch status {
	case "supported":
		return badgeOK.Render("full")
	case "partial":
		return badgeWn.Render("partial")
	default:
		return badgeNo.Render("none")
	}
}

// capGlyph renders one cell of the capability matrix: filled square means the
// agent can actually block on that event, hollow circle means the hook fires
// but cannot stop anything, dot means the event does not exist there.
func capGlyph(c Capability) string {
	if !c.Supported {
		return dimRow.Render("·")
	}
	if c.Blocking {
		return lipgloss.NewStyle().Foreground(accent).Render("■")
	}
	return okStyle.Render("●")
}
