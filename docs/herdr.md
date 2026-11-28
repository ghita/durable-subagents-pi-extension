# Herdr live agent panes

When the extension runs in a Herdr-managed pane, it can show managed-agent activity in a bounded pool of non-focused panes in the current tab. **The default budget is 3 panes.** This limits displays, not agents: overflow agents keep executing and reporting normally, without creating overflow tabs. The main Pi pane and unrelated terminals do not count toward the budget.

## Requirements

The integration is enabled only when `HERDR_ENV=1` and `HERDR_WORKSPACE_ID` are present and the `herdr` CLI is available. Display failures never stop agent work.

Only one display-managing main Pi session per Herdr tab is supported. Different Herdr tabs have independent budgets; multiple managers sharing one tab are not coordinated.

## Budget and assignment

Use `/agents panes` to report the current budget and `/agents panes K` to set a nonnegative integer budget immediately. `/agents panes 0` removes owned displays without stopping agents or deleting their durable conversations. Increasing the budget admits waiting agents immediately. When shrinking, idle panes are removed first, then the most recently assigned active displays; displaced agents keep their original waiting priority.

The preference is runtime-only: it survives managed-session runtime recreation in the same extension instance, but resets to 3 on extension reload or Pi restart.

Displayed active agents retain their slots. Waiting active agents are admitted in arrival order, skipping agents that become idle before admission. An agent is eligible while it has executing or queued instructions; pending report delivery alone does not count. An idle pane retains its last output until another active agent needs the slot, with the longest-idle pane reused first. An undisplayed agent receiving more work joins the back of the queue, regardless of earlier pane ownership. There are no manual selection or pinning commands.

## Pane reassignment and recovery

Reassignment reuses the pane, clears both the screen and scrollback, shows the new agent's identity (name, model, and thinking level), and replays its current-task output before live updates continue. The old agent's history remains in its durable conversation, not in the reused display. Panes show user inputs, assistant text (not hidden thinking), and completed tool calls with compact arguments and success/failure status; tool results are not copied.

On resume/reload, tracked owned panes are reconciled to the budget, retaining eligible active displays first and idle displays only in spare slots. Excess legacy displays are closed without touching unrelated terminals or deleting agent state. Manually closing a display does not reduce the budget: active demand can recreate it, checked about once a second. Use `/agents panes K` to reduce the footprint instead. Panes are explicitly targeted without stealing focus.

Display failures never stop agent work. Failed or uncertain pane operations are conservatively accounted for rather than risking extra replacements beyond the budget. A split is durably reserved before invoking Herdr; an unresolved split outcome suspends new pane creation even across reloads, until the reservation is explicitly resolved after inspection. There is no automatic reset on restart. Known-pane reconciliation can still retry, and a confirmed failure to start the CLI does not leave a reservation. Failures produce rate-limited visible warnings (at most one per 30 seconds), rather than notification flooding.
