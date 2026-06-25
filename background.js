importScripts("public-suffix-data.js", "proxy-core.js");

const Core = globalThis.ProxyRouterCore;
const CONFIG_KEY = "proxyRouterConfigV2";
const LEGACY_CONFIG_KEY = "proxyRouterConfig";
const STATUS_KEY = "proxyRouterStatusV2";
const LOGS_KEY = "proxyRouterLogsV2";
const ORIGINAL_PROXY_KEY = "proxyRouterOriginalProxyV2";
const OVERRIDES_KEY = "proxyRouterTemporaryOverridesV2";
const MAX_LOGS = 300;
const TEST_URL = "https://example.com/";

let logQueue = Promise.resolve();
let testInProgress = false;
let activeTestProxy = null;
const authAttempts = new Map();

function nowIso() {
  return new Date().toISOString();
}

async function appendLog(level, type, message, meta = {}) {
  const safeMeta = { ...meta };
  delete safeMeta.password;
  logQueue = logQueue.then(async () => {
    const stored = await chrome.storage.local.get(LOGS_KEY);
    const logs = Array.isArray(stored[LOGS_KEY]) ? stored[LOGS_KEY] : [];
    logs.unshift({ id: Core.createId("log"), time: nowIso(), level, type, message, meta: safeMeta });
    await chrome.storage.local.set({ [LOGS_KEY]: logs.slice(0, MAX_LOGS) });
  }).catch((error) => console.error("写入日志失败", error));
  return logQueue;
}

async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return Core.sanitizeConfig(stored[CONFIG_KEY]);
}

async function saveConfig(config) {
  const sanitized = Core.sanitizeConfig(config);
  await chrome.storage.local.set({ [CONFIG_KEY]: sanitized });
  return sanitized;
}

async function getOverrides() {
  const stored = await chrome.storage.session.get(OVERRIDES_KEY);
  const config = await getConfig();
  return Core.sanitizeOverrides(stored[OVERRIDES_KEY], config);
}

async function saveOverrides(overrides) {
  const config = await getConfig();
  const sanitized = Core.sanitizeOverrides(overrides, config);
  await chrome.storage.session.set({ [OVERRIDES_KEY]: sanitized });
  return sanitized;
}

async function setStatus(patch) {
  const stored = await chrome.storage.local.get(STATUS_KEY);
  await chrome.storage.local.set({
    [STATUS_KEY]: {
      ...(stored[STATUS_KEY] || {}),
      ...patch,
      updatedAt: nowIso()
    }
  });
}

async function getProxyControl() {
  return chrome.proxy.settings.get({ incognito: false });
}

function isControllable(level) {
  return level === "controllable_by_this_extension" || level === "controlled_by_this_extension";
}

function controlError(control) {
  return control.levelOfControl === "controlled_by_other_extensions"
    ? "代理设置正被另一个扩展控制"
    : "浏览器代理设置被系统或组织策略锁定，当前扩展无权修改";
}

async function updateActionBehavior(config) {
  const popup = config.ui.iconClickAction === "toggle" ? "" : "popup.html";
  await chrome.action.setPopup({ popup });
}

const ACTION_ICONS = {
  default: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png"
  },
  enabled: {
    16: "icons/icon-enabled16.png",
    32: "icons/icon-enabled32.png",
    48: "icons/icon-enabled48.png",
    128: "icons/icon-enabled128.png"
  }
};

async function updateGlobalBadge(enabled, hasError = false) {
  await chrome.action.setIcon({ path: enabled && !hasError ? ACTION_ICONS.enabled : ACTION_ICONS.default });
  if (hasError) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
    return;
  }
  // Chromium 的角标字号不可调。启用状态改由图标右下角绿色圆点表示，避免醒目的 “ON” 遮挡图标。
  await chrome.action.setBadgeText({ text: "" });
}

function routeDescription(config, route) {
  if (route.type === "bypass") return `直连（${route.name}）`;
  if (route.direct) return "直连";
  const proxy = Core.getProxy(config, route.proxyId);
  return proxy ? `${proxy.name} (${proxy.host}:${proxy.port})` : "代理未配置";
}

