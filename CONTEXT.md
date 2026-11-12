# Chan Product Context

Canonical product language for the user-facing Chan runtime and its surfaces.

## Language

**Command launcher**:
Chan's single searchable action surface. It presents actions for the focused tab, its pane, the invoking window and its workspace, then settings, before broader Computers actions.
_Avoid_: Computers command launcher, workspace command launcher

**Command title**:
The one name an action carries in the command launcher, in every menu, in the shortcut list and in Hybrid Nav help: a verb and its object in sentence case. A toggle is named for the thing and shows its state, and a setting carries its Settings label.
_Avoid_: Toggle X, Show/Hide X, a second name for one action

**Contextual deck**:
The command launcher's empty-query view with no scope chosen. Under a heading each, it lists the commands run recently, then every command that can run for the focused tab's application, its pane, the invoking window and its workspace, and ends with the ways into Settings and into Computers. The Settings and Computers scopes list in full what it only leads into.
_Avoid_: Empty state, default results

**App scope**:
The command launcher scope holding the actions of the application the focused tab runs, and named after that application. An extension tab contributes the commands that extension declares. What any tab can do (close, next, send to a side) belongs to the Pane scope.
_Avoid_: Tab scope, surface scope

**Settings scope**:
The command launcher scope listing every field of Settings under its section, in the field's own words. A toggle or a choice changes in place; any other field opens Settings on it.
_Avoid_: Preferences scope

**Computers scope**:
The computers, workspaces, windows, and gateways the command launcher lists. In a window it is the invoking library alone, as one machine; on the Computers screen it is everything that screen lists, which in Chan Desktop is the desktop's aggregate inventory. A Chan Desktop window leads from the first to the second through All computers.
_Avoid_: Global scope, remote desktop library

**Window list**:
The Computers scope's roster of the windows that exist, each listed once and carrying whether it is hidden. Choosing a window runs the first action that window offers, which is not the same for every window; the window's page, one level down, holds the rest.
_Avoid_: Window menu, Focus list

**Control terminal**:
A Desktop-owned terminal that runs a devserver's configured connect script and remains its diagnostic surface while the script is running or has failed.
_Avoid_: Remote terminal, devserver terminal

**Launcher draft**:
The in-progress visibility, query, scope, navigation path, selection, and recoverable action state of one window's command launcher. A webview reload restores an open launcher as it stood. Opening it again after a dismissal starts at the root and keeps the query alone, and a command that ran clears that too. It does not survive closure of that window or Chan Desktop.
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
