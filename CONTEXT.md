# Chan Product Context

Canonical product language for the user-facing Chan runtime and its surfaces.

## Language

**Command launcher**:
Chan's single searchable action surface. It presents actions for the invoking window and its focused pane and tab before broader Computers actions.
_Avoid_: Computers command launcher, workspace command launcher

**Contextual deck**:
The command launcher's empty-query view. It orders actions for the focused tab, focused pane, and invoking window before Computers actions.
_Avoid_: Empty state, default results

**Computers scope**:
The computers, workspaces, and windows available to the command launcher. Outside Chan Desktop it is the invoking library; inside Chan Desktop it is the desktop's aggregate inventory.
_Avoid_: Global scope, remote desktop library

**Control terminal**:
A Desktop-owned terminal that runs a devserver's configured connect script and remains its diagnostic surface while the script is running or has failed.
_Avoid_: Remote terminal, devserver terminal

**Launcher entry mode**:
The initial scope requested when opening the command launcher. Contextual mode starts with the invoking tab, pane, and window; Computers mode starts with the Computers scope.
_Avoid_: Separate launcher, Computers launcher

**Launcher draft**:
The in-progress visibility, query, navigation path, selection, and recoverable action state associated with an invoking window and launcher entry mode. It survives hiding and webview reloads, but not closure of that window or Chan Desktop.
_Avoid_: Saved search, persistent launcher

**Deep search**:
Launcher search that ranks permitted actions and targets by relevance across nested levels and scopes while identifying each result's trusted path. It may skip browsing levels, but never a required argument or confirmation step.
_Avoid_: Submenu-only search

**Scoped query**:
Input sent only to the command source the user explicitly entered. Global launcher search remains local to its host and never fans out to remote windows.
_Avoid_: Query broadcast, federated query

**Library command capability**:
A short-lived authority bound to one live window that permits approved launcher reads and actions only within the invoking library. It inherits the caller's role and never grants Chan Desktop's aggregate Computers scope or exposes root launcher credentials.
_Avoid_: Launcher token, root token, Desktop capability
