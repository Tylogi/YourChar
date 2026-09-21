; YourChar installer script.
;
; This file is a template. packaging/windows/installer/build.ps1 substitutes the
; @@PLACEHOLDER@@ tokens, stages the launcher and the WSL payload next to it and
; compiles the result with ISCC.
;
; The installer only copies files, creates shortcuts and registers an
; uninstaller. It deliberately knows nothing about WSL: importing, refreshing
; and removing the private runtime belongs to YourChar.exe, which is the only
; component that can tell a YourChar distribution from someone else's. That is
; also why installing, repairing and updating can never touch user data.

[Setup]
; Stable identity: reinstalling or repairing must update the same entry in
; Apps & Features instead of creating a second one.
AppId={{0F1B6C2A-8D34-4E57-9B21-6C4A7D3E5F82}
AppName=YourChar
AppVersion=@@VERSION@@
AppVerName=YourChar @@VERSION@@
AppPublisher=YourChar
AppPublisherURL=https://github.com/Tylogi/YourChar
VersionInfoVersion=@@VERSION@@

; Per-user install: no administrator rights, no UAC prompt, no Program Files.
DefaultDirName={localappdata}\Programs\YourChar
DefaultGroupName=YourChar
DisableDirPage=auto
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
UninstallDisplayName=YourChar
UninstallDisplayIcon={app}\YourChar.exe
AllowNoIcons=yes
WizardStyle=modern
SetupLogging=yes
MinVersion=10.0.18362

; Warn instead of half-installing while the launcher is running.
AppMutex=Local\YourCharLauncherSingleInstance

OutputDir=@@OUTPUTDIR@@
OutputBaseFilename=YourChar-Setup-@@VERSION@@
; The WSL payload is a 300 MB .tar.gz. Compressing it again would cost minutes
; and save nothing, so the setup stays a straight container.
Compression=none
SolidCompression=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
Source: "@@STAGE@@\YourChar.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "@@STAGE@@\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion nocompression recursesubdirs

[Icons]
Name: "{autoprograms}\YourChar"; Filename: "{app}\YourChar.exe"; Comment: "YourChar"
Name: "{autodesktop}\YourChar"; Filename: "{app}\YourChar.exe"; Comment: "YourChar"; Tasks: desktopicon

[Run]
Filename: "{app}\YourChar.exe"; Description: "{cm:LaunchProgram,YourChar}"; Flags: nowait postinstall skipifsilent

[Code]
const
  KeepNote = 'YourChar keeps your conversations, characters, memory, usage and settings inside its own private Linux runtime.';

var
  DeleteData: Boolean;

function HasSwitch(const Name: String): Boolean;
var
  Index: Integer;
begin
  Result := False;
  for Index := 1 to ParamCount do
  begin
    if Uppercase(ParamStr(Index)) = Uppercase(Name) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

{ The choice is made before any file is removed, while YourChar.exe is still on
  disk to do the removal itself. Keeping the data is the default: the user has
  to pick "No" on purpose to lose it. }
function InitializeUninstall(): Boolean;
var
  Answer: Integer;
  Code: Integer;
  Silent: Boolean;
  DeleteOk: Boolean;
begin
  Result := True;
  Silent := UninstallSilent;
  DeleteData := HasSwitch('/DELETEDATA');

  if not Silent then
  begin
    Answer := MsgBox(KeepNote + #13#10#13#10 +
      'Keep your YourChar data?' + #13#10#13#10 +
      'Yes: uninstall YourChar and keep my data' + #13#10 +
      'No: uninstall YourChar and delete my data' + #13#10 +
      'Cancel: keep YourChar installed',
      mbConfirmation, MB_YESNOCANCEL);
    if Answer = IDCANCEL then
    begin
      Result := False;
      Exit;
    end;
    DeleteData := (Answer = IDNO);
  end;

  if DeleteData then
  begin
    { Failing to remove the runtime must not trap the user in an installation
      that can no longer be uninstalled: the program files are removed either
      way, and data that is still there is picked up by installing again. }
    Code := 0;
    DeleteOk := Exec(ExpandConstant('{app}\YourChar.exe'), '--remove-data', '',
                     SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
    if not DeleteOk then
    begin
      if not Silent then
        MsgBox('YourChar could not remove its runtime and data, so they were left in place.' + #13#10#13#10 +
               'The program files are uninstalled anyway. Install YourChar again to use the data that is ' +
               'still there, or remove the YourChar WSL distribution yourself.', mbError, MB_OK);
    end;
  end
  else
  begin
    if not Silent then
      MsgBox('Your data was kept. Install YourChar again to keep using it.', mbInformation, MB_OK);
  end;
end;
