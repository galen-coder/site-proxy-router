const Core = globalThis.ProxyRouterCore;
let draft = Core.sanitizeConfig(Core.DEFAULT_CONFIG);
let state = null;

const $ = (selector) => document.querySelector(selector);
const elements = {
  enabled: $("#enabled"),
  save: $("#save"),
  banner: $("#banner"),
  validation: $("#validation"),
  proxyList: $("#proxy-list"),
  ruleList: $("#rule-list"),
  defaultMode: $("#default-mode"),
  defaultProxySettings: $("#default-proxy-settings"),
  defaultProxy: $("#default-proxy"),
  defaultFallbacks: $("#default-fallbacks"),
  defaultDirect: $("#default-direct"),
  bypassLocal: $("#bypass-local"),
  bypassPatterns: $("#bypass-patterns"),
  iconAction: $("#icon-action"),
  systemInfo: $("#system-info"),
  logList: $("#log-list"),
  importFile: $("#import-file")
};

function proxyOptions(selectedId = "", excludedId = "") {
  const options = ['<option value="">请选择代理</option>'];
  for (const proxy of draft.proxies) {
    if (proxy.id === excludedId) continue;
    const option = document.createElement("option");
    option.value = proxy.id;
    option.textContent = `${proxy.name || "未命名代理"} — ${proxy.host || "未填写"}:${proxy.port || "-"}`;
    option.selected = proxy.id === selectedId;
    options.push(option.outerHTML);
  }
  return options.join("");
}

function setMultiSelect(select, selectedIds) {
  const set = new Set(selectedIds || []);
  for (const option of select.options) option.selected = set.has(option.value);
}

function getMultiSelect(select) {
  return Array.from(select.selectedOptions).map((option) => option.value).filter(Boolean);
}

function showErrors(errors) {
  if (!errors?.length) {
    elements.validation.classList.add("hidden");
    elements.validation.textContent = "";
    return;
  }
  elements.validation.textContent = errors.join("；");
  elements.validation.classList.remove("hidden");
  elements.validation.scrollIntoView({ behavior: "smooth", block: "center" });
}

function updateBanner() {
  const level = state?.control?.levelOfControl;
  if (level === "not_controllable") {
    elements.banner.className = "banner error";
    elements.banner.textContent = "浏览器代理被系统或组织策略锁定，本扩展无法修改。";
  } else if (level === "controlled_by_other_extensions") {
    elements.banner.className = "banner error";
    elements.banner.textContent = "另一个扩展正在控制浏览器代理，请先停用冲突扩展。";
  } else if (state?.status?.error) {
    elements.banner.className = "banner warning";
    elements.banner.textContent = `配置尚未生效：${state.status.error}`;
  } else {
    elements.banner.className = "banner ok";
    elements.banner.textContent = "浏览器允许本扩展控制代理。规则和凭据仅保存在当前浏览器配置中。";
  }
}

