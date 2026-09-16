# KK CLI (`kk`)

`kk` is a command-line tool for installing, exporting, updating, diagnosing, and managing AgentKit kits for AI coding runtimes (including **Antigravity / AGY**, **Claude Code**, **Codex**, and **Cursor**).

---

## 🚀 Installation

### Option 1: Install directly via GitHub (Recommended)

```bash
npm install --global github:justpassingByte/kk-cli
```

### Option 2: Clone and build locally

```bash
git clone https://github.com/justpassingByte/kk-cli.git
cd kk-cli
npm install
npm run build
npm link
```

> **Requirements:** Node.js `^22.14.0` or `>=24.0.0`.

---

## ⚡ Quick Start

### 1. Exporting a Kit (On licensed device)

Download and save a verified kit archive to a local file:

```bash
# Login with your account
kk login

# Export the engineer kit to a local tarball
kk export engineer --output ./engineer.tar.gz
```

### 2. Installing for Antigravity (AGY / Gemini)

Install skills, rules, and subagents directly into Antigravity structure (`.agents/`) without requiring Claude Code CLI:

```bash
# Install into the current project
kk init engineer --runtime agy --from ./engineer.tar.gz --yes

# Install into a specific project directory
kk init engineer --runtime agy --from ./engineer.tar.gz --project-dir "/path/to/project" --yes

# Install globally for all Antigravity projects
kk init engineer --runtime agy --from ./engineer.tar.gz --scope global --yes
```

> **Note on Antigravity Slash Commands:** 
> When installing for `agy`, `kk` automatically generates `.agents/rules/commands.md` mapping all 65+ kit skills to custom Slash Commands (e.g. `/code-review`, `/debug`, `/backend-development`, `/databases`, `/git`, `/orchestrate`, etc.).

### 3. Installing for Claude Code (Online / Offline)

```bash
# Online install for Claude Code
kk init engineer --runtime claude-code --scope project --yes

# Offline install for Claude Code from archive
kk init engineer --runtime claude-code --from ./engineer.tar.gz --yes
```

---

## 📖 Commands Reference

| Command | Description |
| :--- | :--- |
| `kk login` | Log in with an email OTP or API key. |
| `kk logout` | Revoke active session and clear saved credentials. |
| `kk export [kit]` | Download and export a verified kit archive to a local file (`--output <path>`). |
| `kk init [kit]` | Install or update an AgentKit kit (supports `--from <path>` for offline installs). |
| `kk uninstall [kit]` | Safely remove an installed kit with ownership verification. |
| `kk update` | Update the CLI runtime and all installed kits. |
| `kk migrate` | Safely migrate from legacy ClaudeKit (`ck`) and Go runtime. |
| `kk doctor` | Run environment diagnostics and inspect runtime health (`--report file\|github\|email`). |

---

## ⚙️ Global Options

- `-y, --yes`: Automatically confirm proposed operations.
- `--no-interactive`: Never prompt for interactive input.
- `--json`: Emit stable machine-readable JSON output.
- `-q, --quiet`: Only print error messages.
- `-V, --verbose`: Show detailed diagnostic logs.

---

## 🛡 License

MIT License.
