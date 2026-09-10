; Custom NSIS fragments merged into the electron-builder wizard.
; Included at global scope; only macro definitions belong here.
;
; Two jobs:
;   1. record the install for support diagnostics
;   2. on uninstall, clean up the two things that live OUTSIDE $INSTDIR —
;      the MSFS Community package the app copied in, and (opt-in) the
;      operator's settings/accounts in %APPDATA%.

!define AED_PKG_NAME "aus-emergency-dispatcher-objects"
!define AED_PKG_NAME_LEN 32           ; must match the string above, char for char
!define AED_DATA_DIR "aus-emergency-dispatcher"
; Written by main/packages.ts after every successful Community-folder install:
; one absolute package path per line.
!define AED_PKG_MANIFEST "installed-msfs-packages.txt"

!macro customInstall
  WriteRegStr SHCTX "Software\ActuallyLeviticus\${PRODUCT_NAME}" "InstallPath" "$INSTDIR"
  WriteRegStr SHCTX "Software\ActuallyLeviticus\${PRODUCT_NAME}" "Version" "${VERSION}"
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\ActuallyLeviticus\${PRODUCT_NAME}"

  ; --- 1. remove the MSFS Community package(s) we installed ------------------
  ; Each line is a full path ending in the package folder name. We refuse to
  ; delete anything whose last ${AED_PKG_NAME_LEN} characters are not exactly
  ; that name, so a truncated or hand-edited manifest can't take out a
  ; Community folder (or worse) with it.
  StrCpy $R8 "$APPDATA\${AED_DATA_DIR}\${AED_PKG_MANIFEST}"
  IfFileExists "$R8" 0 aed_pkg_done

  ClearErrors
  FileOpen $R9 "$R8" r
  IfErrors aed_pkg_done

  aed_pkg_loop:
    ClearErrors
    FileRead $R9 $R0
    IfErrors aed_pkg_close

    ; strip the trailing CR/LF FileRead leaves on the line
    aed_trim_loop:
      StrCpy $R1 $R0 1 -1
      StrCmp $R1 "$\r" aed_trim_cut
      StrCmp $R1 "$\n" aed_trim_cut
      Goto aed_trim_done
    aed_trim_cut:
      StrCpy $R0 $R0 -1
      Goto aed_trim_loop
    aed_trim_done:

    StrCmp $R0 "" aed_pkg_loop                    ; blank line
    StrCpy $R2 $R0 "" -${AED_PKG_NAME_LEN}        ; last N chars
    StrCmp $R2 "${AED_PKG_NAME}" 0 aed_pkg_loop   ; not ours -> leave it alone
    IfFileExists "$R0\manifest.json" 0 aed_pkg_loop
    RMDir /r "$R0"
    Goto aed_pkg_loop

  aed_pkg_close:
    FileClose $R9
    Delete "$R8"
  aed_pkg_done:

  ; --- 2. offer to remove settings, accounts and local state ----------------
  IfSilent aed_data_done
  IfFileExists "$APPDATA\${AED_DATA_DIR}\*.*" 0 aed_data_done
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Also remove your Aus Emergency Dispatcher settings, operator accounts and sign-in?$\r$\n$\r$\nChoose No to keep them for a future reinstall." \
    /SD IDNO IDNO aed_data_done
  RMDir /r "$APPDATA\${AED_DATA_DIR}"
  aed_data_done:
!macroend
