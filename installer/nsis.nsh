; AI WorkMate NSIS extra steps.
; Uninstall must remove only the application binaries under $INSTDIR.
; Never delete DATA_ROOT, backups, exports, credential vault, or
; %LOCALAPPDATA%\AI-WorkMate models (Whisper / llama.cpp are user-installed).

!macro customUnInstall
  ; Intentionally empty of RMDir /r against user data, AppData, or LocalAppData.
  ; electron-builder already honors deleteAppDataOnUninstall=false.
!macroend