function renderProxies() {
  elements.proxyList.textContent = "";
  if (!draft.proxies.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "尚未添加代理。默认出口选择 DIRECT 时可以不配置代理；分流规则使用代理时再添加即可。";
    elements.proxyList.append(empty);
    renderDefaultRoute();
    renderRules();
    return;
  }

  draft.proxies.forEach((proxy, index) => {
    const card = $("#proxy-template").content.firstElementChild.cloneNode(true);
    card.dataset.id = proxy.id;
    card.querySelector(".card-index").textContent = `代理 ${index + 1}`;
    for (const field of ["name", "host", "port", "username", "password"]) {
      const input = card.querySelector(`[data-field="${field}"]`);
      input.value = proxy[field] ?? "";
      input.addEventListener("input", () => {
        proxy[field] = field === "port" ? Number.parseInt(input.value, 10) || 0 : input.value;
      });
      if (field === "name") input.addEventListener("change", () => { renderRules(); renderDefaultRoute(); });
    }

    card.querySelector('[data-action="show-password"]').addEventListener("click", (event) => {
      const input = card.querySelector('[data-field="password"]');
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      event.currentTarget.textContent = showing ? "显示" : "隐藏";
    });

    card.querySelector('[data-action="up"]').disabled = index === 0;
    card.querySelector('[data-action="down"]').disabled = index === draft.proxies.length - 1;
    card.querySelector('[data-action="up"]').addEventListener("click", () => {
      [draft.proxies[index - 1], draft.proxies[index]] = [draft.proxies[index], draft.proxies[index - 1]];
      renderAll();
    });
    card.querySelector('[data-action="down"]').addEventListener("click", () => {
      [draft.proxies[index + 1], draft.proxies[index]] = [draft.proxies[index], draft.proxies[index + 1]];
      renderAll();
    });

    card.querySelector('[data-action="delete"]').addEventListener("click", () => {
      if (!confirm(`删除代理“${proxy.name || `代理 ${index + 1}`}”？相关规则的代理选择也会被清空。`)) return;
      draft.proxies = draft.proxies.filter((item) => item.id !== proxy.id);
      if (draft.defaultRoute.proxyId === proxy.id) draft.defaultRoute.proxyId = "";
      draft.defaultRoute.fallbackProxyIds = draft.defaultRoute.fallbackProxyIds.filter((id) => id !== proxy.id);
      for (const rule of draft.rules) {
        if (rule.proxyId === proxy.id) rule.proxyId = "";
        rule.fallbackProxyIds = rule.fallbackProxyIds.filter((id) => id !== proxy.id);
      }
      renderAll();
    });

    card.querySelector('[data-action="test"]').addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const result = card.querySelector(".test-result");
      button.disabled = true;
      result.className = "test-result";
      result.textContent = "正在测试；测试期间 example.com 会临时通过该代理…";
      try {
        const response = await chrome.runtime.sendMessage({ type: "TEST_PROXY", proxy });
        if (!response?.ok) throw new Error(response?.error || "测试失败");
        result.className = "test-result ok";
        result.textContent = `连接成功，HTTP ${response.status}，耗时 ${response.elapsedMs} ms`;
        await reloadLogs();
      } catch (error) {
        result.className = "test-result error";
        result.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    elements.proxyList.append(card);
  });
}

function fillProxySelect(select, selectedId, excludedId = "") {
  select.innerHTML = proxyOptions(selectedId, excludedId);
  select.value = selectedId || "";
}

function fillFallbackSelect(select, selectedIds, primaryId = "") {
  select.textContent = "";
  for (const proxy of draft.proxies) {
    if (proxy.id === primaryId) continue;
    const option = document.createElement("option");
    option.value = proxy.id;
    option.textContent = `${proxy.name || "未命名代理"} — ${proxy.host || "未填写"}:${proxy.port || "-"}`;
    select.append(option);
  }
  setMultiSelect(select, selectedIds);
}

function renderRules() {
  elements.ruleList.textContent = "";
  if (!draft.rules.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = draft.defaultRoute.mode === "direct" ? "没有分流规则，所有网站都会直接连接。" : "没有分流规则，所有网站都会走默认代理。";
    elements.ruleList.append(empty);
    return;
  }

  draft.rules.forEach((rule, index) => {
    const card = $("#rule-template").content.firstElementChild.cloneNode(true);
    card.dataset.id = rule.id;
    card.querySelector(".card-index").textContent = `规则 ${index + 1}`;
    const enabled = card.querySelector('[data-field="enabled"]');
    const name = card.querySelector('[data-field="name"]');
    const patterns = card.querySelector('[data-field="patterns"]');
    const primary = card.querySelector('[data-field="proxyId"]');
    const fallbacks = card.querySelector('[data-field="fallbackProxyIds"]');
    const allowDirect = card.querySelector('[data-field="allowDirect"]');

    enabled.checked = rule.enabled;
    name.value = rule.name;
    patterns.value = rule.patterns.join("\n");
    fillProxySelect(primary, rule.proxyId);
    fillFallbackSelect(fallbacks, rule.fallbackProxyIds, rule.proxyId);
    allowDirect.checked = rule.allowDirect;

    enabled.addEventListener("change", () => { rule.enabled = enabled.checked; });
    name.addEventListener("input", () => { rule.name = name.value; });
    patterns.addEventListener("input", () => { rule.patterns = Core.normalizePatterns(patterns.value); });
    primary.addEventListener("change", () => {
      rule.proxyId = primary.value;
      rule.fallbackProxyIds = rule.fallbackProxyIds.filter((id) => id !== rule.proxyId);
      fillFallbackSelect(fallbacks, rule.fallbackProxyIds, rule.proxyId);
    });
    fallbacks.addEventListener("change", () => { rule.fallbackProxyIds = getMultiSelect(fallbacks); });
    allowDirect.addEventListener("change", () => { rule.allowDirect = allowDirect.checked; });

    card.querySelector('[data-action="up"]').disabled = index === 0;
    card.querySelector('[data-action="down"]').disabled = index === draft.rules.length - 1;
    card.querySelector('[data-action="up"]').addEventListener("click", () => {
      [draft.rules[index - 1], draft.rules[index]] = [draft.rules[index], draft.rules[index - 1]];
      renderRules();
    });
    card.querySelector('[data-action="down"]').addEventListener("click", () => {
      [draft.rules[index + 1], draft.rules[index]] = [draft.rules[index], draft.rules[index + 1]];
      renderRules();
    });
    card.querySelector('[data-action="delete"]').addEventListener("click", () => {
      if (!confirm(`删除规则“${rule.name || `规则 ${index + 1}`}”？`)) return;
      draft.rules.splice(index, 1);
      renderRules();
    });
    elements.ruleList.append(card);
  });
}

function renderDefaultRoute() {
  elements.defaultMode.value = draft.defaultRoute.mode;
  elements.defaultProxySettings.classList.toggle("hidden", draft.defaultRoute.mode === "direct");
  fillProxySelect(elements.defaultProxy, draft.defaultRoute.proxyId);
  fillFallbackSelect(elements.defaultFallbacks, draft.defaultRoute.fallbackProxyIds, draft.defaultRoute.proxyId);
  elements.defaultDirect.checked = draft.defaultRoute.allowDirect;
  elements.bypassLocal.checked = draft.bypassLocal;
  elements.bypassPatterns.value = draft.bypassPatterns.join(";\n");
  elements.iconAction.value = draft.ui.iconClickAction;
}

function renderSystemInfo() {
  const snapshot = state?.originalProxy;
  const imported = state?.status?.systemImport;
  const lines = [];
  if (snapshot) {
    lines.push(`首次读取时间：${new Date(snapshot.capturedAt).toLocaleString()}`);
    lines.push(`浏览器返回模式：${snapshot.value?.mode || "未知"}`);
  }
  if (imported?.note) lines.push(`读取结果：${imported.note}`);
  if (Array.isArray(imported?.bypassPatterns)) lines.push(`同时读取例外项：${imported.bypassPatterns.length} 条；本地地址绕过：${imported.bypassLocal ? "开启" : "关闭"}`);
  lines.push("说明：fixed_servers 模式可读取浏览器返回的例外列表；system 模式只表示浏览器跟随 Windows，扩展 API 不会返回 Windows 代理地址或例外项，此时需要手动配置。");
  elements.systemInfo.textContent = lines.join("\n");
}

function renderLogs(logs = state?.logs || []) {
  elements.logList.textContent = "";
  if (!logs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无日志";
    elements.logList.append(empty);
    return;
  }
  for (const log of logs) {
    const row = document.createElement("div");
    row.className = `log-row ${log.level || "info"}`;
    const time = document.createElement("div");
    time.className = "log-time";
    time.textContent = new Date(log.time).toLocaleString();
    const type = document.createElement("div");
    type.className = "log-type";
    type.textContent = log.type || "log";
    const message = document.createElement("div");
    message.className = "log-message";
    const meta = log.meta && Object.keys(log.meta).length ? `\n${JSON.stringify(log.meta)}` : "";
    message.textContent = `${log.message || ""}${meta}`;
    row.append(time, type, message);
    elements.logList.append(row);
  }
}

function renderAll() {
  elements.enabled.checked = draft.enabled;
  renderProxies();
  renderRules();
  renderDefaultRoute();
  renderSystemInfo();
  renderLogs();
}

async function reloadState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response?.ok) throw new Error(response?.error || "读取状态失败");
  state = response;
  draft = Core.sanitizeConfig(response.config);
  updateBanner();
  renderAll();
}

