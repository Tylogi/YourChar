YourChar for Windows (WSL2 runtime payload)
==========================================

What this is
------------
This payload is a complete YourChar runtime for Windows: a WSL2 distribution
that already contains everything the backend needs. Importing it is the whole
setup. You do not install Node.js, Python, uv, MarkItDown or Bubblewrap, and you
do not need an Ubuntu distribution of your own.

Contents
--------
  /opt/yourchar/node/                     Node.js runtime
  /opt/yourchar/dist/                     built YourChar backend
  /opt/yourchar/node_modules/             runtime dependencies (no dev tools)
  /opt/yourchar/assets, /opt/yourchar/skills
  /opt/yourchar/services/markitdown/      document worker (worker.py)
  /opt/yourchar/services/markitdown/runtime/
                                          bundled CPython with MarkItDown,
                                          Magika and ONNX Runtime
  /opt/yourchar/bin/yourchar-backend      backend entry point
  /opt/yourchar/scripts/start-wsl-backend.sh
                                          preflight and start script
  /var/lib/yourchar/                      user data (state, memory, chats)
  /usr/bin/bwrap                          Bubblewrap, used to sandbox workers

Your data lives in /var/lib/yourchar and is deliberately kept out of
/opt/yourchar, so replacing the application payload never overwrites it.

Installing
----------
Import the distribution once. This does not need administrator rights:

  wsl --import YourChar "%LOCALAPPDATA%\YourChar\wsl" YourChar-<version>-wsl-amd64.tar.gz

Checking and starting
---------------------
  wsl -d YourChar --exec /opt/yourchar/bin/yourchar-backend --check
  wsl -d YourChar --exec /opt/yourchar/bin/yourchar-backend

Then open http://127.0.0.1:8765 in a browser. The backend binds to loopback
only. Stop it with Ctrl+C, or from another window:

  wsl --terminate YourChar

Updating
--------
Replace the application payload, not the distribution:

  wsl -d YourChar --exec tar -xzf /mnt/c/path/YourChar-<version>-wsl-amd64-app.tar.gz -C /opt/yourchar

User data is untouched. Restart the backend afterwards.

Removing
--------
  wsl --unregister YourChar

This deletes the distribution and with it /var/lib/yourchar. Export your data
first if you want to keep it.

Verification
------------
The distribution is imported and exercised as a whole during release checks:
the backend is started inside it, readiness is polled, a real model request is
sent, and document conversion is repeated to confirm the bundled runtime is
stable. SHA256SUMS.txt carries the digests of the published archives.

Not included yet
----------------
There is no Windows launcher or installer in this payload. Starting YourChar
still means running one wsl.exe command; the double-clickable application that
wraps it is the next step.
Windows launcher
----------------
packaging/windows/launcher/ holds YourChar.exe, the double-click entry point that
imports this payload into WSL2 and runs it. Build it with
`powershell -File packaging/windows/launcher/build.ps1` after building the payload.
See packaging/windows/launcher/README.md.
