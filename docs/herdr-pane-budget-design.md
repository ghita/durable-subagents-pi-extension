# Bounded Herdr agent display

Status: design agreed with the user and implemented locally for GitHub issue #6. See the acceptance criteria and tests below.

## Agreed requirements

- Bound agent-display pane accumulation, not managed-agent creation or execution. Overflow agents can be created and work without being displayed.
- The pane budget is scoped to a Herdr tab, not globally across sessions or workspaces. The expected arrangement is a different tab for each main Pi session.
- Background tabs must not be used to accumulate overflow agent-display panes outside the budget.
- K counts only agent-display panes. The main Pi pane and unrelated terminals do not count.
- Displayed active agents retain their slots. When a displayed agent becomes idle, an undisplayed active agent can take its place; overflow agents continue executing while waiting for display.
- Waiting active agents are admitted in arrival order, rather than by output frequency.
- If no active agent is waiting, retain an idle agent's pane and last output until replacement is needed.
- Reassignment reuses the same pane with a clean display, the new agent's identity, and a replay of its current-task output before live updates continue. The previous agent's durable conversation is unchanged.
- Default K is 3. K is a configurable nonnegative integer; 0 disables agent-display panes without disabling managed agents.
- An undisplayed agent receiving more work joins the back of the display queue; prior pane ownership gives no priority. Skip agents that become idle before receiving a slot.
- Initial scope is automatic assignment only; no manual selection or pinning commands.
- `/agents panes K` changes the current tab's budget; `/agents panes` reports it. The setting is runtime-only and resets to 3 on extension reload or Pi restart.
- Budget changes apply immediately. When shrinking, remove idle display panes first, then the most recently assigned active displays. Displaced agents continue working and retain their original waiting priority ahead of newer arrivals. Increasing K immediately admits waiting agents.
- An agent yields when it has neither executing nor queued instructions. Pending report delivery alone does not make an agent eligible for a live display.
- Manually closing a display pane does not change K or suppress automatic assignment; a pane can be recreated while active agents need display. Use the budget command to reduce the footprint.
- On reload/resume, reconcile previously owned panes to K, retaining eligible active displays first and idle displays only in spare slots. Close excess owned panes, including legacy unlimited displays, without touching unrelated panes, stopping agents, or deleting conversations.
- Reassignment clears both the visible screen and terminal scrollback before showing the new occupant. Durable conversations, not display panes, retain history.
- Support one display-managing main Pi session per Herdr tab. Multiple main Pi sessions managing displays in the same tab are unsupported in this version; cross-process budget coordination is out of scope.
- Display failures must not stop or fail agent work. Conservatively account for panes whose close/create outcome is uncertain; do not create replacements that could exceed K. Surface display failures without repeated notification flooding.
- When several displayed agents are idle, replace the one that has been idle longest.

## Implementation considerations

These details must preserve the agreed behavior above; they are not additional user-facing features.

- Define and track a reliable replay boundary for current work, including instructions steering an existing run. Do not equate one instruction with one run or use pending report delivery as evidence of executing/queued instructions. Persist or observe input-entry boundaries as needed; the current code has no reliable active-period replay marker.
- Serialize slot allocation, reassignment, and reconciliation so concurrent agent updates cannot allocate beyond K or append stale output after a slot changes occupant.
- Add renderer support for reset/clear, including scrollback, and prevent old in-flight writes from contaminating the new occupant's output.
- Reconcile persisted pane associations into reusable slots and update persistence accordingly. Verify tracked pane identities before cleanup; do not discover ownership by labels or close unrelated panes. Untracked panes must not be assumed to belong to this extension.
- Account for manually moved or missing tracked panes during reconciliation without accumulating orphan displays in other tabs. Preserve explicit pane targeting and do not steal focus.
- On failed cleanup of pre-existing excess panes, retain conservative accounting and surface the problem rather than claiming the physical pane count already meets K.

## Implementation notes

