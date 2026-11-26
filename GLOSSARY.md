# Durable Subagents

This context defines the named background agents that a Pi main agent can manage and reuse.

## Agents and messages

**Agent preset**:
A named reusable definition used to create a managed agent, including its instructions and optional model, thinking, and tool settings.
_Avoid_: Agent template

**Preset ID**:
The stable identifier used to find a user-global agent preset; it can differ from the managed agent's chosen instance name.
_Avoid_: Agent name (when referring to a preset)

**Managed agent**:
A named background agent controlled by the main agent. It can be active while doing work or idle while remaining available for more work.
_Avoid_: Anonymous agent

**Active agent**:
A managed agent that currently has work in progress.
_Avoid_: Running agent (when meaning registered-but-idle agents too)

**Idle agent**:
A registered managed agent with no work in progress, retained so it can be sent more work.
_Avoid_: Removed agent

**Incoming message**:
An accepted instruction sent from the main agent to a managed agent, including its initial instruction when spawned. Count it once even if the work is later stopped.

**Outgoing report**:
A response from a managed agent delivered to the main agent. Count it when delivered; stopped work with no report does not count.

**Persistent Pi session**:
A Pi session backed by a saved transcript path that can be reopened. Durable managed agents require this session type; temporary or transcript-less sessions are unsupported.
_Avoid_: Durable session (when referring only to Pi's transcript)

## Agent display

**Agent-display pane**:
A Herdr pane that shows a managed agent's activity. A managed agent can exist and work without an agent-display pane.

**Tab pane budget**:
The maximum number of agent-display panes in a Herdr tab, excluding the main Pi pane and unrelated terminals. It does not limit how many managed agents exist or are active.

**Display slot**:
A place within a tab's pane budget that can display one managed agent at a time. An idle agent can give way to another active agent without either agent being removed.

**Display-eligible agent**:
A managed agent with executing or queued instructions, whether or not it currently has a display slot. Pending report delivery alone does not make an agent display-eligible.

**Agent work period**:
An uninterrupted period during which a managed agent has executing or queued instructions. Additional steering instructions belong to that period until the agent has no work remaining.

## Agent diagnostics

**Managed-agent telemetry**:
Diagnostic data about managed-agent work, including task content, model responses, tool interactions, outcomes, and report delivery.

**Managed-agent trace**:
A correlated diagnostic record of one managed-agent request, from accepted instruction through the agent's work to its outgoing report.

## Agent capabilities

**Agent tool set**:
The exact set of tools enabled for a managed agent. The model may call each directly, and Code Mode scripts may call enabled tools other than Code Mode.

**Code Mode**:
An optional managed-agent capability for composing calls to tools in that agent's tool set into a script.
