# Oddzilla — Shared Claude Code Server

A single XFCE desktop on a Hetzner CPX22 that multiple collaborators can share. When two or more people connect at the same time, they all see **the same desktop** and can type into **the same Claude Code instance** — **at any client window size**.

## What's on the server

- **Host:** `178.104.174.24`
- **OS:** Ubuntu 24.04.3 LTS
- **Desktop:** XFCE 4.18 running on a persistent TigerVNC display (`:1`, 1920×1080)
- **Remote access:**
  - **TigerVNC** on `127.0.0.1:5901`  (shared-session mode)
  - **noVNC** (browser client) on `127.0.0.1:6080`
  - Both bound to **localhost only** — reachable only through an SSH tunnel
- **Shared Linux user:** `team`  (sudo)
- **Installed:** Node.js 22, Claude Code CLI 2.1.x, **VS Code 1.116** with the **Claude Code extension (anthropic.claude-code) pre-installed for `team`**, **Firefox 149** (from Mozilla's APT repo, not snap), XFCE, xfce4-terminal
- **Firewall:** UFW — only port 22 (SSH) open to the internet

### Why VNC (not RDP)

VNC treats every connection to the same display as a **view onto one running X session**. Client window size is independent of the server resolution — each person can resize/scale their VNC window however they like, and they all see the same desktop, cursor, and apps. No "everyone must use the same resolution" rule.

## Credentials

- **VNC password** (used by all VNC clients & noVNC): `2F2lQS9zR9Sc`
- **SSH:** key-based. Every collaborator's public key must be appended to `/home/team/.ssh/authorized_keys` (see "Adding a collaborator").

> The VNC service is not reachable from the public internet. You must establish the SSH tunnel first; the VNC password is a second layer on top of the SSH layer.

---

## How collaborators connect

There are **two ways** — pick whichever is easiest. Both require the same SSH tunnel.

### Step 1 — SSH tunnel (everyone)

Open a terminal and run:

```bash
ssh -N -L 5901:localhost:5901 -L 6080:localhost:6080 team@178.104.174.24
```

Leave this terminal open for the whole session. (If either port is busy locally, change the left number, e.g. `-L 15901:localhost:5901`, and use that port in your client.)

### Step 2a — Browser (no install required) — **recommended for most collaborators**

Once the tunnel is up, open in any browser:

> **http://localhost:6080/vnc.html?autoconnect=1&resize=scale**

Click **Connect** (if not auto-connected), enter the VNC password above. The `resize=scale` option makes the desktop stretch to fill your browser window — zoom with Ctrl+scroll.

Useful noVNC URL flags:
- `resize=scale` — scale to window (recommended)
- `resize=remote` — request the server to resize (won't work; our server has a fixed virtual screen)
- `view_only=true` — watch-only, no input

### Step 2b — Native VNC client

| OS | Client | Install |
| --- | --- | --- |
| **Windows** | **TigerVNC Viewer** | [Download](https://github.com/TigerVNC/tigervnc/releases) the `*_64.exe` |
| **Windows/macOS/Linux/iOS/Android** | **RealVNC Viewer** | [realvnc.com/download/viewer](https://www.realvnc.com/download/viewer/) (free for personal use) |
| **macOS** | Built-in **Screen Sharing** | Finder → `⌘K` → `vnc://localhost:5901` |
| **Linux** | **Remmina** | `apt install remmina remmina-plugin-vnc` |

Connection details:
- **Server / address:** `localhost:5901` (or `localhost::5901` in some clients)
- **Password:** (VNC password above)
- Most clients default to "shared" mode. If yours asks: **enable "shared"**.
- Scale the local window however you like — the server desktop stays at 1920×1080, your client stretches or scrolls.

### Step 3 — Run Claude Code

Inside the shared XFCE desktop you have two options:

**A) VS Code with the Claude Code extension (GUI)**
- Applications menu → **Development → Visual Studio Code**
- The **Claude Code extension is already installed** for the `team` user.
- Open the Claude icon in the left activity bar, or press `Ctrl+Shift+P` → **Claude Code: Focus** to open the chat panel.

**B) Terminal CLI**
- Open **Terminal Emulator** from the menu (or right-click the desktop → Open Terminal Here) and run:
  ```
  claude
  ```

Either way, the first run will print a login URL. You can open it:
- **Inside the shared desktop** with Firefox (Applications menu → Internet → Firefox), or
- On your **own local machine's browser** if you prefer.

You can also use the full Claude Code web app in Firefox directly at **claude.ai/code**.

---

## Collaborative behavior

- The XFCE desktop runs continuously as a systemd service (`tigervncserver@:1`). It does **not** close when everyone disconnects — Claude Code and any other app keep running.
- Every VNC/noVNC connection attaches to the same display (:1) in shared mode — all cursors, keystrokes, and clipboards are multiplexed.
- Client window size and scaling are entirely client-side. Resize freely.

**To reset the desktop** (e.g. if something hangs):
```bash
ssh -i ~/.ssh/id_ed25519 team@178.104.174.24 'sudo systemctl restart tigervncserver@:1.service'
```

---

## Adding a collaborator

1. The collaborator generates a key on their machine (if they don't have one):
   ```bash
   ssh-keygen -t ed25519 -C "their-name"
   ```
2. They send you the **public** key (`~/.ssh/id_ed25519.pub`, one line).
3. Append it to the server:
   ```bash
   ssh -i ~/.ssh/id_ed25519 team@178.104.174.24 'cat >> ~/.ssh/authorized_keys' < their_pubkey_file
   ```

## Removing a collaborator

```bash
ssh -i ~/.ssh/id_ed25519 team@178.104.174.24 'nano ~/.ssh/authorized_keys'
# delete their line
```

---

## Admin / ops notes

- **VNC server unit:** `/lib/systemd/system/tigervncserver@.service`, user mapping in `/etc/tigervnc/vncserver.users` (`:1=team`).
- **VNC config:** `/home/team/.vnc/config` — geometry, `localhost=yes`, `alwaysshared=1`, `SecurityTypes=VncAuth`.
- **Xstartup:** `/home/team/.vnc/xstartup` launches XFCE under `dbus-launch`.
- **noVNC service:** `/etc/systemd/system/novnc.service` — `websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5901`.
- **xrdp** is still installed but **disabled**. Re-enable with `systemctl enable --now xrdp xrdp-sesman` if you ever want to fall back.
- **Change VNC password:**
  ```bash
  ssh -i ~/.ssh/id_ed25519 team@178.104.174.24
  vncpasswd        # prompts interactively
  sudo systemctl restart tigervncserver@:1.service
  ```
- **Change screen resolution:** edit `geometry=1920x1080` in `/home/team/.vnc/config`, then `sudo systemctl restart tigervncserver@:1.service`. Client window size is unaffected either way.
- **Swap:** 2 GB at `/swapfile` (in `/etc/fstab`).
- **Root access:** root's `authorized_keys` still contains `yupi1313@github`. Collaborators should always log in as `team`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ssh` tunnel says port is in use | Pick a different local port: `-L 15901:localhost:5901` and use `localhost:15901` in the VNC client. Same for 6080. |
| noVNC browser shows "Failed to connect" | Tunnel isn't up, or port mapping is wrong. Check the terminal where `ssh -N -L …` is running. |
| VNC viewer says "authentication failed" | Wrong password. See credentials above, or reset via `vncpasswd`. |
| Second person connects → first person's view frozen / kicked | Your VNC viewer didn't negotiate "shared". Open preferences, enable shared / multi-viewer mode, reconnect. TigerVNC's `alwaysshared=1` should prevent this, but some old clients still send `ExclusiveAccess`. |
| Claude Code login URL doesn't open in server's XFCE | Copy-paste it into your **local** browser — the server has no browser by design. |
| Desktop hung | `ssh team@… 'sudo systemctl restart tigervncserver@:1.service'`. |