async function updateTabTitle(tabId, url) {
  if (!Number.isInteger(tabId) || tabId < 0 || !url) return;
  let host = "";
  try { host = new URL(url).hostname; } catch { return; }
  if (!host) return;
  const [config, overrides] = await Promise.all([getConfig(), getOverrides()]);
  const route = Core.resolveRoute(config, host, overrides, url);
  const state = config.enabled ? "已启用" : "已停用";
  const title = `站点代理路由器（${state}）\n${host}\n命中：${route.name}\n出口：${routeDescription(config, route)}`;
  await chrome.action.setTitle({ tabId, title });
}

async function refreshActiveTabTitle() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs[0]) await updateTabTitle(tabs[0].id, tabs[0].url);
}

async function applyConfig(configInput, reason = "应用配置") {
  const validation = Core.validateConfig(configInput);
  if (!validation.ok) {
    const message = validation.errors.join("；");
    await setStatus({ active: false, error: message });
    await updateGlobalBadge(false, true);
    throw new Error(message);
  }

  const config = validation.config;
  const control = await getProxyControl();
  if (!isControllable(control.levelOfControl)) {
    const message = controlError(control);
    await setStatus({ active: false, error: message, levelOfControl: control.levelOfControl });
    await updateGlobalBadge(false, true);
    throw new Error(message);
  }

  const overrides = await getOverrides();
  const pacScript = Core.buildPacScript(config, overrides);
  await chrome.proxy.settings.set({
    value: { mode: "pac_script", pacScript: { data: pacScript, mandatory: true } },
    scope: "regular"
  });

  await updateActionBehavior(config);
  await setStatus({
    active: true,
    error: "",
    lastProxyError: "",
    levelOfControl: "controlled_by_this_extension",
    ruleCount: config.rules.filter((rule) => rule.enabled).length,
    proxyCount: config.proxies.length
  });
  await updateGlobalBadge(true, false);
  await refreshActiveTabTitle();
  await appendLog("info", "apply", reason, {
    rules: config.rules.filter((rule) => rule.enabled).length,
    proxies: config.proxies.length,
    temporaryOverrides: overrides.length
  });
}

async function disableProxy(reason = "停用代理路由") {
  const control = await getProxyControl();
  if (control.levelOfControl === "controlled_by_this_extension" ||
      control.levelOfControl === "controllable_by_this_extension") {
    await chrome.proxy.settings.clear({ scope: "regular" });
  }
  const config = await getConfig();
  await updateActionBehavior(config);
  await setStatus({ active: false, error: "", levelOfControl: control.levelOfControl });
  await updateGlobalBadge(false, false);
  await refreshActiveTabTitle();
  await appendLog("info", "toggle", reason);
}

async function syncFromStorage(reason = "同步配置") {
  const config = await getConfig();
  await updateActionBehavior(config);
  if (config.enabled) return applyConfig(config, reason);
  return disableProxy(reason);
}

async function snapshotUnderlyingProxy() {
  let current = await getProxyControl();
  if (current.levelOfControl === "controlled_by_this_extension") {
    await chrome.proxy.settings.clear({ scope: "regular" });
    current = await getProxyControl();
  }
  const snapshot = {
    capturedAt: nowIso(),
    value: current.value || { mode: "system" },
    levelOfControl: current.levelOfControl
  };
  await chrome.storage.local.set({ [ORIGINAL_PROXY_KEY]: snapshot });
  return snapshot;
}

async function ensureInitialized(details = {}) {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (error) {
    console.warn("无法限制存储访问级别", error);
  }

  const stored = await chrome.storage.local.get([CONFIG_KEY, LEGACY_CONFIG_KEY]);
  if (stored[CONFIG_KEY]) {
    const config = Core.sanitizeConfig(stored[CONFIG_KEY]);
    await saveConfig(config);
    await rebuildContextMenus(config);
    return config;
  }

  const snapshot = await snapshotUnderlyingProxy();
  const extracted = Core.extractDefaultProxy(snapshot.value);
  let config = Core.migrateLegacyConfig(stored[LEGACY_CONFIG_KEY]) || Core.sanitizeConfig(Core.DEFAULT_CONFIG);

  if (extracted.ok && !config.defaultRoute.proxyId) {
    config.proxies.push(extracted.proxy);
    config.defaultRoute.mode = "proxy";
    config.defaultRoute.proxyId = extracted.proxy.id;
    if (typeof extracted.bypassLocal === "boolean") config.bypassLocal = extracted.bypassLocal;
    if (Array.isArray(extracted.bypassPatterns)) config.bypassPatterns = extracted.bypassPatterns;
  }
  const validation = Core.validateConfig(config);
  if (!validation.ok) config.enabled = false;
  await saveConfig(config);
  await rebuildContextMenus(config);
  await appendLog(extracted.ok ? "info" : "warning", "initialize",
    extracted.ok ? "已从当前浏览器代理配置导入默认代理" : "未能自动导入默认代理",
    { reason: details.reason || "install", sourceMode: extracted.sourceMode, note: extracted.note });
  await setStatus({
    active: false,
    error: validation.ok ? "" : validation.errors.join("；"),
    systemImport: extracted
  });
  return config;
}

