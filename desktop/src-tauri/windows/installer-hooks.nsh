; chan-desktop's NSIS uninstall steps, named by
; bundle.windows.nsis.installerHooks in tauri.windows.conf.json and
; tauri.ci.windows.conf.json.
;
; The bundler's template includes this file near its top and inserts each
; NSIS_HOOK_* macro inside `Section Uninstall`, so a macro body reads the
; template's globals ($UpdateMode, $DeleteAppDataCheckboxState) and defines
; (MANUKEY, MANUPRODUCTKEY) where it is inserted. The functions here are
; compiled where the file is included, before those exist, so they use only
; their arguments and registers. Nothing here opens a window or a prompt: a
; silent uninstall stays silent. The desktop's tests (src/cs_install.rs) pin
; the shape of the macros and the Path rule the functions implement.

; The desktop's shim directory (src/cs_install.rs, shim_bin_dir): a fixed
; per-user path, not $INSTDIR\bin, so an install the user pointed elsewhere
; keeps its shims here too.
!define CHAN_SHIM_DIR "$LOCALAPPDATA\chan\bin"

; Deletes ${CHAN_SHIM_DIR}\<name> when it is a regular file whose second line
; starts with <marker>: the ownership rule the desktop writes its shims under
; (WRAPPER_OWNS and POSIX_OWNS). A file without the marker is the user's.
!macro chanRemoveOwnedShim name marker
  System::Call 'kernel32::GetFileAttributesW(w "${CHAN_SHIM_DIR}\${name}") i .R0'
  ; -1 is a missing file; a directory (0x10) or a link (0x400, a reparse
  ; point) is not a shim the desktop wrote.
  IntOp $R1 $R0 & 0x410
  ${If} $R0 <> -1
  ${AndIf} $R1 = 0
    ClearErrors
    FileOpen $R2 "${CHAN_SHIM_DIR}\${name}" r
    ${IfNot} ${Errors}
      FileRead $R2 $R3
      FileRead $R2 $R3
      FileClose $R2
      StrLen $R1 "${marker}"
      StrCpy $R3 $R3 $R1
      ${If} $R3 S== "${marker}"
        Delete "${CHAN_SHIM_DIR}\${name}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; The normalization the desktop applies to a Path entry before comparing it