async function reloadLogs() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (response?.ok) {
    state.logs = response.logs;
    renderLogs(response.logs);
  }
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveAndApply() {
  draft.enabled = elements.enabled.checked;
  const validation = Core.validateConfig(draft);
  showErrors(validation.errors);
  if (!validation.ok) return false;
  elements.save.disabled = true;
  elements.save.textContent = "正在保存…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: validation.config });
    if (!response?.ok) throw new Error(response?.error || "保存失败");
    draft = Core.sanitizeConfig(response.config);
    elements.save.textContent = "已保存";
    await reloadState();
    setTimeout(() => { elements.save.textContent = "保存并应用"; }, 1200);
    return true;
  } catch (error) {
    showErrors([error.message]);
    elements.save.textContent = "保存并应用";
    return false;
  } finally {
    elements.save.disabled = false;
  }
}

$("#add-proxy").addEventListener("click", () => {
  draft.proxies.push({
    id: Core.createId("proxy"), name: `代理 ${draft.proxies.length + 1}`,
    host: "", port: 8080, username: "", password: ""
  });
  renderAll();
});

$("#add-rule").addEventListener("click", () => {
  draft.rules.push({
    id: Core.createId("rule"), name: `规则 ${draft.rules.length + 1}`, enabled: true,
    patterns: [], proxyId: draft.proxies[0]?.id || "", fallbackProxyIds: [], allowDirect: false
  });
  renderRules();
});

