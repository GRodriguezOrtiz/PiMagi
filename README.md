# PiMagi

A Dockerized [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding-agent setup featuring a three-agent **Magi**-style team (Melchior, Balthasar, Casper) coordinated by an Orchestrator, plus a lighter `regular-pi` profile. Comes with a damage-control safety extension, a theme cycler, and a collection of curated themes.

## Why MAGI?

I came across Pi by accident on YouTube [I Hated Every Coding Agent, So I Built My Own — Mario Zechner (Pi)](https://www.youtube.com/watch?v=Dli5slNaJu0), and the idea really resonated with me.                                                                                                                                                                      
Later I came across [IndyDevDan's take](https://www.youtube.com/watch?v=f8cfH5XX-XU) and I really liked the idea of how he was setting up a team of AI agents working together.

I wanted to give it a shot because in my head I think I could benefit from a fixed stack of AI agents for my daily dev tasks:
- A scout
- A reviewer
- A builder

Each with its own context, reducing pollution of the process, especially with how verbose these agents are.

In this weird time of software engineering, I wanted to have some fun and try my hand at working with subagents.                                                                                                                                                                                                   
And the naming... I mean, I'm an anime fan, you probably are as well. It was right around the corner, gimme a break.

## Project Layout

```
.
├── docker/
│   ├── Dockerfile           # Chainguard Node image + pi + helpers
│   └── docker-compose.yml   # `magi` and `regular-pi` services
└── src/
    ├── definitions/         # Agent system prompts (orchestrator + 3 magi)
    ├── extension/           # pi extensions (agent-team, theme-cycler, damage-control)
    ├── damage-control/      # YAML rules for the damage-control extension
    └── themes/              # JSON themes used by the theme cycler
```

### Agents

| Agent       | Role                                          | Writes? |
|-------------|-----------------------------------------------|---------|
| Orchestrator| Dispatcher only — no direct codebase access  | No      |
| Melchior-1  | Scout — read-only recon, codebase mapping     | No      |
| Balthasar-2 | Reviewer — code review, quality checks        | No      |
| Casper-3    | Builder — implementation, file writes, tests  | Yes     |

The Orchestrator coordinates the three specialists through the `dispatch_agent` tool exposed by `src/extension/agent-team.ts`.

### Services

- **`magi`** — Full orchestrator + Melchior/Balthasar/Casper team, with theme cycler and damage-control loaded.
- **`regular-pi`** — Plain pi with only the damage-control extension mounted. Useful for everyday work without the multi-agent overhead.

Both services mount the **current working directory** (`${PWD}`) as `/workspace` inside the container, so you can run them from any project root.

## Requirements

- Docker + Docker Compose

## Quick Start

From any project directory you want pi to operate on:

```sh
docker compose -f PATH_TO_YOUR_MAGI_STACK/docker/docker-compose.yml run --rm magi
# or, for the lighter setup:
docker compose -f PATH_TO_YOUR_MAGI_STACK/docker/docker-compose.yml run --rm regular-pi
```

### Recommended shell aliases

Add these to your `~/.bashrc` / `~/.zshrc` for one-word invocation from any project:

```sh
alias magi-pi='docker compose -f PATH_TO_YOUR_MAGI_STACK/docker/docker-compose.yml run --rm magi'
alias regular-pi='docker compose -f PATH_TO_YOUR_MAGI_STACK/docker/docker-compose.yml run --rm regular-pi'
```

Then simply:

```sh
cd ~/some/project
magi-pi # launch the full Magi team
regular-pi # launch plain pi with damage-control
```

## Persistence

Each service has its own directory on the host for pi's agent data (sessions, credentials, settings, `pi install`ed packages):

- `~/.pi/magi-agent` — used by `magi`
- `~/.pi/regular-pi-agent` — used by `regular-pi`

Create these before the first run so Docker doesn't create them as root:

```sh
mkdir -p ~/.pi/magi-agent ~/.pi/regular-pi-agent
```

These survive container restarts and image rebuilds. Being plain host directories, sessions and credentials are directly inspectable and easy to back up or rotate. Extensions, definitions, themes, and damage-control rules are bind-mounted read-only from `src/` so edits on the host take effect immediately on next run.

## Customization

- **Override an agent prompt:** drop a matching `<agent>.md` into `<cwd>/agents/`, `<cwd>/.claude/agents/`, or `<cwd>/.pi/agents/` inside the project you're working on.
- **Tune safety rules:** edit `src/damage-control/damage-control-rules.yaml`.
- **Themes:** Alt+E / Alt+Q to cycle, or `/theme [name]` inside pi.

## Build

The image is built automatically by `docker compose run`. To rebuild explicitly:

```sh
docker compose -f PATH_TO_YOUR_MAGI_STACK/docker/docker-compose.yml build
```

## Credits

**[`damage-control.ts`](src/extension/damage-control.ts)** and **[`theme-cycler.ts`](src/extension/theme-cycler.ts)** are adapted from [pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code) by [IndyDevDan](https://github.com/disler).

**[`agent-team.ts`](src/extension/agent-team.ts)** builds on the `dispatch_agent` pattern and grid dashboard from [pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code) by [IndyDevDan](https://github.com/disler).

**[`Dockerfile`](docker/Dockerfile)** is based on [pi-less-yolo](https://github.com/cjermain/pi-less-yolo) by [Colin Jermain](https://github.com/cjermain).
