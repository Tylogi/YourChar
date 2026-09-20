YourChar for macOS
==================

Open YourChar.app to start the private loopback service and use YourChar in its
native macOS window. Requires Apple Silicon and macOS 13 or newer. The app
contains Node.js and Python/MarkItDown; neither needs a separate installation.

On a fresh installation, YourChar creates and selects Kurisu (红莉栖), including
her bundled avatar, as the default character so you can start chatting
immediately after configuring a model. Existing application data and character
choices are left unchanged.

To upgrade, quit YourChar with Command-Q, back up the application data directory,
then replace /Applications/YourChar.app with this app. Do not delete the data
directory. Eject the installer disk image and launch the app from Applications.
Closing a window alone does not quit YourChar; also stop any separately running
YourChar backend before upgrading. There is no automatic updater in this preview.

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

Sandboxed Shell uses native macOS Seatbelt and requires host networking. It is
disabled until explicitly enabled in Agent management. Workspace file access
defaults to read/write; existing off/read-only choices are preserved.
MarkItDown and TypeScript LSP use a separate offline Seatbelt sandbox. Their
temporary storage and incognito state use verified private RAM volumes. If RAM
storage or sandbox enforcement is unavailable, these operations fail closed;
they never fall back to an unconfined worker or ordinary disk-backed incognito.
Closing incognito discards local state, but does not control model-provider
retention or operating-system swap. Core conversations, memory, characters,
worlds, schedules and network integrations remain available.

Signing
-------

This preview is ad-hoc signed and is not Apple-notarized. macOS may block its
first launch. Only if you trust the source and have verified the download,
follow Apple's instructions to allow this specific app; do not disable
Gatekeeper globally:
  https://support.apple.com/en-us/102445

A notarized distribution will require an Apple Developer ID Application
certificate and Apple's notarization service.

YourChar is licensed under MIT. See the bundled LICENSE and
THIRD_PARTY_NOTICES.md. The embedded Node.js runtime retains its own LICENSE.
