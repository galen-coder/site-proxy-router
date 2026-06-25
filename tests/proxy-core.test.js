const assert = require("node:assert/strict");
const vm = require("node:vm");
require("../public-suffix-data.js");
const Core = require("../proxy-core.js");

function shExpMatch(value, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

function evaluatePac(config, host, overrides = [], extraOverrides = [], url = `https://${host}/`) {
  const script = Core.buildPacScript(config, overrides, extraOverrides);
  const context = {
    String,
    isPlainHostName: (name) => !String(name).includes("."),
    shExpMatch
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return context.FindProxyForURL(url, host);
}

const config = Core.sanitizeConfig({
  version: 3,
  enabled: true,
  proxies: [
    { id: "p1", name: "代理一", host: "proxy1.local", port: 8001, username: "u1", password: "x1" },
    { id: "p2", name: "代理二", host: "proxy2.local", port: 8002, username: "u2", password: "x2" },
    { id: "p3", name: "默认代理", host: "default.local", port: 8080, username: "", password: "" }
  ],
  rules: [
    {
      id: "r1", name: "Google", enabled: true,
      patterns: ["*.google.com", "*googleapis*"],
      proxyId: "p1", fallbackProxyIds: ["p2"], allowDirect: false
    },
    {
      id: "r2", name: "精确网站", enabled: true,
      patterns: ["c.example.com", "d.example.com"],
      proxyId: "p2", fallbackProxyIds: [], allowDirect: false
    }
  ],
  defaultRoute: { proxyId: "p3", fallbackProxyIds: ["p2"], allowDirect: false },
  bypassLocal: false,
  bypassPatterns: [],
  ui: { iconClickAction: "popup" }
});

assert.equal(Core.validateConfig(config).ok, true);
assert.equal(Core.getRegistrableDomain("www.google.com"), "google.com");
assert.equal(Core.getRegistrableDomain("mail.google.com"), "google.com");
assert.equal(Core.getRegistrableDomain("www.example.co.uk"), "example.co.uk");
assert.equal(Core.getRegistrableDomain("foo.github.io"), "foo.github.io");
assert.equal(Core.getRegistrableDomain("127.0.0.1"), "127.0.0.1");

assert.equal(Core.matchPattern("mail.google.com", "*.google.com"), true);
assert.equal(Core.matchPattern("deep.mail.google.com", "*.google.com"), true);
assert.equal(Core.matchPattern("google.com", "*.google.com"), false);
assert.equal(Core.matchPattern("maps.googleapis.com", "*googleapis*"), true);
assert.equal(Core.matchPattern("not-google.example", "google.com"), false);

assert.equal(evaluatePac(config, "mail.google.com"), "PROXY proxy1.local:8001; PROXY proxy2.local:8002");
assert.equal(evaluatePac(config, "google.com"), "PROXY default.local:8080; PROXY proxy2.local:8002");
assert.equal(evaluatePac(config, "c.example.com"), "PROXY proxy2.local:8002");
assert.equal(evaluatePac(config, "other.example.com"), "PROXY default.local:8080; PROXY proxy2.local:8002");

const bypassConfig = Core.sanitizeConfig({
  ...config,
  bypassLocal: true,
  bypassPatterns: [
    "*.direct.example.com",
    "*internal*",
    "https://secure.example.com:443",
    ".subonly.example.com",
    "10.*"
  ]
});
assert.equal(evaluatePac(bypassConfig, "printer", [], [], "http://printer/"), "DIRECT");
assert.notEqual(evaluatePac(bypassConfig, "127.0.0.1", [], [], "http://127.0.0.1/"), "DIRECT");
assert.equal(evaluatePac(bypassConfig, "api.direct.example.com"), "DIRECT");
assert.notEqual(evaluatePac(bypassConfig, "direct.example.com"), "DIRECT");
assert.equal(evaluatePac(bypassConfig, "my-internal-service.example"), "DIRECT");
assert.equal(evaluatePac(bypassConfig, "secure.example.com", [], [], "https://secure.example.com/"), "DIRECT");
assert.notEqual(evaluatePac(bypassConfig, "secure.example.com", [], [], "http://secure.example.com/"), "DIRECT");
assert.equal(evaluatePac(bypassConfig, "a.subonly.example.com"), "DIRECT");
assert.notEqual(evaluatePac(bypassConfig, "subonly.example.com"), "DIRECT");
assert.equal(evaluatePac(bypassConfig, "10.2.3.4", [], [], "http://10.2.3.4/"), "DIRECT");
assert.equal(Core.resolveRoute(bypassConfig, "api.direct.example.com", [], "https://api.direct.example.com/").type, "bypass");
assert.equal(
  evaluatePac(bypassConfig, "api.direct.example.com", [{ host: "direct.example.com", mode: "proxy", proxyId: "p1", includeSubdomains: true }]),
  "DIRECT"
);
assert.equal(Core.normalizeBypassPatterns("<local>; *.contoso.com;\nhttps://secure.example.com:443").length, 2);
assert.equal(Core.matchBypassPattern("https://a.contoso.com/", "a.contoso.com", "*.contoso.com"), true);
assert.equal(Core.matchBypassPattern("https://contoso.com/", "contoso.com", "*.contoso.com"), false);


const firstMatchConfig = Core.sanitizeConfig({
  ...config,
  rules: [
    { id: "first", name: "先匹配", enabled: true, patterns: ["*example*"], proxyId: "p1", fallbackProxyIds: [], allowDirect: false },
    { id: "second", name: "后匹配", enabled: true, patterns: ["c.example.com"], proxyId: "p2", fallbackProxyIds: [], allowDirect: false }
  ]
});
assert.equal(evaluatePac(firstMatchConfig, "c.example.com"), "PROXY proxy1.local:8001");
assert.equal(Core.matchRule(firstMatchConfig, "c.example.com").rule.id, "first");

assert.equal(
  evaluatePac(config, "mail.google.com", [{ host: "mail.google.com", mode: "direct" }]),
  "DIRECT"
);
assert.equal(
  evaluatePac(config, "other.example.com", [{ host: "other.example.com", mode: "proxy", proxyId: "p1" }]),
  "PROXY proxy1.local:8001"
);
assert.equal(
  evaluatePac(config, "api.other.example.com", [{ host: "other.example.com", mode: "proxy", proxyId: "p1", includeSubdomains: true }]),
  "PROXY proxy1.local:8001"
);
assert.equal(
  evaluatePac(config, "api.other.example.com", [{ host: "other.example.com", mode: "proxy", proxyId: "p1", includeSubdomains: false }]),
  "PROXY default.local:8080; PROXY proxy2.local:8002"
);
const nestedOverrides = [
  { host: "example.com", mode: "proxy", proxyId: "p1", includeSubdomains: true },
  { host: "api.example.com", mode: "proxy", proxyId: "p2", includeSubdomains: true }
];
assert.equal(evaluatePac(config, "v2.api.example.com", nestedOverrides), "PROXY proxy2.local:8002");
assert.equal(Core.findOverride(config, "v2.api.example.com", nestedOverrides).host, "api.example.com");
const inheritedRoute = Core.resolveRoute(config, "cdn.other.example.com", [
  { host: "other.example.com", mode: "proxy", proxyId: "p1", includeSubdomains: true }
]);
assert.equal(inheritedRoute.type, "temporary");
assert.equal(inheritedRoute.overrideHost, "other.example.com");
assert.equal(inheritedRoute.includeSubdomains, true);

const disabledIncomplete = Core.validateConfig({
  ...config,
  rules: [{ id: "draft", name: "未完成草稿", enabled: false, patterns: [], proxyId: "", fallbackProxyIds: [], allowDirect: false }]
});
assert.equal(disabledIncomplete.ok, true);

const invalidMissingDefault = Core.validateConfig({ ...config, defaultRoute: { mode: "proxy", proxyId: "", fallbackProxyIds: [], allowDirect: false } });
assert.equal(invalidMissingDefault.ok, false);
assert.ok(invalidMissingDefault.errors.some((item) => item.includes("必须选择一个代理节点")));

const directDefault = Core.sanitizeConfig({ enabled: true, proxies: [], rules: [], defaultRoute: { mode: "direct" } });
assert.equal(Core.validateConfig(directDefault).ok, true);
assert.equal(Core.resolveRoute(directDefault, "unmatched.example.com", []).direct, true);
assert.equal(evaluatePac(directDefault, "unmatched.example.com", []), "DIRECT");

const migratedV3Default = Core.sanitizeConfig({ version: 3, proxies: config.proxies, rules: [], defaultRoute: { proxyId: "p3", fallbackProxyIds: [], allowDirect: false } });
assert.equal(migratedV3Default.defaultRoute.mode, "proxy");
const explicitDirectWithStaleProxy = Core.sanitizeConfig({ version: 4, proxies: config.proxies, rules: [], defaultRoute: { mode: "direct", proxyId: "p3" } });
assert.equal(explicitDirectWithStaleProxy.defaultRoute.mode, "direct");

const invalidDuplicateEndpoint = Core.validateConfig({
  ...config,
  proxies: [...config.proxies, { id: "p4", name: "重复", host: "proxy1.local", port: 8001 }]
});
assert.equal(invalidDuplicateEndpoint.ok, false);
assert.ok(invalidDuplicateEndpoint.errors.some((item) => item.includes("代理地址重复")));

const extracted = Core.extractDefaultProxy({
  mode: "fixed_servers",
  rules: {
    singleProxy: { scheme: "http", host: "system.proxy", port: 3128 },
    bypassList: ["<local>", "*.contoso.com", "10.*"]
  }
});
assert.equal(extracted.ok, true);
assert.equal(extracted.proxy.host, "system.proxy");
assert.equal(extracted.proxy.port, 3128);
assert.equal(extracted.bypassLocal, true);
assert.deepEqual(extracted.bypassPatterns, ["*.contoso.com", "10.*"]);
assert.equal(Core.extractDefaultProxy({ mode: "system" }).ok, false);
assert.equal(Core.sanitizeConfig({}).bypassLocal, true);
assert.equal(Core.sanitizeConfig({ version: 3, bypassLocal: false }).bypassLocal, false);
assert.equal(Core.sanitizeConfig({ version: 2, bypassLocal: false }).bypassLocal, true);
assert.equal(Core.sanitizeConfig({ bypassLocal: false, bypassPatterns: ["<local>"] }).bypassLocal, true);

const anonymous = Core.withoutPasswords(config);
assert.equal(anonymous.proxies.every((proxy) => proxy.password === ""), true);
assert.equal(anonymous.proxies[0].username, "u1");

const legacy = Core.migrateLegacyConfig({
  enabled: true,
  specialProxy: { scheme: "http", host: "old-special", port: 7001 },
  defaultRoute: { mode: "proxy", proxy: { scheme: "http", host: "old-default", port: 7002 } },
  domains: ["*.legacy.com"],
  fallbackToDefault: true
});
assert.equal(legacy.proxies.length, 2);
assert.equal(legacy.rules.length, 1);
assert.equal(legacy.enabled, true);
assert.equal(Core.validateConfig(legacy).ok, true);

const basePac = Core.buildPacScript(config, []);
const testPac = Core.buildProxyTestPac({ id: "test", name: "测试代理", host: "test.proxy", port: 9000 }, basePac);
const testContext = { String, isPlainHostName: (name) => !String(name).includes("."), shExpMatch };
vm.createContext(testContext);
vm.runInContext(testPac, testContext);
assert.equal(testContext.FindProxyForURL("https://example.com/", "example.com"), "PROXY test.proxy:9000");
assert.equal(testContext.FindProxyForURL("https://mail.google.com/", "mail.google.com"), "PROXY proxy1.local:8001; PROXY proxy2.local:8002");

console.log("proxy-core tests passed");