async function setTemporaryOverride(hostInput, mode, proxyId = "", includeSubdomains = true) {
  const currentHost = Core.normalizeHost(hostInput);
  if (!currentHost) throw new Error("当前页面没有可用的域名");
  const useSubdomains = includeSubdomains !== false;
  const host = useSubdomains ? Core.getRegistrableDomain(currentHost) : currentHost;
  const config = await getConfig();
  if (mode === "proxy" && !Core.getProxy(config, proxyId)) throw new Error("选择的代理不存在");
  const current = await getOverrides();
  const next = current.filter((item) => item.host !== host);
  next.unshift({ host, mode, proxyId, includeSubdomains: useSubdomains, createdAt: nowIso() });
  await saveOverrides(next);
  if (config.enabled) await applyConfig(config, `更新 ${host} 的临时路由`);
  await appendLog("info", "override", mode === "direct" ? `临时直连 ${host}` : `临时指定 ${host} 的代理`, {
    currentHost,
    host,
    proxyId,
    includeSubdomains: useSubdomains
  });
  await refreshActiveTabTitle();
}

async function clearTemporaryOverride(hostInput) {
  const host = Core.normalizeHost(hostInput);
  const config = await getConfig();
  const current = await getOverrides();
  const matched = Core.findOverride(config, host, current);
  const overrideHost = matched?.host || host;
  const next = current.filter((item) => item.host !== overrideHost);
  await saveOverrides(next);
  if (config.enabled) await applyConfig(config, `清除 ${overrideHost} 的临时路由`);
  await appendLog("info", "override", `清除临时路由：${overrideHost}`, { host, overrideHost });
  await refreshActiveTabTitle();
}

async function testProxy(proxyId, proxyInput) {
  if (testInProgress) throw new Error("已有代理测试正在进行");
  testInProgress = true;
  const started = Date.now();
  let restoreNeeded = false;
  try {
    const config = await getConfig();
    const proxy = proxyInput && typeof proxyInput === "object"
      ? { ...proxyInput, host: Core.normalizeHost(proxyInput.host), port: Number(proxyInput.port) }
      : Core.getProxy(config, proxyId);
    if (!proxy || !proxy.host || !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) throw new Error("代理节点不存在或地址端口无效");
    activeTestProxy = proxy;
    const control = await getProxyControl();
    if (!isControllable(control.levelOfControl)) throw new Error(controlError(control));

    // 在现有路由 PAC 外层只覆盖测试域名，避免测试期间把其他标签页全部切成直连。
    const overrides = await getOverrides();
    const testConfig = Core.sanitizeConfig(config);
    const testProxy = { ...proxy, id: proxy.id || Core.createId("proxy-test") };
    const existingIndex = testConfig.proxies.findIndex((item) => item.id === testProxy.id);
    if (existingIndex >= 0) testConfig.proxies[existingIndex] = testProxy;
    else testConfig.proxies.push(testProxy);
    let basePacScript = "";
    if (config.enabled) {
      try { basePacScript = Core.buildPacScript(testConfig, overrides); }
      catch (error) { await appendLog("warning", "proxy-test", `无法保留当前分流规则，测试期间其他请求将直连：${error.message}`); }
    }
    const pacScript = Core.buildProxyTestPac(testProxy, basePacScript);
    await chrome.proxy.settings.set({
      value: { mode: "pac_script", pacScript: { data: pacScript, mandatory: true } },
      scope: "regular"
    });
    restoreNeeded = true;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(`${TEST_URL}?proxy-router-test=${Date.now()}`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`测试地址返回 HTTP ${response.status}`);
    const elapsedMs = Date.now() - started;
    await appendLog("info", "proxy-test", `代理测试成功：${proxy.name}`, {
      proxyId, endpoint: `${proxy.host}:${proxy.port}`, elapsedMs, status: response.status
    });
    return { ok: true, elapsedMs, status: response.status };
  } catch (error) {
    await appendLog("error", "proxy-test", `代理测试失败：${error.message}`, { proxyId, elapsedMs: Date.now() - started });
    throw error;
  } finally {
    if (restoreNeeded) {
      try { await syncFromStorage("代理测试后恢复配置"); }
      catch (error) { await appendLog("error", "restore", `代理测试后恢复失败：${error.message}`); }
    }
    activeTestProxy = null;
    testInProgress = false;
  }
}