elements.defaultMode.addEventListener("change", () => {
  draft.defaultRoute.mode = elements.defaultMode.value === "proxy" ? "proxy" : "direct";
  if (draft.defaultRoute.mode === "proxy" && !draft.defaultRoute.proxyId) {
    draft.defaultRoute.proxyId = draft.proxies[0]?.id || "";
  }
  renderDefaultRoute();
  renderRules();
});
elements.defaultProxy.addEventListener("change", () => {
  draft.defaultRoute.proxyId = elements.defaultProxy.value;
  draft.defaultRoute.fallbackProxyIds = draft.defaultRoute.fallbackProxyIds.filter((id) => id !== draft.defaultRoute.proxyId);
  renderDefaultRoute();
});
elements.defaultFallbacks.addEventListener("change", () => { draft.defaultRoute.fallbackProxyIds = getMultiSelect(elements.defaultFallbacks); });
elements.defaultDirect.addEventListener("change", () => { draft.defaultRoute.allowDirect = elements.defaultDirect.checked; });
elements.bypassLocal.addEventListener("change", () => { draft.bypassLocal = elements.bypassLocal.checked; });
elements.bypassPatterns.addEventListener("input", () => {
  const raw = elements.bypassPatterns.value;
  if (/(^|[;\r\n])\s*<local>\s*(?=$|[;\r\n])/i.test(raw)) {
    draft.bypassLocal = true;
    elements.bypassLocal.checked = true;
  }
  draft.bypassPatterns = Core.normalizeBypassPatterns(raw);
});
elements.iconAction.addEventListener("change", () => { draft.ui.iconClickAction = elements.iconAction.value; });
elements.enabled.addEventListener("change", () => { draft.enabled = elements.enabled.checked; });
elements.save.addEventListener("click", saveAndApply);

$("#capture-system").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "正在读取…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "CAPTURE_SYSTEM_PROXY" });
    if (!response?.ok) throw new Error(response?.error || "读取失败");
    state.originalProxy = response.snapshot;
    state.status.systemImport = response.extracted;
    if (response.extracted.ok) {
      const proxy = response.extracted.proxy;
      const existing = draft.proxies.find((item) => item.host === proxy.host && item.port === proxy.port);
      if (!existing) draft.proxies.push(proxy);
      draft.defaultRoute.mode = "proxy";
      draft.defaultRoute.proxyId = existing?.id || proxy.id;
      if (typeof response.extracted.bypassLocal === "boolean") {
        draft.bypassLocal = response.extracted.bypassLocal;
      }
      if (Array.isArray(response.extracted.bypassPatterns)) {
        draft.bypassPatterns = response.extracted.bypassPatterns;
      }
      showErrors([]);
    } else {
      showErrors([response.extracted.note]);
    }
    renderAll();
  } catch (error) {
    showErrors([error.message]);
  } finally {
    button.disabled = false;
    button.textContent = "重新读取当前代理";
  }
});

$("#export-full").addEventListener("click", () => {
  if (!confirm("完整导出文件会包含明文代理密码。请确认保存位置安全。")) return;
  downloadJson("site-proxy-router-full.json", Core.sanitizeConfig(draft));
});
$("#export-anonymous").addEventListener("click", () => {
  downloadJson("site-proxy-router-without-passwords.json", Core.withoutPasswords(draft));
});
elements.importFile.addEventListener("change", async () => {
  const file = elements.importFile.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const imported = Core.migrateLegacyConfig(parsed) || parsed;
    const validation = Core.validateConfig(imported);
    if (!validation.ok) throw new Error(validation.errors.join("；"));
    draft = validation.config;
    showErrors([]);
    renderAll();
    const saved = await saveAndApply();
    if (!saved) return;
    elements.banner.className = "banner ok";
    elements.banner.textContent = draft.enabled
      ? "配置导入成功，并已立即保存和应用。"
      : "配置导入成功，并已立即保存；当前配置处于停用状态。";
  } catch (error) {
    showErrors([`导入失败：${error.message}`]);
  } finally {
    elements.importFile.value = "";
  }
});

$("#clear-logs").addEventListener("click", async () => {
  if (!confirm("确定清空所有操作和错误日志？")) return;
  const response = await chrome.runtime.sendMessage({ type: "CLEAR_LOGS" });
  if (response?.ok) {
    state.logs = [];
    renderLogs([]);
  }
});

document.querySelectorAll(".nav").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".section").forEach((section) => section.classList.remove("active"));
    $(`#section-${button.dataset.section}`).classList.add("active");
  });
});

reloadState().catch((error) => showErrors([`加载失败：${error.message}`]));
