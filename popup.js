const enabledInput = document.getElementById("enabled");
const hostText = document.getElementById("host");
const statusDot = document.getElementById("status-dot");
const statusTitle = document.getElementById("status-title");
const statusDetail = document.getElementById("status-detail");
const matchCard = document.getElementById("match-card");
const routeSymbol = document.getElementById("route-symbol");
const routeKicker = document.getElementById("route-kicker");
const routeBadge = document.getElementById("route-badge");
const matchName = document.getElementById("match-name");
const matchDetail = document.getElementById("match-detail");
const proxySelect = document.getElementById("proxy-select");
const messageBox = document.getElementById("message");
const includeSubdomainsInput = document.getElementById("include-subdomains");
const directButton = document.getElementById("direct");
const useProxyButton = document.getElementById("use-proxy");
const clearOverrideButton = document.getElementById("clear-override");
const LAST_PROXY_KEY = "proxyRouterLastTemporaryProxyIdV2";
let currentHost = "";
let currentUrl = "";
let state = null;
let reloadTimer = 0;
let activeOverrideHost = "";

function setStatus(kind, title, detail) {
  statusDot.className = `dot ${kind}`;
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
}

function showMessage(message = "") {
  messageBox.textContent = message;
  messageBox.classList.toggle("hidden", !message);
}

function setRouteCard(kind, badge, symbol, kicker, title, detail) {
  matchCard.className = `match-card route-${kind}`;
  routeBadge.textContent = badge;
  routeSymbol.textContent = symbol;
  routeKicker.textContent = kicker;
  matchName.textContent = title;
  matchDetail.textContent = detail;
}

function routePresentation(route, description, routingActive) {
  if (!route) {
    setRouteCard("error", "读取失败", "!", "当前路由", "无法判断", "未能读取当前网站的路由结果");
    return;
  }

  if (!routingActive) {
    const preview = route.type === "rule" ? `规则“${route.name}”` : route.name;
    setRouteCard(
      "inactive",
      "当前停用",
      "○",
      "启用后路由",
      preview,
      `启用代理路由后，预计出口：${description}${route.pattern ? `；匹配范围：${route.pattern}` : ""}`
    );
    return;
  }

  if (route.type === "bypass") {
    setRouteCard(
      "bypass",
      "不走代理",
      "→",
      "当前路由",
      "直接连接",
      `${route.name}${route.pattern ? `；匹配：${route.pattern}` : ""}。此项优先于临时路由和分流规则。`
    );
    return;
  }

  if (route.type === "temporary") {
    setRouteCard(
      "temporary",
      "临时路由",
      "临",
      "当前路由",
      route.direct ? "临时直连" : description,
      `${route.direct ? "当前网站暂时不走代理" : "当前网站暂时走指定代理"}${route.pattern ? `；范围：${route.pattern}` : ""}`
    );
    return;
  }

  if (route.type === "rule") {
    setRouteCard(
      "rule",
      "命中规则",
      "✓",
      "当前路由",
      route.name,
      `${route.pattern ? `匹配：${route.pattern}；` : ""}出口：${description}`
    );
    return;
  }

  if (route.direct) {
    setRouteCard(
      "bypass",
      "默认直连",
      "→",
      "当前路由",
      "直接连接",
      "当前网站未命中不走代理列表、临时路由或分流规则，按默认出口设置直接连接。"
    );
    return;
  }

  setRouteCard(
    "default",
    "默认代理",
    "默",
    "当前路由",
    description,
    "当前网站未命中不走代理列表、临时路由或分流规则。"
  );
}

async function activePage() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tabs[0]?.url || "";
  try { return { host: new URL(url).hostname, url }; }
  catch { return { host: "", url }; }
}

function fillProxies(proxies, selectedId = "") {
  proxySelect.textContent = "";
  if (!proxies.length) {
    const option = document.createElement("option");
    option.textContent = "尚未配置代理";
    option.value = "";
    option.disabled = true;
    option.selected = true;
    proxySelect.append(option);
    return;
  }
  for (const proxy of proxies) {
    const option = document.createElement("option");
    option.value = proxy.id;
    option.textContent = proxy.name;
    proxySelect.append(option);
  }
  if (selectedId && proxies.some((proxy) => proxy.id === selectedId)) {
    proxySelect.value = selectedId;
  }
}

