// ==UserScript==
// @name              OpenKrill Share Link Resolver
// @name:zh-CN        OpenKrill 网盘分享链接解析
// @namespace         https://tools.openkrill.app/sharelink
// @version           0.1.0
// @description       Turns a public Google Drive share link into a direct download URL with Aria2, Motrix and curl hand-off, and lists the files in a Baidu Netdisk share. Public links only.
// @description:zh-CN 把公开的 Google Drive 分享链接转成直链，可发送到 Aria2、Motrix 或复制 curl 命令；列出百度网盘分享里的文件。只处理公开分享。
// @author            OpenKrill
// @homepageURL       https://tools.openkrill.app/sharelink
// @supportURL        https://tools.openkrill.app/sharelink
// @license           MIT
// @match             https://drive.google.com/file/d/*
// @match             https://drive.google.com/drive/folders/*
// @match             https://drive.google.com/drive/u/*/folders/*
// @match             https://drive.google.com/open*
// @match             https://docs.google.com/document/d/*
// @match             https://docs.google.com/spreadsheets/d/*
// @match             https://docs.google.com/presentation/d/*
// @match             https://pan.baidu.com/s/*
// @match             https://pan.baidu.com/share/init*
// @match             https://yun.baidu.com/s/*
// @grant             GM_xmlhttpRequest
// @grant             GM_getValue
// @grant             GM_setValue
// @connect           drive.google.com
// @connect           drive.usercontent.google.com
// @connect           docs.google.com
// @connect           pan.baidu.com
// @connect           localhost
// @connect           127.0.0.1
// @run-at            document-idle
// @noframes
// @downloadURL       https://tools.openkrill.app/sharelink/openkrill-sharelink.user.js
// @updateURL         https://tools.openkrill.app/sharelink/openkrill-sharelink.user.js
// ==/UserScript==

// Source, license and the web version: https://tools.openkrill.app/sharelink (MIT).

