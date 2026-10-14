/**
 * Most of this code is from Zotero team's official Make It Red example[1]
 * or the Zotero 7 documentation[2].
 * [1] https://github.com/zotero/make-it-red
 * [2] https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle;

/**
 * 加载 addon/prefs.js 里的默认值到默认分支。Zotero 7 不会替插件自动加载
 * prefs.js,不做这步的话新装用户所有默认值都是空的(服务地址默认值
 * 不生效,getPref 拿到 undefined)。键名在构建产物里已是全前缀。
 */
function setDefaultPrefs(rootURI) {
  var branch = Services.prefs.getDefaultBranch("");
  var obj = {
    pref(name, v) {
      switch (typeof v) {
        case "boolean":
          branch.setBoolPref(name, v);
          break;
        case "string":
          branch.setStringPref(name, v);
          break;
        case "number":
          branch.setIntPref(name, v);
          break;
      }
    },
  };
  Services.scriptloader.loadSubScript(rootURI + "prefs.js", obj);
}

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", rootURI + "content/"],
  ]);

  setDefaultPrefs(rootURI);

  /**
   * Global variables for plugin code.
   * The `_globalThis` is the global root variable of the plugin sandbox environment
   * and all child variables assigned to it is globally accessible.
   * See `src/index.ts` for details.
   */
  const ctx = { rootURI };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}/content/scripts/__addonRef__.js`,
    ctx,
  );
  await Zotero.__addonInstance__.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.__addonInstance__?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {}