; with its shim directory (entry_names_dir): the spaces and tabs around it and
; any trailing `\` or `/` go. In: the entry. Out: the normalized entry.
Function un.chanPathEntryKey
  Exch $0
  Push $1
  ${Do}
    StrCpy $1 $0 1
    ${If} $1 == " "
    ${OrIf} $1 == "$\t"
      StrCpy $0 $0 "" 1
    ${Else}
      ${ExitDo}
    ${EndIf}
  ${Loop}
  ${Do}
    StrCpy $1 $0 1 -1
    ${If} $1 == " "
    ${OrIf} $1 == "$\t"
      StrCpy $0 $0 -1
    ${Else}
      ${ExitDo}
    ${EndIf}
  ${Loop}
  ${Do}
    StrCpy $1 $0 1 -1
    ${If} $1 == "\"
    ${OrIf} $1 == "/"
      StrCpy $0 $0 -1
    ${Else}
      ${ExitDo}
    ${EndIf}
  ${Loop}
  Pop $1
  Exch $0
FunctionEnd

; A Path value without the entries that name a directory: each entry is
; normalized by un.chanPathEntryKey and compared case-insensitively, and the
; other entries are joined with `;` byte for byte and in order. That is the
; inverse of the desktop's append (path_with_dir_appended), which keeps a
; trailing `;` after the entry it adds.
; In: the value, then the directory, pushed in that order. Out: the new
; value, then on top the number of entries removed.
Function un.chanPathWithout
  Exch $1 ; the directory
  Exch
  Exch $0 ; the value
  Push $2 ; the kept entries, joined
  Push $3 ; the entry being read
  Push $4 ; the read position
  Push $5 ; the character at the read position
  Push $6 ; the number of entries removed
  Push $7 ; 1 once an entry is kept
  Push $8 ; the value's length
  Push $9 ; the normalized directory

  Push $1
  Call un.chanPathEntryKey
  Pop $9
  StrCpy $2 ""
  StrCpy $3 ""
  StrCpy $4 0
  StrCpy $6 0
  StrCpy $7 0
  StrLen $8 $0
  ${Do}
    StrCpy $5 $0 1 $4
    ${If} $4 >= $8
    ${OrIf} $5 == ";"
      Push $3
      Call un.chanPathEntryKey
      Pop $1
      ${If} $1 == $9
        IntOp $6 $6 + 1
      ${Else}
        ${If} $7 = 1
          StrCpy $2 "$2;"
        ${EndIf}
        StrCpy $2 "$2$3"
        StrCpy $7 1
      ${EndIf}
      StrCpy $3 ""
      ${If} $4 >= $8
        ${ExitDo}
      ${EndIf}
    ${Else}
      StrCpy $3 "$3$5"
    ${EndIf}
    IntOp $4 $4 + 1
  ${Loop}

  StrCpy $0 $2
  StrCpy $1 $6
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Exch $0
  Exch
  Exch $1
FunctionEnd

; Every uninstall that is not the self-updater's (`/UPDATE`) removes what the
; install and the desktop made that points at the install, after the
; template's own steps.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ; The desktop writes its shims and its Path entry for the current user.
    SetShellVarContext current

    !insertmacro chanRemoveOwnedShim "chan.cmd" ":: chan-desktop"
    !insertmacro chanRemoveOwnedShim "chan" "# chan-desktop"
    !insertmacro chanRemoveOwnedShim "cs.cmd" ":: chan-desktop"
    !insertmacro chanRemoveOwnedShim "cs" "# chan-desktop"
    ; Without recursion, so a directory holding anything else stays. On the
    ; default layout the second is $INSTDIR, which the template cannot remove
    ; while the shim directory is inside it.
    RMDir "${CHAN_SHIM_DIR}"
    RMDir "$LOCALAPPDATA\chan"

    ; The user Path entry the desktop added, removed by name, so an entry an
    ; older desktop added without a record goes too and every other entry
    ; stays. The value is read unexpanded, and only when it fits an NSIS
    ; string, so it is never written back truncated; it keeps its type.
    ; RegGetValueW(HKEY_CURRENT_USER, "Environment", "Path",
    ;   RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND, &type, NULL, &size)
    System::Call 'advapi32::RegGetValueW(p 0x80000001, w "Environment", w "Path", i 0x10000006, *i .R1, p 0, *i .R2) i .R0'
    IntOp $R3 ${NSIS_MAX_STRLEN} * 2
    ClearErrors
    ReadRegStr $R4 HKCU "Environment" "Path"
    ${If} $R0 = 0
    ${AndIf} $R2 < $R3
    ${AndIfNot} ${Errors}
      Push $R4
      Push "${CHAN_SHIM_DIR}"
      Call un.chanPathWithout
      Pop $R5 ; the number of entries removed
      Pop $R6 ; the value without them
      ${If} $R5 > 0
        ; An emptied value goes, unless the desktop's record says the value
        ; was there before the desktop wrote it.
        StrCpy $R8 1
        ClearErrors
        ReadRegDWORD $R7 HKCU "${MANUPRODUCTKEY}" "PathCreated"
        ${IfNot} ${Errors}
        ${AndIf} $R7 = 0
          StrCpy $R8 0
        ${EndIf}
        ${If} $R6 == ""
        ${AndIf} $R8 = 1
          DeleteRegValue HKCU "Environment" "Path"
        ${ElseIf} $R1 = 2
          WriteRegExpandStr HKCU "Environment" "Path" $R6
        ${Else}
          WriteRegStr HKCU "Environment" "Path" $R6
        ${EndIf}
        ; As the desktop does after its append, so a shell opened afterwards
        ; no longer sees the entry.
        SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
      ${EndIf}
    ${EndIf}

    ; The installer's key, with the desktop's record in it, whatever the
    ; state choice. A later installer then proposes the default location.
    DeleteRegKey HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    ; The state choice: the template removes the webview data under
    ; ${BUNDLEID}; the chan home goes with it. A CHAN_HOME set elsewhere is
    ; not followed.
    ${If} $DeleteAppDataCheckboxState = 1
      RMDir /r "$PROFILE\.chan"
    ${EndIf}
  ${EndIf}
!macroend
