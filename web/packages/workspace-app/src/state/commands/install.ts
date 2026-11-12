// Load every command module for its registration side effect. Import
// this once (the launcher does) before reading the catalog, so all
// categories are present. Each module calls registerCommands at load.

import "./core";
import "./global";
import "./settings";
import "./workspace";
import "./search";
import "./diagram";
import "./slides";
import "./editor";
import "./browser";
import "./tabs";
import "./terminal";
import "./dashboard";
import "./graph";
import "./panes";
import "./paneTree";
import "./extension";