"use strict";
(() => {
  // src/adapter.ts
  var DEFAULT_TIMEOUT_MS = 12e3;
  var MAX_ENTRIES = 200;
  var OUR_USER_AGENT = "OpenKrill-ShareLink/1.0 (+https://tools.openkrill.app/sharelink)";
  function fetchWithTimeout(deps, url, init = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", OUR_USER_AGENT);
    return deps.fetch(url, { ...init, headers, redirect: init.redirect ?? "follow", signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  }
  function emptyAnswer(provider, status, message, download = "none") {
    return { status, provider, title: null, message, download, files: [], truncated: false };
  }
  function fileEntry(entry) {
    return { path: null, is_folder: false, size_bytes: null, modified: null, direct_url: null, handoff: null, ...entry };
  }
  function formatBytes(bytes) {
    const units = ["bytes", "KB", "MB", "GB", "TB"];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${i ? n.toFixed(1) : n} ${units[i]}`;
  }
  async function mapLimited(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // src/handoff.ts
  var ARIA2_RPC_URL = "http://localhost:6800/jsonrpc";
  var MOTRIX_RPC_URL = "http://localhost:16800/jsonrpc";
  var shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  function safeFileName(name) {
    const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]+/g, "_").replace(/^[.-]+/, "").trim();
    return cleaned.slice(0, 200) || "download";
  }
  function handoffFor(directUrl, name) {
    const out = safeFileName(name);
    return {
      curl: `curl -L --fail -o ${shellQuote(out)} ${shellQuote(directUrl)}`,
      aria2c: `aria2c -x 4 -s 4 -o ${shellQuote(out)} ${shellQuote(directUrl)}`,
      aria2_rpc: { jsonrpc: "2.0", id: "openkrill-sharelink", method: "aria2.addUri", params: [[directUrl], { out }] }
    };
  }

  // src/baidu.ts
  var PROVIDER = "baidu";
  var ORIGIN = "https://pan.baidu.com";
  var WEB_QUERY = "web=1&channel=chunlei&app_id=250528&clienttype=0";
  var SURL = /^[A-Za-z0-9_-]{4,64}$/;
  var PWD = /^[A-Za-z0-9]{4}$/;
  var SIGN_IN_NOTE = "Baidu serves the bytes only to a signed-in account: open the share, choose Save to my Baidu drive (\u4FDD\u5B58\u5230\u7F51\u76D8), then download from your own drive in the Baidu app or browser.";
  function parse(url) {
    if (url.hostname !== "pan.baidu.com" && url.hostname !== "yun.baidu.com") return null;
    const pwd = url.searchParams.get("pwd") ?? void 0;
    const short = url.pathname.match(/^\/s\/1([A-Za-z0-9_-]+)\/?$/)?.[1];
    const surl = short ?? (url.pathname === "/share/init" ? url.searchParams.get("surl") : null);
    if (!surl || !SURL.test(surl)) return null;
    return { kind: "share", id: surl, password: pwd && PWD.test(pwd) ? pwd : void 0 };
  }
  var Jar = class {
    values = /* @__PURE__ */ new Map();
    take(res) {
      const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z0-9_]+=)/);
      for (const line of lines) {
        const pair = line.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        if (eq > 0) this.values.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    set(name, value) {
      this.values.set(name, value);
    }
    header() {
      return [...this.values].map(([k, v]) => `${k}=${v}`).join("; ");
    }
  };
  function listStatus(errno) {
    if (errno === 9019) return { status: "need_password", message: "This Baidu share needs its 4-character extraction code (\u63D0\u53D6\u7801). Pass it as password, or add ?pwd=<code> to the link." };
    if (errno === -9) return { status: "wrong_password", message: "Baidu did not accept this extraction code. Check the code with the person who shared the link." };
    if (errno === -62) return { status: "unavailable", message: "Baidu asks for a captcha after several wrong codes. Open the link in a browser, or try again later." };
    if (errno === 140 || errno === 2 || errno === -7 || errno === 105 || errno === 115 || errno === 145) {
      return { status: "not_found", message: "Baidu says this share does not exist, expired, or was taken down." };
    }
    return { status: "unavailable", message: `Baidu answered with error ${errno}. Try again later.` };
  }
  var iso = (seconds) => {
    const n = Number(seconds);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1e3).toISOString() : null;
  };
  function toFile(entry, shareUrl) {
    const isFolder = String(entry.isdir) === "1";
    const size2 = Number(entry.size);
    return fileEntry({
      name: entry.server_filename ?? "",
      path: entry.path ?? null,
      is_folder: isFolder,
      size_bytes: isFolder || !Number.isFinite(size2) ? null : size2,
      modified: iso(entry.server_mtime),
      open_url: shareUrl
    });
  }
  async function getJson(deps, jar, url, init = {}) {
    const res = await fetchWithTimeout(deps, url, { ...init, headers: { ...init.headers, cookie: jar.header(), referer: `${ORIGIN}/` } });
    jar.take(res);
    return await res.json();
  }
  async function resolveShare(link, password, deps) {
    const code = (password ?? link.password)?.trim();
    if (code !== void 0 && !PWD.test(code)) return emptyAnswer(PROVIDER, "wrong_password", "A Baidu extraction code is 4 letters or digits.");
    const shareUrl = `${ORIGIN}/s/1${link.id}${code ? `?pwd=${code}` : ""}`;
    const jar = new Jar();
    try {
      const page = await fetchWithTimeout(deps, `${ORIGIN}/s/1${link.id}`, { redirect: "manual" });
      jar.take(page);
      void page.body?.cancel().catch(() => void 0);
      if (code) {
        const verify = await getJson(deps, jar, `${ORIGIN}/share/verify?surl=${encodeURIComponent(link.id)}&t=${Date.now()}&${WEB_QUERY}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `pwd=${encodeURIComponent(code)}&vcode=&vcode_str=`
        });
        if (verify.errno !== 0) return emptyAnswer(PROVIDER, listStatus(verify.errno ?? -1).status, listStatus(verify.errno ?? -1).message);
        const randsk = verify.randsk;
        if (randsk) jar.set("BDCLND", randsk);
      }
      const root = await getJson(deps, jar, `${ORIGIN}/share/list?shorturl=${encodeURIComponent(link.id)}&dir=%2F&root=1&page=1&num=${MAX_ENTRIES + 1}&order=name&desc=0&${WEB_QUERY}`);
      if (root.errno !== 0) {
        const { status, message } = listStatus(root.errno ?? -1);
        return emptyAnswer(PROVIDER, status, message);
      }
      let entries = root.list ?? [];
      let title = root.title ?? null;
      const only = entries.length === 1 ? entries[0] : null;
      if (only && String(only.isdir) === "1" && only.path && root.uk && root.share_id) {
        const inner = await getJson(deps, jar, `${ORIGIN}/share/list?uk=${root.uk}&shareid=${root.share_id}&dir=${encodeURIComponent(only.path)}&page=1&num=${MAX_ENTRIES + 1}&order=name&desc=0&${WEB_QUERY}`);
        if (inner.errno === 0 && inner.list) {
          entries = inner.list;
          title = only.path;
        }
      }
      const files = entries.slice(0, MAX_ENTRIES).map((e) => toFile(e, shareUrl));
      const total = files.reduce((n, f) => n + (f.size_bytes ?? 0), 0);
      const count = `${files.length} item${files.length === 1 ? "" : "s"}${total ? ` (${formatBytes(total)} in files)` : ""}`;
      return { status: "ok", provider: PROVIDER, title: title?.replace(/^.*\//, "") || null, message: `The share lists ${count}. ${SIGN_IN_NOTE}`, download: "sign_in_required", files, truncated: entries.length > MAX_ENTRIES };
    } catch {
      return emptyAnswer(PROVIDER, "unavailable", "Baidu did not answer in time. Try again in a minute.");
    }
  }
  var baidu = {
    record: {
      id: PROVIDER,
      name: "Baidu Netdisk (\u767E\u5EA6\u7F51\u76D8)",
      hosts: ["pan.baidu.com", "yun.baidu.com"],
      link_examples: ["https://pan.baidu.com/s/1<code>?pwd=abcd", "https://pan.baidu.com/share/init?surl=<code>"],
      endpoint: "pan.baidu.com/share/verify and /share/list (the public share page's own calls)",
      auth_need: "provider_sign_in",
      direct_download: false,
      folders: true,
      surfaces: ["web", "mcp", "userscript"],
      last_verified: "2026-10-17",
      notes: "Lists the files, sizes and dates any visitor of the link sees, with the extraction code when the share has one. Baidu serves the bytes only to a signed-in account through its own app, so no direct URL is returned and no speed limit is touched."
    },
    parse,
    resolve: resolveShare
  };

  // src/google-drive.ts
  var ID = /^[A-Za-z0-9_-]{10,}$/;
  var PROVIDER2 = "google_drive";
  var DOC_EXPORTS = {
    document: { path: "export?format=docx", ext: "docx" },
    spreadsheets: { path: "export?format=xlsx", ext: "xlsx" },
    presentation: { path: "export/pptx", ext: "pptx" },
    drawings: { path: "export/png", ext: "png" }
  };
  var MAX_PROBES = 40;
  var driveDownloadUrl = (id) => `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
  var docExportUrl = (variant, id) => `https://docs.google.com/${variant}/d/${encodeURIComponent(id)}/${DOC_EXPORTS[variant].path}`;
  var openUrl = (link) => link.kind === "folder" ? `https://drive.google.com/drive/folders/${link.id}` : link.kind === "doc" ? `https://docs.google.com/${link.variant}/d/${link.id}/edit` : `https://drive.google.com/file/d/${link.id}/view`;
  function parse2(url) {
    const host = url.hostname;
    const path = url.pathname;
    const idParam = url.searchParams.get("id") ?? "";
    if (host === "docs.google.com") {
      const doc = path.match(/^\/(document|spreadsheets|presentation|drawings)\/d\/([A-Za-z0-9_-]+)/);
      if (doc) return { kind: "doc", variant: doc[1], id: doc[2] };
      const file2 = path.match(/^\/file\/d\/([A-Za-z0-9_-]+)/);
      if (file2) return { kind: "file", id: file2[1] };
      return path === "/uc" && ID.test(idParam) ? { kind: "file", id: idParam } : null;
    }
    if (host === "drive.usercontent.google.com") return ID.test(idParam) ? { kind: "file", id: idParam } : null;
    if (host !== "drive.google.com") return null;
    const folder = path.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/);
    if (folder) return { kind: "folder", id: folder[1] };
    const file = path.match(/^\/file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/);
    if (file) return { kind: "file", id: file[1] };
    if ((path === "/open" || path === "/uc" || path === "/embeddedfolderview") && ID.test(idParam)) return { kind: path === "/embeddedfolderview" ? "folder" : "file", id: idParam };
    return null;
  }
  function dispositionName(header) {
    if (!header) return null;
    const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
    if (star) {
      try {
        return decodeURIComponent(star[1].trim());
      } catch {
      }
    }
    const plain = header.match(/filename\s*=\s*"([^"]*)"/) ?? header.match(/filename\s*=\s*([^;]+)/);
    return plain ? plain[1].trim() : null;
  }
  async function probe(deps, url) {
    let res;
    try {
      res = await fetchWithTimeout(deps, url, { headers: { range: "bytes=0-0" } });
    } catch {
      return { ok: false, status: "unavailable" };
    }
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 404) return drop(res, { ok: false, status: "not_found" });
    if (res.status === 401 || res.status === 403) return drop(res, { ok: false, status: "private" });
    if (res.status >= 500 || res.status === 429) return drop(res, { ok: false, status: "unavailable" });
    if (type.includes("text/html")) {
      const html = await res.text();
      return { ok: false, status: /too many users|quota/i.test(html) ? "quota" : "private" };
    }
    const total = res.headers.get("content-range")?.match(/\/(\d+)$/)?.[1] ?? (res.status === 200 ? res.headers.get("content-length") : null);
    return drop(res, { ok: true, name: dispositionName(res.headers.get("content-disposition")), size: total ? Number(total) : null });
  }
  function drop(res, value) {
    void res.body?.cancel().catch(() => void 0);
    return value;
  }
  var PROBE_MESSAGES = {
    not_found: "Google Drive has no file at this link. Check the link with the person who shared it.",
    private: "Google Drive does not serve this file without a sign-in: it is private or limited to some accounts. Ask the owner to set it to Anyone with the link, or open it while signed in.",
    quota: "Google Drive paused downloads of this file for today because many people downloaded it. Try again in 24 hours, or ask the owner for a copy.",
    unavailable: "Google Drive did not answer in time. Try again in a minute."
  };
  async function resolveFile(link, deps) {
    const direct = link.kind === "doc" ? docExportUrl(link.variant, link.id) : driveDownloadUrl(link.id);
    const found = await probe(deps, direct);
    if (!found.ok) return emptyAnswer(PROVIDER2, found.status, PROBE_MESSAGES[found.status]);
    const name = found.name ?? (link.kind === "doc" ? `${link.id}.${DOC_EXPORTS[link.variant].ext}` : link.id);
    const file = fileEntry({ name, size_bytes: found.size, open_url: openUrl(link), direct_url: direct, handoff: handoffFor(direct, name) });
    const what = link.kind === "doc" ? `the Google ${link.variant} file exported as ${DOC_EXPORTS[link.variant].ext}` : "the file";
    return { status: "ok", provider: PROVIDER2, title: name, message: `The direct URL downloads ${what} with no sign-in.`, download: "direct", files: [file], truncated: false };
  }
  var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };
  var decodeHtml = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (ENTITIES[code.toLowerCase()]) return ENTITIES[code.toLowerCase()];
    const point = code.startsWith("#x") ? parseInt(code.slice(2), 16) : code.startsWith("#") ? Number(code.slice(1)) : NaN;
    return point <= 1114111 ? String.fromCodePoint(point) : m;
  });
  var safeHref = (url) => {
    try {
      return new URL(url).protocol === "https:" ? url : null;
    } catch {
      return null;
    }
  };
  function parseFolderView(html) {
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
    const entries = [];
    for (const block of html.split('<div class="flip-entry"').slice(1)) {
      const href = block.match(/<a href="([^"]+)"/)?.[1];
      const name = block.match(/<div class="flip-entry-title">([^<]*)<\/div>/)?.[1];
      if (!href || name === void 0) continue;
      const url = decodeHtml(href);
      let link = null;
      try {
        link = parse2(new URL(url));
      } catch {
        link = null;
      }
      entries.push({ title: decodeHtml(name), link, href: url });
    }
    return { title: title ? decodeHtml(title) : null, entries };
  }
  async function resolveFolder(link, deps) {
    let res;
    try {
      res = await fetchWithTimeout(deps, `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(link.id)}`);
    } catch {
      return emptyAnswer(PROVIDER2, "unavailable", PROBE_MESSAGES.unavailable);
    }
    if (res.status === 404) return drop(res, emptyAnswer(PROVIDER2, "not_found", "Google Drive has no folder at this link, or it is not shared with Anyone with the link."));
    if (!res.ok) return drop(res, emptyAnswer(PROVIDER2, res.status >= 500 ? "unavailable" : "private", res.status >= 500 ? PROBE_MESSAGES.unavailable : PROBE_MESSAGES.private));
    const html = await res.text();
    if (!html.includes("flip-entries")) return emptyAnswer(PROVIDER2, "private", PROBE_MESSAGES.private);
    const view = parseFolderView(html);
    const listed = view.entries.slice(0, MAX_ENTRIES);
    let probes = 0;
    const files = await mapLimited(listed, 6, async (entry) => {
      const child = entry.link;
      if (!child) return fileEntry({ name: entry.title, open_url: safeHref(entry.href) ?? `https://drive.google.com/drive/folders/${link.id}` });
      if (child.kind === "folder") return fileEntry({ name: entry.title, is_folder: true, open_url: openUrl(child) });
      const direct2 = child.kind === "doc" ? docExportUrl(child.variant, child.id) : driveDownloadUrl(child.id);
      const found = child.kind !== "doc" && probes++ < MAX_PROBES ? await probe(deps, direct2) : null;
      if (found && !found.ok) return fileEntry({ name: entry.title, open_url: openUrl(child) });
      const name = found?.name ?? (child.kind === "doc" ? `${entry.title}.${DOC_EXPORTS[child.variant].ext}` : entry.title);
      return fileEntry({ name, size_bytes: found?.size ?? null, open_url: openUrl(child), direct_url: direct2, handoff: handoffFor(direct2, name) });
    });
    const direct = files.filter((f) => f.direct_url).length;
    const folders = files.filter((f) => f.is_folder).length;
    const message = files.length ? `The folder lists ${files.length} item${files.length === 1 ? "" : "s"}: ${direct} with a direct URL${folders ? `, ${folders} subfolder${folders === 1 ? "" : "s"} to resolve on their own` : ""}.` : "The folder is shared but empty.";
    return { status: "ok", provider: PROVIDER2, title: view.title, message, download: direct ? "direct" : "none", files, truncated: view.entries.length > listed.length };
  }
  var googleDrive = {
    record: {
      id: PROVIDER2,
      name: "Google Drive",
      hosts: ["drive.google.com", "drive.usercontent.google.com", "docs.google.com"],
      link_examples: ["https://drive.google.com/file/d/<id>/view", "https://drive.google.com/drive/folders/<id>", "https://docs.google.com/document/d/<id>/edit"],
      endpoint: "drive.usercontent.google.com/download (public download), drive.google.com/embeddedfolderview (public folder list), docs.google.com export",
      auth_need: "none",
      direct_download: true,
      folders: true,
      surfaces: ["web", "mcp", "userscript"],
      last_verified: "2026-10-17",
      notes: "Files shared as Anyone with the link. Large files skip the virus-scan notice with Google's own confirm flag. Docs, Sheets and Slides export as docx, xlsx and pptx. A folder lists one level."
    },
    parse: parse2,
    resolve: (link, _password, deps) => link.kind === "folder" ? resolveFolder(link, deps) : resolveFile(link, deps)
  };

  // src/registry.ts
  var ADAPTERS = [googleDrive, baidu];
  function detect(url) {
    for (const adapter of ADAPTERS) {
      const link = adapter.parse(url);
      if (link) return { adapter, link };
    }
    return null;
  }

  // src/resolve.ts
  function firstUrl(text) {
    const raw = text.trim().match(/https?:\/\/[^\s<>"'，。]+/)?.[0] ?? (/^[\w.-]+\.[a-z]{2,}\//i.test(text.trim()) ? `https://${text.trim()}` : null);
    if (!raw) return null;
    try {
      return new URL(raw);
    } catch {
      return null;
    }
  }
  function codeFromText(text) {
    return text.match(/(?:提取码|密码|code|pwd)\s*[:：=]?\s*([A-Za-z0-9]{4})\b/i)?.[1];
  }
  async function resolveShareLink(input, deps) {
    const url = firstUrl(input.url);
    if (!url || url.protocol !== "https:" && url.protocol !== "http:") return emptyAnswer(null, "unsupported", "Send a share link that starts with https://.");
    const found = detect(url);
    if (!found) {
      const names = ADAPTERS.map((a) => a.record.name).join(" and ");
      return emptyAnswer(null, "unsupported", `This link is not from a drive the resolver knows yet. Slice 1 covers ${names}; list_share_providers shows the current registry.`);
    }
    const password = input.password?.trim() || found.link.password || codeFromText(input.url);
    return found.adapter.resolve(found.link, password, deps);
  }

  // userscript/main.ts
  var ZH = /^zh/i.test(navigator.language);
  var TEXT = ZH ? {
    button: "\u89E3\u6790",
    title: "OpenKrill \u5206\u4EAB\u94FE\u63A5\u89E3\u6790",
    reading: "\u6B63\u5728\u8BFB\u53D6\u5206\u4EAB\u9875\u2026",
    code: "\u63D0\u53D6\u7801",
    retry: "\u7528\u63D0\u53D6\u7801\u91CD\u8BD5",
    download: "\u4E0B\u8F7D",
    open: "\u6253\u5F00",
    copy: "\u590D\u5236",
    copied: "\u5DF2\u590D\u5236",
    aria2: "\u53D1\u9001\u5230 Aria2",
    motrix: "\u53D1\u9001\u5230 Motrix",
    sent: "\u5DF2\u52A0\u5165\u4E0B\u8F7D\u961F\u5217",
    noRpc: "\u6CA1\u6709\u8FDE\u4E0A\u3002\u8BF7\u5148\u542F\u52A8\u7A0B\u5E8F\uFF0C\u5E76\u5F00\u542F RPC\u3002",
    secret: "RPC \u5BC6\u94A5",
    saveSecret: "\u4FDD\u5B58\u5BC6\u94A5\u540E\u91CD\u8BD5",
    close: "\u5173\u95ED",
    failed: "\u6CA1\u6709\u89E3\u6790\u6210\u529F\uFF1A",
    more: "\u5206\u4EAB\u91CC\u8FD8\u6709\u66F4\u591A\u6587\u4EF6\uFF0C\u5217\u8868\u53EA\u663E\u793A\u524D 200 \u9879\u3002"
  } : {
    button: "Resolve",
    title: "OpenKrill Share Link Resolver",
    reading: "Reading the share page\u2026",
    code: "Extraction code",
    retry: "Try with this code",
    download: "Download",
    open: "Open",
    copy: "Copy",
    copied: "Copied",
    aria2: "Send to Aria2",
    motrix: "Send to Motrix",
    sent: "Added to the download queue",
    noRpc: "No answer. Start the program with RPC turned on first.",
    secret: "RPC secret",
    saveSecret: "Save the secret and try again",
    close: "Close",
    failed: "The link did not resolve: ",
    more: "The share holds more files; this list shows the first 200."
  };
  var STYLE = `
:host { all: initial; }
.ok-fab, .ok-panel { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #1d1d1b; }
.ok-fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; padding: 10px 18px; border: 0; border-radius: 999px; background: #0b5cad; color: #fff; font-weight: 600; cursor: pointer; }
.ok-fab:focus-visible, .ok-panel button:focus-visible, .ok-panel a:focus-visible, .ok-panel input:focus-visible { outline: 2px solid #0b5cad; outline-offset: 2px; }
.ok-panel { position: fixed; right: 20px; bottom: 72px; z-index: 2147483647; box-sizing: border-box; width: min(440px, calc(100vw - 32px)); max-height: min(70vh, 640px); overflow: auto; padding: 16px; border: 1px solid #dcdcd4; border-radius: 8px; background: #fbfbf9; }
.ok-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
.ok-head strong { font-size: 15px; }
.ok-msg { margin: 0 0 8px; color: #5c5c57; overflow-wrap: anywhere; }
.ok-file { border-top: 1px solid #dcdcd4; padding: 8px 0; }
.ok-name { font-weight: 600; overflow-wrap: anywhere; }
.ok-meta { color: #5c5c57; font-size: 12px; }
.ok-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; align-items: center; }
.ok-panel a { color: #0b5cad; }
.ok-panel button { padding: 4px 10px; border: 1px solid #dcdcd4; border-radius: 8px; background: #fff; color: #1d1d1b; font: inherit; cursor: pointer; }
.ok-panel input { padding: 4px 8px; border: 1px solid #dcdcd4; border-radius: 8px; font: inherit; width: 8em; }
@media (prefers-color-scheme: dark) {
  .ok-fab { background: #6db3f2; color: #10151b; }
  .ok-panel { background: #1c1c1a; border-color: #3a3a36; color: #eeeee8; }
  .ok-msg, .ok-meta { color: #b4b4ac; }
  .ok-file { border-color: #3a3a36; }
  .ok-panel a { color: #6db3f2; }
  .ok-panel button, .ok-panel input { background: #262624; border-color: #3a3a36; color: #eeeee8; }
}`;
  function parseHeaders(raw) {
    const headers = new Headers();
    for (const line of raw.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    return headers;
  }
  function asResponse(res) {
    const status = res.status >= 200 && res.status <= 599 ? res.status : 200;
    const empty = status === 204 || status === 205 || status === 304;
    const response = new Response(empty ? null : res.responseText, { status });
    Object.defineProperty(response, "headers", { value: parseHeaders(res.responseHeaders) });
    return response;
  }
  function gmFetch(url, init = {}) {
    const headers = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    return new Promise((resolve, reject) => {
      const request = GM_xmlhttpRequest({
        method: init.method ?? "GET",
        url,
        headers,
        data: typeof init.body === "string" ? init.body : void 0,
        anonymous: true,
        cookie: headers.cookie,
        redirect: init.redirect === "manual" ? "manual" : "follow",
        onload: (res) => resolve(asResponse(res)),
        onerror: () => reject(new TypeError(`Could not reach ${new URL(url).host}`)),
        ontimeout: () => reject(new TypeError(`${new URL(url).host} took too long`))
      });
      init.signal?.addEventListener("abort", () => {
        request.abort();
        reject(init.signal?.reason);
      });
    });
  }
  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== void 0) node.textContent = text;
    return node;
  }
  function button(label, onClick) {
    const b = el("button", { type: "button" }, label);
    b.addEventListener("click", () => onClick(b));
    return b;
  }
  function size(bytes) {
    return bytes === null ? "" : formatBytes(bytes);
  }
  function sendToRpc(endpoint, body) {
    const secret = GM_getValue("rpcSecret", "");
    const call = secret ? { ...body.aria2_rpc, params: [`token:${secret}`, ...body.aria2_rpc.params] } : body.aria2_rpc;
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: endpoint,
        headers: { "content-type": "application/json" },
        data: JSON.stringify(call),
        anonymous: true,
        timeout: 5e3,
        onload: (res) => {
          try {
            const answer = JSON.parse(res.responseText || "{}");
            resolve(answer.result ? "sent" : answer.error?.message ?? "error");
          } catch {
            resolve("error");
          }
        },
        onerror: () => resolve("offline"),
        ontimeout: () => resolve("offline")
      });
    });
  }
  var Panel = class {
    root;
    constructor(shadow) {
      this.root = el("div", { class: "ok-panel", role: "dialog", "aria-label": TEXT.title });
      shadow.append(this.root);
    }
    frame(message) {
      this.root.replaceChildren();
      const head = el("div", { class: "ok-head" });
      head.append(el("strong", {}, TEXT.title), button(TEXT.close, () => this.close()));
      const body = el("div", { "aria-live": "polite" });
      body.append(el("p", { class: "ok-msg" }, message));
      this.root.append(head, body);
      return body;
    }
    close() {
      this.root.remove();
    }
    reading() {
      this.frame(TEXT.reading);
    }
    failed(error) {
      this.frame(TEXT.failed + (error instanceof Error ? error.message : String(error)));
    }
    show(out, retry) {
      const body = this.frame(out.message);
      if (out.status === "need_password" || out.status === "wrong_password") body.append(this.codeRow(retry));
      for (const file of out.files) body.append(this.fileBlock(file));
      if (out.truncated) body.append(el("p", { class: "ok-msg" }, TEXT.more));
    }
    codeRow(retry) {
      const row = el("div", { class: "ok-row" });
      const input = el("input", { type: "text", maxlength: "8", "aria-label": TEXT.code, placeholder: TEXT.code, autocomplete: "off" });
      input.addEventListener("keydown", (e) => e.key === "Enter" && retry(input.value.trim()));
      row.append(input, button(TEXT.retry, () => retry(input.value.trim())));
      queueMicrotask(() => input.focus());
      return row;
    }
    fileBlock(file) {
      const block = el("div", { class: "ok-file" });
      block.append(el("div", { class: "ok-name" }, file.name));
      const meta = [size(file.size_bytes), file.modified?.slice(0, 10) ?? ""].filter(Boolean).join(" \xB7 ");
      if (meta) block.append(el("div", { class: "ok-meta" }, meta));
      const row = el("div", { class: "ok-row" });
      if (file.direct_url) row.append(el("a", { href: file.direct_url, rel: "noopener noreferrer" }, TEXT.download));
      else row.append(el("a", { href: file.open_url, rel: "noopener noreferrer", target: "_blank" }, TEXT.open));
      if (file.handoff) row.append(...this.handoffButtons(file.handoff, block));
      block.append(row);
      return block;
    }
    handoffButtons(handoff, block) {
      const note = el("div", { class: "ok-meta", "aria-live": "polite" });
      queueMicrotask(() => block.append(note));
      const send = (endpoint) => async (b) => {
        b.disabled = true;
        const result = await sendToRpc(endpoint, handoff);
        b.disabled = false;
        note.textContent = result === "sent" ? TEXT.sent : result === "offline" ? TEXT.noRpc : result;
        if (result === "Unauthorized") block.append(this.secretRow(() => send(endpoint)(b)));
      };
      const copy = (text) => async (b) => {
        await navigator.clipboard.writeText(text);
        b.textContent = TEXT.copied;
      };
      return [button(TEXT.aria2, send(ARIA2_RPC_URL)), button(TEXT.motrix, send(MOTRIX_RPC_URL)), button(`${TEXT.copy} curl`, copy(handoff.curl)), button(`${TEXT.copy} aria2c`, copy(handoff.aria2c))];
    }
    secretRow(again) {
      const row = el("div", { class: "ok-row" });
      const input = el("input", { type: "password", "aria-label": TEXT.secret, placeholder: TEXT.secret, autocomplete: "off" });
      row.append(
        input,
        button(TEXT.saveSecret, () => {
          GM_setValue("rpcSecret", input.value.trim());
          row.remove();
          again();
        })
      );
      return row;
    }
  };
  function mount() {
    const host = el("div", { id: "openkrill-sharelink" });
    const shadow = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLE);
    shadow.adoptedStyleSheets = [sheet];
    let panel = null;
    const run = async (password) => {
      panel?.close();
      panel = new Panel(shadow);
      panel.reading();
      try {
        const out = await resolveShareLink({ url: location.href, password }, { fetch: gmFetch });
        panel.show(out, (code) => void run(code));
      } catch (error) {
        panel.failed(error);
      }
    };
    const fab = el("button", { type: "button", class: "ok-fab", title: TEXT.title }, TEXT.button);
    fab.addEventListener("click", () => void run());
    shadow.append(fab);
    document.documentElement.append(host);
  }
  mount();
})();
