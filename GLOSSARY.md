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
