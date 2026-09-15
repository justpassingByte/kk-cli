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

### 2. Installing an Offline Kit (Bypass Login / License)

Install a kit into your project directly from an exported archive or folder without needing remote authentication:

```bash
# Navigate to your project directory
cd /path/to/your/project

# Install from local archive
kk init --from ./engineer.tar.gz -y
```

### 3. Normal Online Installation

```bash
kk init engineer --runtime claude-code --scope project -y
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
