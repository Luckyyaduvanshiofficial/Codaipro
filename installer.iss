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
#define MyAppURL "https://github.com/Luckyyaduvanshiofficial/Codaipro"
#define MyAppExeName "run.bat"
#define MyAppIcon "docs\image\codai.ico"
#define BundledModel AddBackslash(SourcePath) + "models\\gemma-3-1b-it-Q4_K_M.gguf"

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
SetupIconFile={#MyAppIcon}
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

#if DirExists("models") == 0
  #error "The models folder is missing. Add the bundled GGUF model before compiling the installer."
#endif

#if FileExists(BundledModel) == 0
  #error "The bundled model file models\\gemma-3-1b-it-Q4_K_M.gguf is missing relative to the installer script. Add it before compiling the installer."
#endif

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

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
Source: "dev\proxy.py"; DestDir: "{app}\dev"; Flags: ignoreversion
Source: "dev\controller.py"; DestDir: "{app}\dev"; Flags: ignoreversion
Source: "dev\requirements.txt"; DestDir: "{app}\dev"; Flags: ignoreversion

; Engine binaries (all DLLs and EXEs)
Source: "engine\*"; DestDir: "{app}\engine"; Flags: ignoreversion recursesubdirs

; AI Model (large file — user may want to download separately)
Source: "models\*.gguf"; DestDir: "{app}\models"; Flags: ignoreversion skipifsourcedoesntexist

; Frontend UI
Source: "ui\index.html"; DestDir: "{app}\ui"; Flags: ignoreversion
Source: "ui\app.js"; DestDir: "{app}\ui"; Flags: ignoreversion
Source: "ui\styles.css"; DestDir: "{app}\ui"; Flags: ignoreversion
Source: "ui\logs.html"; DestDir: "{app}\ui"; Flags: ignoreversion
Source: "ui\codai.ico"; DestDir: "{app}\ui"; Flags: ignoreversion
Source: "ui\logo.ico"; DestDir: "{app}\ui"; Flags: ignoreversion
Source: "ui\logo.png"; DestDir: "{app}\ui"; Flags: ignoreversion

; Documentation
Source: "Documentation.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "help.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "kill.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "config.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "readme.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "docs\contributor-project-info.md"; DestDir: "{app}\docs"; Flags: ignoreversion
Source: "docs\docs_Plan.md"; DestDir: "{app}\docs"; Flags: ignoreversion
Source: "docs\prd.md"; DestDir: "{app}\docs"; Flags: ignoreversion

; PyInstaller spec (for developers)
Source: "Codai.spec"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; Create logs directory with write permission
Name: "{app}\logs"; Permissions: users-modify
; Create models directory (in case model is downloaded later)
Name: "{app}\models"; Permissions: users-modify

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\ui\codai.ico"; Comment: "Launch Codai Pro - Offline AI Assistant"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\ui\codai.ico"; Tasks: desktopicon; Comment: "Launch Codai Pro"

[Run]
; Option to launch after install
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent shellexec

[UninstallDelete]
; Clean up generated files on uninstall
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\dev\__pycache__"

[Messages]
WelcomeLabel2=This will install [name/ver] on your computer.%n%nCodai Pro is a local offline AI coding assistant that serves its UI in your browser and runs its inference engine on your machine.%n%nDuring development, the Python runtime is the primary source of truth, while Codai.exe is optional packaged convenience.
