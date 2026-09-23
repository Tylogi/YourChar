# YourChar Windows installer

`build.ps1` turns the two things the earlier stages produced

- `packaging/windows/launcher/` - `YourChar.exe`, the double-click entry point
- `release/` (repository root) - the WSL2 runtime payload

into one file an ordinary Windows user can run:

```
packaging/windows/installer/out/YourChar-Setup-<version>.exe
```

## What the installer does

| Step | Behaviour |
| --- | --- |
| Privileges | per-user install, no administrator rights, no UAC prompt |
| Install directory | `%LOCALAPPDATA%\Programs\YourChar` |
| Files | `YourChar.exe` and `runtime\` (payload plus digest manifest) |
| Start Menu | `YourChar` |
| Desktop | `YourChar` (task is checked by default, can be cleared) |
| Apps & Features | one entry, `YourChar`, with a working uninstaller |
| After install | offers to start YourChar |

## What the installer deliberately does not do

- It never runs `wsl`, never imports, unregisters or terminates a distribution,
  and never deletes `%LOCALAPPDATA%\YourChar`. Only `YourChar.exe` touches WSL,
  because only `YourChar.exe` can tell a YourChar distribution from someone
  else's. This is what makes install, repair and update unable to lose data.
- It does not bundle a runtime for Node, Python, uv, MarkItDown or Bubblewrap on
  the Windows side. They live inside the distribution.
- No auto-update, no code signing, no WebView2 shell.

## Uninstalling

The uninstaller asks before it removes anything:

```
Keep your YourChar data?
  Yes    - uninstall YourChar and keep my data      (default)
  No     - uninstall YourChar and delete my data
  Cancel - keep YourChar installed
```

- **Keep** removes the program files and shortcuts. The private WSL distribution
  and `%LOCALAPPDATA%\YourChar` stay, so conversations, characters, memory,
  usage and settings survive a reinstall.
- **Delete** runs `YourChar.exe --remove-data`, which unregisters the
  distribution only if it carries the YourChar marker, then deletes
  `%LOCALAPPDATA%\YourChar`. Unrelated distributions are never touched.
- For scripted uninstalls the uninstaller accepts `/VERYSILENT /DELETEDATA`;
  without `/DELETEDATA` a silent uninstall keeps the data, like the default
  answer above.

## Repair and update

Both are the same, data-preserving operation: on every start `YourChar.exe`
compares the payload next to it with `%LOCALAPPDATA%\YourChar\applied-payload.txt`
and, when it changed, extracts `./opt/yourchar` from the payload into the
existing distribution. `/opt/yourchar` is the application and runtime layer;
user state lives in `/var/lib/yourchar` and is not part of the extracted
subtree. Running the installer again is a repair: it refreshes the program
files, and the next start refreshes the runtime to match.

`YourChar.exe --repair` does the same thing on demand, and never unregisters the
distribution. If the distribution is missing altogether it is imported from
scratch - there is no state to lose in that case.

## Requirements

- Windows 10 1903 or newer with WSL2 (the installer blocks older versions).
- WSL2 must be enabled. If it is not, `YourChar.exe` offers to run
  `wsl --install --no-distribution`, which needs one administrator approval and
  may need a restart.
- **Build time only:** Inno Setup 6 (`ISCC.exe`). Get it without installing
  anything:

  ```powershell
  curl.exe -L -o innosetup.exe https://ghfast.top/https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe
  .\innosetup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /PORTABLE=1 /DIR=C:\tools\innosetup
  $env:YOURCHAR_ISCC = 'C:\tools\innosetup\ISCC.exe'
  ```

  Verify the download first: the installer is Authenticode-signed by
  `Pyrsys B.V.`, the current Inno Setup release signer
  (`Get-AuthenticodeSignature .\innosetup.exe`).

## Building

```powershell
# payload, once
bash scripts/build-wsl-release.sh

# launcher and installer
npm run package:installer:windows
```

or directly:

```powershell
powershell -ExecutionPolicy Bypass -File packaging/windows/installer/build.ps1
powershell -ExecutionPolicy Bypass -File packaging/windows/installer/build.ps1 -PayloadDir D:\payloads -Version 0.2.0
```

The build fails rather than shipping a broken installer: the payload must be
listed in `SHA256SUMS.txt` and must match its digest, and ISCC must produce the
expected file.

## Layout

```
packaging/windows/installer/
  YourChar.iss   installer script template (@@VERSION@@, @@STAGE@@, @@OUTPUTDIR@@)
  build.ps1      stages the launcher and payload, generates the script, runs ISCC
  stage/         build output: generated script and the staged files (gitignored)
  out/           YourChar-Setup-<version>.exe and SHA256SUMS.txt (gitignored)
```
