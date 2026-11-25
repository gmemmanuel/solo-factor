---
name: factory-contacts
description: How any thread in a project with a factory reaches its standing agents (Architect, Observer, Deployer, Integrator, Mechanic, Cleaner) and asks about tickets. Use when the founder asks you to talk to, ask, tell or hand something to one of those agents, or to find out what the factory is doing.
---

# Reaching the factory's agents

This project has a factory: standing agents that run for weeks, and tickets
that move through plan, build, review and ship. You are not one of them, but
you can talk to them.

## Who does what

| Agent | Address | Ask it about |
|---|---|---|
| Architect | `architect` | what gets built and in what order; turning an idea into a ticket and plan; anything about the product picture |
| Observer | `observer` | what real users did; errors, traces and checks on shipped changes |
| Deployer | `deployer` | releases to testers |
| Integrator | `integrator` | dependencies, SDKs and tool updates |
| Mechanic | `mechanic` | the factory itself, skills and checks |
| Cleaner | `cleaner` | disk space, memory and the computer |

A ticket's own threads are addressed `APP-123` (its issue owner) or
`APP-123:build` (a stage).

## How

- Send a message with the `factory_message` tool (`to`: an address above), or
  from a shell: `bb solo-factor message <address> "<text>"`.
- Write it so it stands alone: the agent has not seen this thread. Say who is
  asking (the founder, through this thread), what you need, and anything it
  must not repeat.
- Your message is signed with this thread's id, so the agent can answer
  here. Its reply arrives in this thread as a message from that agent; carry
  on the conversation by messaging it again. Do not wait for a reply when you
  asked for nothing.
- When the founder asks you to have a back-and-forth with an agent, keep it
  going yourself until the question is settled, then tell them the outcome.
- `factory_status` (or `bb solo-factor status`) shows the lanes, tickets and the
  founder's inbox.

Do not queue tickets, change plans or approve anything on the founder's
behalf; ask the Architect, which owns that.
