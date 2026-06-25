(function initProxyRouterCore(root, factory) {
  const api = factory();
  root.ProxyRouterCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis, function createProxyRouterCore() {
  "use strict";

  const CONFIG_VERSION = 4;
  const MAX_RULES = 500;
  const MAX_PATTERNS_PER_RULE = 500;

  const DEFAULT_CONFIG = Object.freeze({
    version: CONFIG_VERSION,
    enabled: false,
    proxies: [],
    rules: [],
    defaultRoute: {
      mode: "direct",
      proxyId: "",
      fallbackProxyIds: [],
      allowDirect: false
    },
    // Matches Windows “请勿将代理服务器用于本地(Intranet)地址” (<local>).
    bypassLocal: true,
    // Windows-style proxy exception entries, stored without <local>.
    bypassPatterns: [],
    ui: {
      iconClickAction: "popup"
    }
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createId(prefix) {
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
  }

  function normalizeHost(value) {
    let host = String(value || "").trim().toLowerCase();
    if (!host) return "";
    host = host.replace(/^https?:\/\//, "");
    host = host.split(/[/?#]/, 1)[0];
    host = host.replace(/:\d+$/, "").replace(/\.$/, "");
    return host;
  }

  function isIpAddress(host) {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
    return host.includes(":");
  }

  function getRegistrableDomain(hostInput) {
    const host = normalizeHost(hostInput);
    if (!host || isIpAddress(host) || !host.includes(".")) return host;

    const data = globalThis.ProxyRouterPublicSuffixRules;
    if (!data?.exact || !data?.wildcard || !data?.exception) {
      // Safe fallback when the PSL data file is unavailable in a unit-test context.
      return host.replace(/^www\d*\./, "");
    }

    const labels = host.split(".");
    let publicSuffixLabels = 1; // PSL implicit default rule: *

    for (let i = 0; i < labels.length; i += 1) {
      const candidate = labels.slice(i).join(".");
      if (data.exception.has(candidate)) {
        publicSuffixLabels = labels.length - i - 1;
        break;
      }
      if (data.exact.has(candidate)) {
        publicSuffixLabels = Math.max(publicSuffixLabels, labels.length - i);
      }
      if (i > 0 && data.wildcard.has(candidate)) {
        publicSuffixLabels = Math.max(publicSuffixLabels, labels.length - i + 1);
      }
    }

    if (labels.length <= publicSuffixLabels) return host;
    return labels.slice(-(publicSuffixLabels + 1)).join(".");
  }

  function normalizePattern(value) {
    let pattern = String(value || "").trim().toLowerCase();
    if (!pattern || pattern.startsWith("#")) return "";
    pattern = pattern.replace(/^https?:\/\//, "");
    pattern = pattern.split(/[/?#]/, 1)[0];
    pattern = pattern.replace(/:\d+$/, "").replace(/\.$/, "");
    return pattern;
  }

  function normalizePatterns(values) {
    const input = Array.isArray(values) ? values : String(values || "").split(/\r?\n|,/);
    const unique = new Set();
    for (const value of input) {
      const pattern = normalizePattern(value);
      if (pattern) unique.add(pattern);
    }
    return Array.from(unique);
  }


  function normalizeBypassPattern(value) {
    let pattern = String(value || "").trim().toLowerCase();
    if (!pattern || pattern.startsWith("#")) return "";
    if (pattern === "<local>") return "<local>";
    pattern = pattern.replace(/\s+/g, "");
    pattern = pattern.replace(/\/$/, "");
    const schemeMatch = pattern.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
    const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "";
    let rest = schemeMatch ? schemeMatch[2] : pattern;
    // Windows/Edge treats a leading dot as a subdomain-only suffix rule.
    if (rest.startsWith(".")) rest = `*${rest}`;
    return `${scheme}${rest}`;
  }

  function normalizeBypassPatterns(values) {
    const input = Array.isArray(values)
      ? values
      : String(values || "").split(/[;\r\n]+/);
    const unique = new Set();
    for (const value of input) {
      const pattern = normalizeBypassPattern(value);
      if (pattern && pattern !== "<local>") unique.add(pattern);
    }
    return Array.from(unique);
  }

  function parseBypassPattern(value) {
    const normalized = normalizeBypassPattern(value);
    if (!normalized) return null;
    if (normalized === "<local>") return { local: true, raw: normalized };
    const match = normalized.match(/^(?:(https?|ftp):\/\/)?(.+?)(?::(\d{1,5}))?$/i);
    if (!match) return null;
    return {
      local: false,
      raw: normalized,
      scheme: String(match[1] || "").toLowerCase(),
      hostPattern: String(match[2] || "").toLowerCase(),
      port: match[3] ? Number(match[3]) : 0
    };
  }

  function validateBypassPattern(value) {
    const parsed = parseBypassPattern(value);
    if (!parsed) return `绕过规则格式无效：${value}`;
    if (parsed.local) return "";
    if (!parsed.hostPattern) return `绕过规则缺少主机名：${value}`;
    if (parsed.hostPattern.includes("?")) return `绕过规则暂不支持 ? 通配符：${value}`;
    if (!/^[a-z0-9*._-]+$/i.test(parsed.hostPattern) || parsed.hostPattern.includes("..")) {
      return `绕过规则只能包含协议、域名/IP、端口和 * 通配符：${value}`;
    }
    if (parsed.port && (parsed.port < 1 || parsed.port > 65535)) return `绕过规则端口无效：${value}`;
    return "";
  }

  function urlParts(urlInput, hostInput) {
    const host = normalizeHost(hostInput);
    const text = String(urlInput || "");
    let scheme = "";
    let port = 0;
    try {
      const parsed = new URL(text);
      scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
      port = parsed.port ? Number(parsed.port) : (scheme === "https" ? 443 : scheme === "http" ? 80 : 0);
      return { host: normalizeHost(parsed.hostname) || host, scheme, port };
    } catch {
      const schemeMatch = text.match(/^([a-z][a-z0-9+.-]*):\/\//i);
      scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "";
      return { host, scheme, port };
    }
  }

  function isSimpleHostname(host) {
    return Boolean(host) && !host.includes(".") && !isIpAddress(host);
  }

  function matchBypassPattern(urlInput, hostInput, patternInput) {
    const parsed = parseBypassPattern(patternInput);
    const parts = urlParts(urlInput, hostInput);
    if (!parsed || !parts.host) return false;
    if (parsed.local) return isSimpleHostname(parts.host);
    if (parsed.scheme && parsed.scheme !== parts.scheme) return false;
    if (parsed.port && parsed.port !== parts.port) return false;
    if (!parsed.hostPattern.includes("*")) return parts.host === parsed.hostPattern;
    return globToRegExp(parsed.hostPattern).test(parts.host);
  }

  function matchBypass(configInput, urlInput, hostInput) {
    const config = sanitizeConfig(configInput);
    const parts = urlParts(urlInput, hostInput);
    if (!parts.host) return null;
    if (config.bypassLocal && isSimpleHostname(parts.host)) return { pattern: "<local>", local: true };
    for (const pattern of config.bypassPatterns) {
      if (matchBypassPattern(urlInput, parts.host, pattern)) return { pattern, local: false };
    }
    return null;
  }

  function normalizeProxy(raw, index) {
    const source = raw && typeof raw === "object" ? raw : {};
    const port = Number.parseInt(source.port, 10);
    return {
      id: String(source.id || createId("proxy")),
      name: String(source.name || `代理 ${index + 1}`).trim(),
      host: normalizeHost(source.host),
      port: Number.isInteger(port) ? port : 8080,
      username: String(source.username || ""),
      password: String(source.password || "")
    };
  }

  function normalizeIdList(values, excludedId) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const id = String(value || "");
      if (!id || id === excludedId || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }

  function normalizeRule(raw, index) {
    const source = raw && typeof raw === "object" ? raw : {};
    const proxyId = String(source.proxyId || "");
    return {
      id: String(source.id || createId("rule")),
      name: String(source.name || `规则 ${index + 1}`).trim(),
      enabled: source.enabled !== false,
      patterns: normalizePatterns(source.patterns),
      proxyId,
      fallbackProxyIds: normalizeIdList(source.fallbackProxyIds, proxyId),
      allowDirect: source.allowDirect === true
    };
  }

  function sanitizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const config = clone(DEFAULT_CONFIG);
    config.enabled = source.enabled === true;
    config.proxies = (Array.isArray(source.proxies) ? source.proxies : []).map(normalizeProxy);
    config.rules = (Array.isArray(source.rules) ? source.rules : []).slice(0, MAX_RULES).map(normalizeRule);

    const defaultRoute = source.defaultRoute && typeof source.defaultRoute === "object"
      ? source.defaultRoute : {};
    config.defaultRoute.mode = defaultRoute.mode === "proxy" || (!defaultRoute.mode && defaultRoute.proxyId) ? "proxy" : "direct";
    config.defaultRoute.proxyId = String(defaultRoute.proxyId || "");
    config.defaultRoute.fallbackProxyIds = normalizeIdList(
      defaultRoute.fallbackProxyIds,
      config.defaultRoute.proxyId
    );
    // Requirement: direct fallback is opt-in and off by default.
    config.defaultRoute.allowDirect = defaultRoute.allowDirect === true;
    // New installations default to the Windows local-address bypass behavior.
    // Preserve an explicit false from existing configurations unless <local> is present.
    const rawBypassPatterns = source.bypassPatterns || source.bypassList || [];
    const rawBypassValues = Array.isArray(rawBypassPatterns)
      ? rawBypassPatterns
      : String(rawBypassPatterns || "").split(/[;\r\n]+/);
    const hasLocalToken = rawBypassValues.some((item) => String(item).trim().toLowerCase() === "<local>");
    const sourceVersion = Number(source.version) || 0;
    // v2 used a different, broader local-network switch and defaulted it off.
    // On upgrade, adopt the Windows-compatible <local> default requested for v3.
    config.bypassLocal = hasLocalToken || sourceVersion < 3 || source.bypassLocal !== false;
    config.bypassPatterns = normalizeBypassPatterns(rawBypassPatterns);
    config.ui.iconClickAction = source.ui?.iconClickAction === "toggle" ? "toggle" : "popup";
    return config;
  }

  function validatePattern(pattern) {
    if (!pattern) return "匹配项不能为空";
    if (pattern.length > 253) return `匹配项过长：${pattern}`;
    if (pattern.includes("?")) return `暂不支持 ? 通配符：${pattern}`;
    if (!/^[a-z0-9*._-]+$/.test(pattern)) return `匹配项只能包含字母、数字、点、横线、下划线和 *：${pattern}`;
    if (pattern.includes("..")) return `匹配项包含连续的点：${pattern}`;
    if (pattern === "*") return "不允许使用单独的 *，这会让所有网站都命中该规则";
    return "";
  }

  function validateConfig(raw) {
    const config = sanitizeConfig(raw);
    const errors = [];
    const proxyIds = new Set();
    const endpoints = new Map();

    const needsProxy = config.defaultRoute.mode === "proxy" || config.rules.some((rule) => rule.enabled);
    if (needsProxy && config.proxies.length === 0) errors.push("当前配置需要至少一个 HTTP 代理节点");
    for (const proxy of config.proxies) {
      if (!proxy.id || proxyIds.has(proxy.id)) errors.push(`代理节点 ID 重复：${proxy.name || "未命名代理"}`);
      proxyIds.add(proxy.id);
      if (!proxy.name) errors.push("代理节点名称不能为空");
      if (!proxy.host) {
        errors.push(`${proxy.name || "代理节点"}的地址不能为空`);
      } else if (!/^[a-z0-9._-]+$/i.test(proxy.host) || proxy.host.includes("..")) {
        errors.push(`${proxy.name || "代理节点"}的地址格式无效，只能填写域名或 IPv4 地址`);
      }
      if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
        errors.push(`${proxy.name || "代理节点"}的端口必须在 1 到 65535 之间`);
      }
      const endpoint = `${proxy.host}:${proxy.port}`;
      if (proxy.host && endpoints.has(endpoint)) {
        errors.push(`代理地址重复：${endpoint}。自动认证无法区分同一地址端口下的不同账号`);
      } else if (proxy.host) {
        endpoints.set(endpoint, proxy.id);
      }
    }

    if (config.defaultRoute.mode === "proxy") {
      if (!config.defaultRoute.proxyId) {
        errors.push("未匹配网站选择使用默认代理时，必须选择一个代理节点");
      } else if (!proxyIds.has(config.defaultRoute.proxyId)) {
        errors.push("默认代理不存在或已被删除");
      }
      for (const id of config.defaultRoute.fallbackProxyIds) {
        if (!proxyIds.has(id)) errors.push("默认出口的回退代理不存在或已被删除");
      }
    }

    if (config.bypassPatterns.length > 500) errors.push("不走代理列表不能超过 500 项");
    for (const pattern of config.bypassPatterns) {
      const error = validateBypassPattern(pattern);
      if (error) errors.push(error);
    }

    const ruleIds = new Set();
    for (const rule of config.rules) {
      if (!rule.id || ruleIds.has(rule.id)) errors.push(`规则 ID 重复：${rule.name || "未命名规则"}`);
      ruleIds.add(rule.id);
      if (!rule.name) errors.push("规则名称不能为空");
      if (rule.patterns.length > MAX_PATTERNS_PER_RULE) errors.push(`${rule.name}的匹配项不能超过 ${MAX_PATTERNS_PER_RULE} 个`);
      for (const pattern of rule.patterns) {
        const error = validatePattern(pattern);
        if (error) errors.push(`${rule.name || "规则"}：${error}`);
      }
      // Disabled rules may remain incomplete while being edited.
      if (rule.enabled) {
        if (rule.patterns.length === 0) errors.push(`${rule.name || "规则"}至少需要一个匹配项`);
        if (!proxyIds.has(rule.proxyId)) errors.push(`${rule.name || "规则"}的主代理不存在或未选择`);
        for (const id of rule.fallbackProxyIds) {
          if (!proxyIds.has(id)) errors.push(`${rule.name || "规则"}的回退代理不存在或已被删除`);
        }
      }
    }

    return { ok: errors.length === 0, errors, config };
  }

  function globToRegExp(pattern) {
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i");
  }

  function matchPattern(hostInput, patternInput) {
    const host = normalizeHost(hostInput);
    const pattern = normalizePattern(patternInput);
    if (!host || !pattern) return false;
    if (!pattern.includes("*")) return host === pattern;
    return globToRegExp(pattern).test(host);
  }

  function matchRule(configInput, hostInput) {
    const config = sanitizeConfig(configInput);
    const host = normalizeHost(hostInput);
    for (let index = 0; index < config.rules.length; index += 1) {
      const rule = config.rules[index];
      if (!rule.enabled) continue;
      for (const pattern of rule.patterns) {
        if (matchPattern(host, pattern)) return { rule, index, pattern };
      }
    }
    return null;
  }

  function getProxy(config, id) {
    return config.proxies.find((proxy) => proxy.id === id) || null;
  }

  function routeToPac(config, primaryId, fallbackIds, allowDirect) {
    const ids = [primaryId, ...normalizeIdList(fallbackIds, primaryId)];
    const result = [];
    const seenEndpoints = new Set();
    for (const id of ids) {
      const proxy = getProxy(config, id);
      if (!proxy) continue;
      const endpoint = `${proxy.host}:${proxy.port}`;
      if (!seenEndpoints.has(endpoint)) {
        seenEndpoints.add(endpoint);
        result.push(`PROXY ${endpoint}`);
      }
    }
    if (allowDirect) result.push("DIRECT");
    return result.join("; ");
  }

  function sanitizeOverrides(raw, config) {
    const proxyIds = new Set(config.proxies.map((proxy) => proxy.id));
    const overrides = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const host = normalizeHost(item?.host);
      const mode = item?.mode === "direct" ? "direct" : "proxy";
      const proxyId = String(item?.proxyId || "");
      if (!host || (mode === "proxy" && !proxyIds.has(proxyId))) continue;
      overrides.push({
        host,
        mode,
        proxyId,
        includeSubdomains: item?.includeSubdomains !== false,
        createdAt: String(item?.createdAt || "")
      });
    }
    return overrides;
  }

  function findOverride(configInput, hostInput, overridesInput) {
    const config = sanitizeConfig(configInput);
    const host = normalizeHost(hostInput);
    if (!host) return null;
    const overrides = sanitizeOverrides(overridesInput, config);

    const exact = overrides.find((item) => item.host === host);
    if (exact) return exact;
    return overrides
      .filter((item) => item.includeSubdomains && host.endsWith(`.${item.host}`))
      .sort((a, b) => b.host.length - a.host.length)[0] || null;
  }

  function resolveRoute(configInput, hostInput, overridesInput, urlInput = "") {
    const config = sanitizeConfig(configInput);
    const host = normalizeHost(hostInput);
    const bypass = matchBypass(config, urlInput, host);
    if (bypass) {
      return {
        type: "bypass",
        name: bypass.local ? "本地地址直连" : "不走代理列表",
        host,
        pattern: bypass.pattern,
        proxyId: "",
        direct: true
      };
    }
    const override = findOverride(config, host, overridesInput);
    if (override) {
      return {
        type: "temporary",
        name: override.mode === "direct" ? "临时直连" : "临时指定代理",
        host,
        overrideHost: override.host,
        includeSubdomains: override.includeSubdomains,
        pattern: override.includeSubdomains ? `${override.host} 及其子域名` : override.host,
        proxyId: override.mode === "proxy" ? override.proxyId : "",
        direct: override.mode === "direct"
      };
    }
    const matched = matchRule(config, host);
    if (matched) {
      return {
        type: "rule",
        name: matched.rule.name,
        host,
        ruleId: matched.rule.id,
        ruleIndex: matched.index,
        pattern: matched.pattern,
        proxyId: matched.rule.proxyId,
        fallbackProxyIds: matched.rule.fallbackProxyIds,
        direct: false
      };
    }
    const defaultDirect = config.defaultRoute.mode === "direct";
    return {
      type: "default",
      name: defaultDirect ? "默认直连" : "默认出口",
      host,
      proxyId: defaultDirect ? "" : config.defaultRoute.proxyId,
      fallbackProxyIds: defaultDirect ? [] : config.defaultRoute.fallbackProxyIds,
      direct: defaultDirect
    };
  }

  function buildPacScript(rawConfig, overridesInput, extraOverridesInput) {
    const validation = validateConfig(rawConfig);
    if (!validation.ok) throw new Error(validation.errors.join("；"));
    const config = validation.config;
    const overrides = [
      ...sanitizeOverrides(extraOverridesInput, config),
      ...sanitizeOverrides(overridesInput, config)
    ];
    const seenHosts = new Set();
    const pacOverrides = [];
    for (const item of overrides) {
      if (seenHosts.has(item.host)) continue;
      seenHosts.add(item.host);
      pacOverrides.push({
        host: item.host,
        includeSubdomains: item.includeSubdomains,
        route: item.mode === "direct"
          ? "DIRECT"
          : routeToPac(config, item.proxyId, [], false)
      });
    }
    pacOverrides.sort((a, b) => b.host.length - a.host.length);

    const pacRules = config.rules.filter((rule) => rule.enabled).map((rule) => ({
      patterns: rule.patterns,
      route: routeToPac(config, rule.proxyId, rule.fallbackProxyIds, rule.allowDirect)
    }));
    const defaultRoute = config.defaultRoute.mode === "direct"
      ? "DIRECT"
      : routeToPac(
          config,
          config.defaultRoute.proxyId,
          config.defaultRoute.fallbackProxyIds,
          config.defaultRoute.allowDirect
        );

    const pacBypassPatterns = config.bypassPatterns.map(parseBypassPattern).filter(Boolean).map((item) => ({
      scheme: item.scheme || "",
      hostPattern: item.hostPattern || "",
      port: item.port || 0
    }));

    return `function FindProxyForURL(url, host) {\n  host = String(host || "").toLowerCase().replace(/\\.$/, "");\n  var urlText = String(url || "");\n  var schemeMatch = urlText.match(/^([a-z][a-z0-9+.-]*):\\/\\//i);\n  var scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "";\n  var authority = schemeMatch ? urlText.slice(schemeMatch[0].length).split(/[\\/?#]/, 1)[0] : "";\n  var portMatch = authority.match(/:(\\d+)$/);\n  var urlPort = portMatch ? Number(portMatch[1]) : (scheme === "https" ? 443 : (scheme === "http" ? 80 : 0));\n  var bypassLocal = ${config.bypassLocal ? "true" : "false"};\n  var bypassPatterns = ${JSON.stringify(pacBypassPatterns)};\n  var overrides = ${JSON.stringify(pacOverrides)};\n  var rules = ${JSON.stringify(pacRules)};\n\n  var isIpLiteral = /^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(host) || host.indexOf(":") >= 0;\n  if (bypassLocal && host.indexOf(".") < 0 && !isIpLiteral) return "DIRECT";\n  for (var b = 0; b < bypassPatterns.length; b++) {\n    var bypass = bypassPatterns[b];\n    if (bypass.scheme && bypass.scheme !== scheme) continue;\n    if (bypass.port && bypass.port !== urlPort) continue;\n    if ((bypass.hostPattern.indexOf("*") < 0 && host === bypass.hostPattern) ||\n        (bypass.hostPattern.indexOf("*") >= 0 && shExpMatch(host, bypass.hostPattern))) {\n      return "DIRECT";\n    }\n  }\n\n  for (var i = 0; i < overrides.length; i++) {\n    if (host === overrides[i].host ||\n        (overrides[i].includeSubdomains && host.slice(-(overrides[i].host.length + 1)) === "." + overrides[i].host)) {\n      return overrides[i].route;\n    }\n  }\n\n  for (var r = 0; r < rules.length; r++) {\n    for (var p = 0; p < rules[r].patterns.length; p++) {\n      var pattern = rules[r].patterns[p];\n      if ((pattern.indexOf("*") < 0 && host === pattern) ||\n          (pattern.indexOf("*") >= 0 && shExpMatch(host, pattern))) {\n        return rules[r].route;\n      }\n    }\n  }\n\n  return ${JSON.stringify(defaultRoute)};\n}`;
  }

  function buildProxyTestPac(proxy, basePacScript = "") {
    const normalized = normalizeProxy(proxy, 0);
    if (!normalized.host || normalized.port < 1 || normalized.port > 65535) {
      throw new Error("代理地址或端口无效");
    }
    const base = String(basePacScript || "");
    const renamedBase = base.replace(/function\s+FindProxyForURL\s*\(/, "function ProxyRouterBaseFindProxyForURL(");
    const hasBase = renamedBase !== base;
    return `${hasBase ? `${renamedBase}\n\n` : ""}function FindProxyForURL(url, host) {\n  host = String(host || "").toLowerCase().replace(/\\.$/, "");\n  if (host === "example.com") return "PROXY ${normalized.host}:${normalized.port}";\n  return ${hasBase ? "ProxyRouterBaseFindProxyForURL(url, host)" : '"DIRECT"'};\n}`;
  }

  function extractDefaultProxy(browserConfig) {
    const value = browserConfig && typeof browserConfig === "object" ? browserConfig : {};
    if (value.mode === "fixed_servers" && value.rules) {
      const rules = value.rules;
      const candidate = rules.singleProxy || rules.proxyForHttps || rules.proxyForHttp || rules.fallbackProxy;
      if (candidate?.host) {
        const scheme = String(candidate.scheme || "http").toLowerCase();
        if (scheme !== "http") {
          return {
            ok: false,
            sourceMode: "fixed_servers",
            note: `当前代理协议为 ${scheme}，本扩展只自动导入 HTTP 代理`
          };
        }
        return {
          ok: true,
          proxy: {
            id: createId("proxy"),
            name: "当前浏览器代理（自动导入）",
            host: normalizeHost(candidate.host),
            port: Number(candidate.port) || 80,
            username: "",
            password: ""
          },
          sourceMode: "fixed_servers",
          bypassLocal: Array.isArray(rules.bypassList) && rules.bypassList.some((item) => String(item).trim().toLowerCase() === "<local>"),
          bypassPatterns: normalizeBypassPatterns(Array.isArray(rules.bypassList)
            ? rules.bypassList.filter((item) => String(item).trim().toLowerCase() !== "<local>")
            : []),
          note: rules.singleProxy ? "已导入浏览器的统一代理及可读取的绕过列表" : "已优先导入 HTTPS/HTTP 代理及可读取的绕过列表；原配置可能对不同协议使用不同出口"
        };
      }
    }
    if (value.mode === "pac_script" && value.pacScript?.data) {
      const match = String(value.pacScript.data).match(/\bPROXY\s+([a-z0-9._-]+):(\d{1,5})/i);
      if (match) {
        return {
          ok: true,
          proxy: {
            id: createId("proxy"),
            name: "当前 PAC 首个代理（自动导入）",
            host: normalizeHost(match[1]),
            port: Number(match[2]),
            username: "",
            password: ""
          },
          sourceMode: "pac_script",
          bypassLocal: true,
          bypassPatterns: [],
          note: "只能从内嵌 PAC 中提取第一个 PROXY，无法可靠还原绕过规则，建议人工核对"
        };
      }
    }
    const reasonByMode = {
      system: "浏览器只返回 system 模式，扩展无法读取 Windows 中的具体代理地址和端口",
      auto_detect: "浏览器使用自动检测，扩展无法解析最终代理地址",
      pac_script: "PAC 配置没有可直接读取的内嵌 HTTP 代理",
      direct: "当前浏览器为直连模式，没有可作为默认值的代理"
    };
    return { ok: false, sourceMode: value.mode || "unknown", note: reasonByMode[value.mode] || "没有找到可导入的 HTTP 代理" };
  }

  function migrateLegacyConfig(legacy) {
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy.proxies)) return null;
    const proxies = [];
    const special = normalizeProxy({
      id: createId("proxy"),
      name: "原特定代理",
      host: legacy.specialProxy?.host,
      port: legacy.specialProxy?.port,
      username: "",
      password: ""
    }, 0);
    if (special.host) proxies.push(special);

    let defaultProxyId = "";
    if (legacy.defaultRoute?.mode === "proxy" && legacy.defaultRoute.proxy?.host) {
      const defaultProxy = normalizeProxy({
        id: createId("proxy"),
        name: "原默认代理",
        host: legacy.defaultRoute.proxy.host,
        port: legacy.defaultRoute.proxy.port,
        username: "",
        password: ""
      }, proxies.length);
      const same = proxies.find((proxy) => proxy.host === defaultProxy.host && proxy.port === defaultProxy.port);
      if (same) defaultProxyId = same.id;
      else {
        proxies.push(defaultProxy);
        defaultProxyId = defaultProxy.id;
      }
    }

    const patterns = normalizePatterns(legacy.domains || []);
    const rules = special.host && patterns.length ? [{
      id: createId("rule"),
      name: "从旧版本迁移的规则",
      enabled: true,
      patterns,
      proxyId: special.id,
      fallbackProxyIds: defaultProxyId && legacy.fallbackToDefault ? [defaultProxyId] : [],
      allowDirect: false
    }] : [];

    return sanitizeConfig({
      enabled: legacy.enabled === true && Boolean(defaultProxyId),
      proxies,
      rules,
      defaultRoute: { mode: defaultProxyId ? "proxy" : "direct", proxyId: defaultProxyId, fallbackProxyIds: [], allowDirect: false },
      bypassLocal: legacy.bypassLocal !== false,
      bypassPatterns: legacy.bypassPatterns || [],
      ui: { iconClickAction: "popup" }
    });
  }

  function withoutPasswords(rawConfig) {
    const config = sanitizeConfig(rawConfig);
    for (const proxy of config.proxies) proxy.password = "";
    return config;
  }

  return {
    CONFIG_VERSION,
    DEFAULT_CONFIG,
    createId,
    normalizeHost,
    getRegistrableDomain,
    normalizePattern,
    normalizePatterns,
    normalizeBypassPattern,
    normalizeBypassPatterns,
    parseBypassPattern,
    validateBypassPattern,
    matchBypassPattern,
    matchBypass,
    sanitizeConfig,
    sanitizeOverrides,
    findOverride,
    validateConfig,
    validatePattern,
    matchPattern,
    matchRule,
    resolveRoute,
    getProxy,
    routeToPac,
    buildPacScript,
    buildProxyTestPac,
    extractDefaultProxy,
    migrateLegacyConfig,
    withoutPasswords
  };
});