function normalizeChallengerHost(host) {
  return Core.normalizeHost(String(host || "").replace(/^\[|\]$/g, ""));
}

chrome.webRequest.onAuthRequired.addListener((details, callback) => {
  (async () => {
    if (!details.isProxy || String(details.scheme || "").toLowerCase() !== "basic") {
      callback({});
      return;
    }
    const config = await getConfig();
    const challengerHost = normalizeChallengerHost(details.challenger?.host);
    const challengerPort = Number(details.challenger?.port);
    const candidates = activeTestProxy ? [activeTestProxy, ...config.proxies] : config.proxies;
    const proxy = candidates.find((item) => Core.normalizeHost(item.host) === challengerHost && Number(item.port) === challengerPort);
    if (!proxy || (!proxy.username && !proxy.password)) {
      callback({});
      return;
    }

    const key = `${details.requestId}:${challengerHost}:${challengerPort}`;
    const attempts = authAttempts.get(key) || 0;
    if (attempts >= 1) {
      await appendLog("error", "auth", `代理认证失败，已停止重复提交：${proxy.name}`, {
        endpoint: `${proxy.host}:${proxy.port}`, scheme: details.scheme
      });
      callback({ cancel: true });
      return;
    }
    authAttempts.set(key, attempts + 1);
    callback({ authCredentials: { username: proxy.username, password: proxy.password } });
  })().catch(async (error) => {
    await appendLog("error", "auth", `处理代理认证时出错：${error.message}`);
    callback({});
  });
}, { urls: ["<all_urls>"] }, ["asyncBlocking"]);

