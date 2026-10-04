# Claude Code setup kit — Readiness Dashboard

Unzip into the root of a new, empty git repository, then follow these steps.

## What's in here
| Path | Purpose |
|---|---|
| `PLAN.md` | Your build plan (the spec agents read) |
| `CLAUDE.md` | Project rules every Claude session loads: stack, commands, non-negotiables, git workflow |
| `docs/OWNERSHIP.md` | Which phase may edit which paths, so parallel agents don't overwrite each other |
| `.claude/agents/*.md` | 10 role subagents: scaffolder, backend/provider/scoring/frontend builders, module & e2e testers, infra, security reviewer, integrator |
| `.claude/settings.json` | Pre-approved commands, deny rules (no pushes to main, no force push, no cdk deploy, no reading .env), hooks |
| `.claude/hooks/` | `guard-bash.sh`, `guard-files.sh` (block risky commands / edits to PLAN.md, .env, applied migrations), `format-file.sh` (Prettier after edits) |
| `pipeline/` | Scripted pipeline: per-phase prompts, manifest, and runners for build → test → integrate → PR |
| `.env.example`, `.gitignore` | Env template and ignores |

## One-time setup
1. **Prereqs:** Node 20+, pnpm, Docker, git, `jq`, GitHub CLI `gh` (optional, opens PRs), Claude Code
   **v2.1.259 or later** (`claude --version`; the pipeline uses `--permission-prompts none`).
2. **Repo:**
   ```bash
   mkdir readiness-dashboard && cd readiness-dashboard && git init -b main
   unzip ~/Downloads/readiness-dashboard-claude-setup.zip -d .
   chmod +x .claude/hooks/*.sh pipeline/*.sh
   git add -A && git commit -m "chore: claude code setup kit"
   gh repo create readiness-dashboard --private --source . --push   # or add your own remote and push main
   cp .env.example .env    # fill in later; not needed for stages A–B
   ```
3. **Trust the folder once:** run `claude` in the repo and accept the workspace trust prompt, so
   project hooks and agent definitions load.

## Stage A: scaffold (interactive, ~30–60 min)
```bash
claude --agent scaffolder
> Read pipeline/phases/0.md and carry it out on main.
```
Review the result, then commit and push `main` yourself. Everything after this branches from it.

## Stages B–F: the pipeline
```bash
DRY_RUN=1 pipeline/run-stage.sh B   # sanity check
pipeline/run-stage.sh B             # build, test, integrate, open PR
# review + merge the PR on GitHub, then:
git pull && pipeline/run-stage.sh C
# ...D, E, F the same way
```
Start with stage B. It includes the scoring engine, which is the riskiest and most valuable
code, so you see real output and real cost before committing to the rest.

## Decisions I made that PLAN.md left open (change freely)
- **pnpm** workspaces, package scope `@rd/*`, **node-pg-migrate** with SQL migrations, Docker Postgres 16 locally.
- Scoring engine (part of PLAN phase 5) is split into **5a** (pure package, stage B) and **5b**
  (service wiring + API, stage D), so phase 4 can reuse the math rather than duplicating it.
- Phase 3 is split into **3a Oura** and **3b Terra** so they build in parallel.
- `trends.window` is a reserved word in Postgres; phase 5b is told to quote it or rename to `trend_window`.
- Models: Opus for the scoring engine, integrator and security review; Sonnet for everything else.
  Change the `model:` line in any `.claude/agents/*.md` file.

## Before you trust it with a long unattended run
- Confirm PLAN §17 items for phase 5a (EF formula, z-score dead zone) — the scoring agent will
  also list formula decisions in its report.
- Use the **in-session alternative** if you'd rather watch: open `claude` and say
  *"ultracode: run stage C from pipeline/README.md — one agent per phase in its own worktree,
  then a module-tester per branch, then the integrator."* Save a run you like with `s` in `/workflows`.
- Cost: each stage is several full agent sessions. Check `pipeline/logs/*.json` (`total_cost_usd`)
  after stage B to estimate the rest.
