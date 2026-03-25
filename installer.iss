; ==========================================================
; Codai Pro — Inno Setup Installer Script
; Offline AI Coding Assistant for Legacy Hardware
; ==========================================================
;
; PREREQUISITES:
;   1. Install Inno Setup 6.x from https://jrsoftware.org/isinfo.php
;   2. Build Codai.exe first:  pyinstaller Codai.spec
;   3. Open this file in Inno Setup Compiler and click "Compile"
;
; OUTPUT:
;   Creates "CodaiPro_Setup.exe" in the build\installer\ folder
;
; ==========================================================

#define MyAppName "Codai Pro"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Codai"
#define MyAppURL "https://github.com/YOUR_USERNAME/codai"
#define MyAppExeName "run.bat"
#define MyAppIcon "ui\logo.png"

[Setup]
; Unique app identifier (generate a new GUID for your project at https://www.guidgenerator.com/)
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}

; Install location
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}

; Allow user to choose install directory
AllowNoIcons=yes
DisableProgramGroupPage=yes

; Output installer settings
OutputDir=build\installer
OutputBaseFilename=CodaiPro_Setup_{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes

; Visual settings
SetupIconFile=ui\logo.ico
WizardStyle=modern
WizardSizePercent=110

; Privileges — does NOT require admin (portable-friendly)
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

; Misc
DisableWelcomePage=no
LicenseFile=LICENSE
InfoAfterFile=readme.md

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checked
Name: "quicklaunchicon"; Description: "Create a Quick Launch icon"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Main executable
Source: "Codai.exe"; DestDir: "{app}"; Flags: ignoreversion

; Launcher script
Source: "run.bat"; DestDir: "{app}"; Flags: ignoreversion

; Python backend modules
Source: "dev\__init__.py"; DestDir: "{app}\dev"; Flags: ignoreversion
Source: "dev\config.py"; DestDir: "{app}\dev"; Flags: ignoreversion
Source: "dev\system.py"; DestDir: "{app}\dev"; Flags: ignoreversion
Source: "dev\engine.py"; DestDir: "{app}\dev"; Flags: ignoreversion
Source: "dev\controller.py"; DestDir: "{app}\dev"; Flags: ignoreversion
Source: "dev\requirements.txt"; DestDir: "{app}\dev"; Flags: ignoreversion

; Engine binaries (all DLLs and EXEs)
Source: "engine\*"; DestDir: "{app}\engine"; Flags: ignoreversion recursesubdirs

; AI Model (large file — user may want to download separately)
Source: "models\*.gguf"; DestDir: "{app}\models"; Flags: ignoreversion external skipifsourcedoesntexist

; Frontend UI
Source: "ui\index.html"; DestDir: "{app}\ui"; Flags: ignoreversion
Source: "ui\app.js"; DestDir: "{app}\ui"; Flags: ignoreversion
Source: "ui\styles.css"; DestDir: "{app}\ui"; Flags: ignoreversion
Source: "ui\logo.png"; DestDir: "{app}\ui"; Flags: ignoreversion

; Documentation
Source: "readme.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "docs\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs

; PyInstaller spec (for developers)
Source: "Codai.spec"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; Create logs directory with write permission
Name: "{app}\logs"; Permissions: users-modify
; Create models directory (in case model is downloaded later)
Name: "{app}\models"; Permissions: users-modify

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\ui\logo.png"; Comment: "Launch Codai Pro - Offline AI Assistant"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\ui\logo.png"; Tasks: desktopicon; Comment: "Launch Codai Pro"

[Run]
; Option to launch after install
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent shellexec

[UninstallDelete]
; Clean up generated files on uninstall
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\dev\__pycache__"

[Messages]
WelcomeLabel2=This will install [name/ver] on your computer.%n%nCodai Pro is a 100%% offline AI coding assistant that runs entirely on your CPU. No internet required.%n%nDesigned for legacy hardware (2-4 GB RAM).

[Code]
// Check if Codai is already running before install
function InitializeSetup(): Boolean;
var
  LockFile: String;
begin
  Result := True;
  LockFile := ExpandConstant('{autopf}\{#MyAppName}\logs\codai.lock');
  if FileExists(LockFile) then
  begin
    if MsgBox('Codai Pro may be running. Please close it before installing.' + #13#10 + #13#10 +
              'Continue anyway?', mbConfirmation, MB_YESNO) = IDNO then
    begin
      Result := False;
    end;
  end;
end;