function clearAuthAttempts(requestId) {
  for (const key of authAttempts.keys()) {
    if (key.startsWith(`${requestId}:`)) authAttempts.delete(key);
  }
}
chrome.webRequest.onCompleted.addListener((details) => clearAuthAttempts(details.requestId), { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener((details) => clearAuthAttempts(details.requestId), { urls: ["<all_urls>"] });

async function rebuildContextMenus(configInput) {
  const config = Core.sanitizeConfig(configInput);
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: "proxy-router-root", title: "站点代理路由器", contexts: ["page"] });
  chrome.contextMenus.create({ id: "override-direct", parentId: "proxy-router-root", title: "临时直连当前网站", contexts: ["page"] });
  chrome.contextMenus.create({ id: "override-proxy-root", parentId: "proxy-router-root", title: "临时走指定代理", contexts: ["page"] });
  for (const proxy of config.proxies) {
    chrome.contextMenus.create({
      id: `override-proxy:${proxy.id}`,
      parentId: "override-proxy-root",
      title: proxy.name,
      contexts: ["page"]
    });
  }
  chrome.contextMenus.create({ id: "override-clear", parentId: "proxy-router-root", title: "清除当前网站临时路由", contexts: ["page"] });
  chrome.contextMenus.create({ id: "separator", parentId: "proxy-router-root", type: "separator", contexts: ["page"] });
  chrome.contextMenus.create({ id: "open-options", parentId: "proxy-router-root", title: "打开设置和日志", contexts: ["page"] });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.pageUrl || tab?.url || "";
  let host = "";
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  if (info.menuItemId === "override-direct") setTemporaryOverride(host, "direct").catch(console.error);
  else if (String(info.menuItemId).startsWith("override-proxy:")) {
    setTemporaryOverride(host, "proxy", String(info.menuItemId).slice("override-proxy:".length)).catch(console.error);
  } else if (info.menuItemId === "override-clear") clearTemporaryOverride(host).catch(console.error);
  else if (info.menuItemId === "open-options") chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(async () => {
  const config = await getConfig();
  if (config.ui.iconClickAction !== "toggle") return;
  const nextEnabled = !config.enabled;
  if (nextEnabled) {
    const validation = Core.validateConfig({ ...config, enabled: true });
    if (!validation.ok) {
      const message = validation.errors.join("；");
      await setStatus({ active: false, error: message });
      await updateGlobalBadge(false, true);
      await appendLog("error", "toggle", `工具栏启用失败：${message}`);
      return;
    }
  }
  config.enabled = nextEnabled;
  await saveConfig(config);
  try { await syncFromStorage(config.enabled ? "工具栏图标一键启用" : "工具栏图标一键停用"); }
  catch (error) { await appendLog("error", "toggle", `工具栏切换失败：${error.message}`); }
});

chrome.runtime.onInstalled.addListener((details) => {
  ensureInitialized(details)
    .then(() => syncFromStorage(details.reason === "update" ? "扩展升级后同步" : "扩展安装后同步"))
    .catch((error) => console.error("初始化失败", error));
});

chrome.runtime.onStartup.addListener(() => {
  ensureInitialized({ reason: "startup" })
    .then(() => syncFromStorage("浏览器启动后同步"))
    .catch((error) => console.error("启动同步失败", error));
});

chrome.proxy.onProxyError.addListener((details) => {
  const message = `${details.fatal ? "致命" : "非致命"}代理错误：${details.error}`;
  setStatus({ lastProxyError: message }).catch(console.error);
  appendLog(details.fatal ? "error" : "warning", "proxy-error", message, details).catch(console.error);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((tab) => updateTabTitle(tabId, tab.url)).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") updateTabTitle(tabId, tab.url).catch(() => {});
});
chrome.windows.onFocusChanged.addListener(() => refreshActiveTabTitle().catch(() => {}));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_STATE": {
        const [config, stored, control, overrides, original, logs] = await Promise.all([
          getConfig(), chrome.storage.local.get(STATUS_KEY), getProxyControl(), getOverrides(),
          chrome.storage.local.get(ORIGINAL_PROXY_KEY), chrome.storage.local.get(LOGS_KEY)
        ]);
        return {
          ok: true,
          config,
          status: stored[STATUS_KEY] || {},
          control,
          overrides,
          originalProxy: original[ORIGINAL_PROXY_KEY] || null,
          logs: Array.isArray(logs[LOGS_KEY]) ? logs[LOGS_KEY] : []
        };
      }
      case "SAVE_CONFIG": {
        const validation = Core.validateConfig(message.config);
        if (!validation.ok) throw new Error(validation.errors.join("；"));
        await saveConfig(validation.config);
        await rebuildContextMenus(validation.config);
        if (validation.config.enabled) await applyConfig(validation.config, "保存并应用新配置");
        else await disableProxy("保存配置（保持停用）");
        return { ok: true, config: validation.config };
      }
      case "SET_ENABLED": {
        const config = await getConfig();
        config.enabled = message.enabled === true;
        const validation = Core.validateConfig(config);
        if (config.enabled && !validation.ok) throw new Error(validation.errors.join("；"));
        await saveConfig(config);
        if (config.enabled) await applyConfig(config, "启用代理路由");
        else await disableProxy("停用代理路由");
        return { ok: true };
      }
      case "APPLY_NOW":
        await syncFromStorage("手动重新应用配置");
        return { ok: true };
      case "MATCH_HOST": {
        const [config, overrides] = await Promise.all([getConfig(), getOverrides()]);
        const route = Core.resolveRoute(config, message.host, overrides, message.url || "");
        return { ok: true, route, description: routeDescription(config, route) };
      }
      case "SET_OVERRIDE":
        await setTemporaryOverride(
          message.host,
          message.mode,
          message.proxyId,
          message.includeSubdomains !== false
        );
        return { ok: true };
      case "CLEAR_OVERRIDE":
        await clearTemporaryOverride(message.host);
        return { ok: true };
      case "TEST_PROXY":
        return await testProxy(message.proxyId, message.proxy);
      case "CLEAR_LOGS":
        await chrome.storage.local.set({ [LOGS_KEY]: [] });
        return { ok: true };
      case "CAPTURE_SYSTEM_PROXY": {
        const config = await getConfig();
        const snapshot = await snapshotUnderlyingProxy();
        const extracted = Core.extractDefaultProxy(snapshot.value);
        if (config.enabled) await applyConfig(config, "读取系统代理后恢复配置");
        await appendLog(extracted.ok ? "info" : "warning", "capture", extracted.ok ? "重新读取代理成功" : "重新读取代理失败", extracted);
        return { ok: true, snapshot, extracted };
      }
      default:
        throw new Error("未知操作");
    }
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