- A single serialized scheduler allocates, reconciles, reassigns, and publishes bounded display slots. Durable watches trigger coalesced refreshes; a one-second runtime poll catches activity changes and manually closed panes.
- Durable submission state distinguishes executing/queued instructions from report-only work. Persisted work-period identities and input-entry boundaries preserve FIFO acceptance order and replay all current work, including steers and content outside the watch's rolling window.
- An observed new work-period identity releases the prior period's display priority even if polling missed the brief idle interval.
- Pane handoff resets both screen and scrollback; restoration of an unconfirmed occupant resets/replays too. Already-running legacy append-only renderers can clear through a trusted append operation without launching a second renderer.
- A durable creation reservation is written before a split and cleared atomically with the returned pane association. An unresolved split pauses further creation across reloads until explicitly resolved after inspection; restart does not implicitly discard uncertainty. A confirmed inability to start the CLI can safely release the reservation. Association-persistence failures retain the physical slot and retry its known target.
- Missing-pane replacement requires confirmed absence, not a generic CLI failure. Failed imports block new allocations until all persisted targets can be accounted for. Excess-pane close failures retain their accounting.

## Pre-implementation code investigation

- `/agents footer alwaysOn|activity` provides an existing command/configuration pattern, but its setting is process-local; there is no existing per-tab budget preference.
- `AgentService.footerSummaries()` distinguishes a live run from pending reporter work. Pending reporter work must not by itself be treated as queued instructions for display eligibility.
- Existing pane associations are persisted per managed agent, not per reusable display slot.
- The renderer currently supports append and ping only, so clean reassignment requires new renderer behavior.
- Existing replay tracks conversation entry IDs, not explicit current-task boundaries.

## Previous behavior replaced

`README.md` documents one persistent pane per managed agent. `src/herdr-monitor.ts` creates and restores those panes, retains them after completion, and recreates manually closed panes on subsequent updates. The new design must replace this unbounded display policy without limiting agent work.

## Acceptance criteria

- [x] With K = 3 and many concurrent agents, at most 3 agent-display panes are allocated; every agent can still execute and report. No overflow tabs are created.
- [x] Active displays are stable. Waiting agents are admitted FIFO, skipping agents that have become idle. Returning undisplayed agents join the back of the queue.
- [x] Idle displays remain when there is no demand; the longest-idle display yields first when demand arrives. Pending report delivery alone does not retain eligibility.
- [x] Reassignment reuses a pane, clears screen and scrollback, shows the new identity, replays current work, and continues live output without stale cross-agent writes.
- [x] `/agents panes` reports K; `/agents panes K` validates a nonnegative integer and applies it immediately. K defaults to 3 after reload/restart; K = 0 removes owned display panes without stopping agents.
- [x] Shrinking closes idle panes first, then the most recently assigned active displays, preserving displaced agents' original waiting priority. Growing admits waiting agents immediately.
- [x] Separate tabs have independent budgets. The main Pi pane and unrelated terminals are not counted or modified.
- [x] Resume/upgrade reconciles tracked legacy displays to K, preferring active displays, and closes excess owned panes without deleting agent state or conversations.
- [x] A manually closed pane can be recreated without changing K. Failed or uncertain display operations cannot trigger uncontrolled replacement-pane growth or disrupt agent work.
- [x] Tests cover concurrency, overflow completing while undisplayed, steered/queued instructions, idle replacement, resize-to-zero, reset/replay, resume/legacy cleanup, and failure recovery.
- [x] Update `README.md` to replace the one-pane-per-agent promise and document the command, lifecycle, and unsupported shared-tab configuration.
- [x] `npm test` and `npm run typecheck` pass.

## Validation

- `npm test`: 120 tests passed across 13 files.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- Coverage includes real Durable harness integration and the persistent renderer protocol. Herdr CLI syntax and response schemas were checked read-only; no live user panes were created, moved, or closed for testing.
