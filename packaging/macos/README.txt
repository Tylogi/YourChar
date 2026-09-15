YourChar for macOS
==================

Open YourChar.app to start the private loopback service and use YourChar in its
native macOS window. The app contains its own Apple Silicon Node.js runtime;
Node.js does not need to be installed separately.

On a fresh installation, YourChar creates and selects Kurisu (红莉栖), including
her bundled avatar, as the default character so you can start chatting
immediately after configuring a model. Existing application data and character
choices are left unchanged.

Application data:
  ~/Library/Application Support/YourChar

Logs:
  ~/Library/Logs/YourChar/YourChar.log

Use the YourChar menu to open the interface in your default browser, reveal the
data folder, or reveal the log file. Quitting the app gracefully stops the
service started by this app. If a compatible YourChar service is already
listening on 127.0.0.1:8765, the app attaches without taking ownership of it.

macOS limitations
-----------------

The sandboxed Shell, local MarkItDown worker, and sandboxed TypeScript LSP use
Linux Bubblewrap and are unavailable in this macOS build. Core conversations,
memory, characters, worlds, schedules, reminders, model providers, Workspace
file operations, and supported network integrations remain available.

Signing
-------

Development builds are ad-hoc signed and are not notarized. A public download
should be signed with an Apple Developer ID Application certificate and
notarized before distribution.

YourChar is licensed under MIT. See the bundled LICENSE and
THIRD_PARTY_NOTICES.md. The embedded Node.js runtime retains its own LICENSE.