async function loadState() {
  showMessage();
  const page = await activePage();
  currentHost = page.host;
  currentUrl = page.url;
  hostText.textContent = currentHost || "当前页面不支持设置路由";

  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response?.ok) throw new Error(response?.error || "读取状态失败");
  state = response;
  enabledInput.checked = response.config.enabled;
  enabledInput.disabled = false;

  const selectedBeforeReload = proxySelect.value;
  const storedUi = await chrome.storage.local.get(LAST_PROXY_KEY);
  let routingActive = false;

  if (response.control.levelOfControl === "not_controllable") {
    setStatus("error", "无法控制代理", "代理设置被系统或组织策略锁定");
    enabledInput.disabled = true;
  } else if (response.control.levelOfControl === "controlled_by_other_extensions") {
    setStatus("error", "代理冲突", "另一个扩展正在控制代理设置");
    enabledInput.disabled = true;
  } else if (response.status.error) {
    setStatus("error", "配置未生效", response.status.error);
  } else if (response.config.enabled && response.status.active) {
    routingActive = true;
    setStatus("ok", "代理路由已启用", `${response.config.rules.filter((rule) => rule.enabled).length} 条规则正在参与匹配`);
  } else {
    setStatus("off", "代理路由已停用", "浏览器正在使用原有代理设置");
  }

  let matchedRoute = null;
  let matchedDescription = "未知出口";
  if (currentHost) {
    const matched = await chrome.runtime.sendMessage({ type: "MATCH_HOST", host: currentHost, url: currentUrl });
    if (matched?.ok) {
      matchedRoute = matched.route;
      matchedDescription = matched.description || "未知出口";
      routePresentation(matchedRoute, matchedDescription, routingActive);
    } else {
      setRouteCard("error", "读取失败", "!", "当前路由", "无法判断", matched?.error || "匹配当前网站时发生错误");
    }
  } else {
    setRouteCard("inactive", "不可匹配", "—", "当前路由", "浏览器内部页面", "该页面没有普通网站域名，无法设置临时路由。");
  }

  activeOverrideHost = matchedRoute?.type === "temporary" ? matchedRoute.overrideHost : "";
  const preferredProxyId =
    (matchedRoute?.type === "temporary" && matchedRoute.proxyId) ||
    selectedBeforeReload ||
    storedUi[LAST_PROXY_KEY] ||
    matchedRoute?.proxyId ||
    "";
  fillProxies(response.config.proxies, preferredProxyId);
  if (proxySelect.value) await chrome.storage.local.set({ [LAST_PROXY_KEY]: proxySelect.value });

  includeSubdomainsInput.checked = matchedRoute?.type === "temporary"
    ? matchedRoute.includeSubdomains !== false
    : true;

  const globallyBypassed = matchedRoute?.type === "bypass";
  clearOverrideButton.disabled = !activeOverrideHost;
  directButton.disabled = !currentHost || globallyBypassed;
  useProxyButton.disabled = !currentHost || !response.config.proxies.length || globallyBypassed;
  proxySelect.disabled = !currentHost || !response.config.proxies.length || globallyBypassed;

  if (globallyBypassed) {
    showMessage("当前网站命中“不走代理”列表。该规则优先级最高，如需临时走代理，请先在设置中移除对应例外项。");
  }
}

async function setOverride(mode) {
  if (!currentHost) return;
  const response = await chrome.runtime.sendMessage({
    type: "SET_OVERRIDE",
    host: currentHost,
    mode,
    proxyId: mode === "proxy" ? proxySelect.value : "",
    includeSubdomains: includeSubdomainsInput.checked
  });
  if (!response?.ok) throw new Error(response?.error || "临时路由设置失败");
  if (mode === "proxy" && proxySelect.value) {
    await chrome.storage.local.set({ [LAST_PROXY_KEY]: proxySelect.value });
  }
  await loadState();
}

enabledInput.addEventListener("change", async () => {
  enabledInput.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled: enabledInput.checked });
    if (!response?.ok) throw new Error(response?.error || "切换失败");
    await loadState();
  } catch (error) {
    showMessage(error.message);
    enabledInput.checked = !enabledInput.checked;
    enabledInput.disabled = false;
  }
});

directButton.addEventListener("click", () => setOverride("direct").catch((error) => showMessage(error.message)));
useProxyButton.addEventListener("click", () => setOverride("proxy").catch((error) => showMessage(error.message)));
clearOverrideButton.addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "CLEAR_OVERRIDE", host: activeOverrideHost || currentHost });
    if (!response?.ok) throw new Error(response?.error || "清除失败");
    await loadState();
  } catch (error) {
    showMessage(error.message);
  }
});

proxySelect.addEventListener("change", () => {
  if (proxySelect.value) chrome.storage.local.set({ [LAST_PROXY_KEY]: proxySelect.value });
});

document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("refresh").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "APPLY_NOW" });
  if (!response?.ok) showMessage(response?.error || "重新应用失败");
  else await loadState();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes.proxyRouterConfigV2 && !changes.proxyRouterStatusV2) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadState().catch((error) => showMessage(error.message)), 80);
});

loadState().catch((error) => {
  setStatus("error", "加载失败", error.message);
  setRouteCard("error", "加载失败", "!", "当前路由", "无法读取", "请尝试重新加载扩展或打开设置检查错误日志。");
  showMessage(error.message);
});
