export const config = {
  runtime: "edge",
  regions: ["hnd1"],
};

const SECRET_TOKEN = "MY_TOKEN_123";

const UPSTREAM_SCRIPT_SOURCES = [
  "https://greasyfork.org",
  "https://sleazyfork.org",
];

// 內建最新驗證通過的 43 位完整金鑰與網域（防 GreasyFork 阻擋機房 IP）
const BUILTIN_HOST = "javxy.cc.cd";
const BUILTIN_TOKEN = "107,77,29,99,68,73,100,102,111,103,102,72,104,95,105,111,103,65,127,73,64,64,76,97,108,16,115,18,73,20,21,95,66,28,19,81,68,112,104,74,74,83,66"
  .split(",")
  .map((n) => String.fromCharCode(Number(n) ^ 37))
  .join("");

let cachedUpstream = { host: "", token: "", ts: 0, source: "" };

function extractCredentialsFromScript(code) {
  if (!code || code.length < 1000) return null;

  let host = "";
  const hostMatches = [...code.matchAll(/String\.fromCharCode\.apply\(null,\[([\d,\s]+)\]\)/g)];
  for (const m of hostMatches) {
    const decoded = m
      .at(1)
      .split(",")
      .map((n) => String.fromCharCode(Number(n.trim())))
      .join("");
    if (decoded.includes(".") && !decoded.startsWith("worker.") && decoded.length >= 6) {
      host = decoded;
      break;
    }
  }

  let token = "";
  const tokenMatch =
    code.match(/token\(\)\{return\[([\d,\s]+)\]\.map/) ||
    code.match(/\[([\d,\s]{40,})\]\.map\(\w+=>String\.fromCharCode\(\w+\^37\)\)/);

  if (tokenMatch) {
    token = tokenMatch
      .at(1)
      .split(",")
      .map((n) => String.fromCharCode(Number(n.trim()) ^ 37))
      .join("");
  }

  return host && token ? { host, token } : null;
}

async function getDynamicUpstreamConfig(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedUpstream.host && cachedUpstream.token && now - cachedUpstream.ts < 1800000) {
    return cachedUpstream;
  }

  for (const srcUrl of UPSTREAM_SCRIPT_SOURCES) {
    try {
      const res = await fetch(`${srcUrl}?_t=${Math.floor(now / 60000)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Cache-Control": "no-cache",
        },
      });
      if (!res.ok) continue;

      const scriptText = await res.text();
      const parsed = extractCredentialsFromScript(scriptText);
      if (parsed) {
        cachedUpstream = {
          host: parsed.host,
          token: parsed.token,
          ts: now,
          source: srcUrl,
        };
        return cachedUpstream;
      }
    } catch (e) {}
  }

  return {
    host: cachedUpstream.host || BUILTIN_HOST,
    token: cachedUpstream.token || BUILTIN_TOKEN,
    ts: now,
    source: "builtin-verified",
  };
}

export default async function handler(request) {
  const url = new URL(request.url);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Javxy-Token, X-Javxy-Principal, Range",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 0. 自動同步狀態檢查介面：GET /api/sync-status
  if (url.pathname === "/api/sync-status") {
    const force = url.searchParams.get("refresh") === "1";
    const cfg = await getDynamicUpstreamConfig(force);
    return jsonOut(
      {
        status: "ok",
        syncedHost: cfg.host,
        tokenLength: cfg.token ? cfg.token.length : 0,
        lastSyncTime: new Date(cfg.ts).toISOString(),
        source: cfg.source,
      },
      200,
      corsHeaders
    );
  }

  // 1. 演員三圍資料介面
  if (url.pathname === "/api/actors") {
    if (request.headers.get("X-Javxy-Token") !== SECRET_TOKEN) {
      return jsonOut({ error: "Unauthorized" }, 401, corsHeaders);
    }

    const bodyText = await request.text();
    const principal = request.headers.get("X-Javxy-Principal") || `anon_${Date.now().toString(36)}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const upstream = await getDynamicUpstreamConfig(attempt === 1);
      try {
        const upRes = await fetch(`https://${upstream.host}/api/actors?client=laosiji-new`, {
          method: "POST",
          headers: {
            "Accept": "application/json,text/plain,*/*",
            "Content-Type": "application/json",
            "X-Javxy-Token": upstream.token,
            "X-Javxy-Principal": principal,
          },
          body: bodyText,
        });

        if (upRes.ok) {
          const data = await upRes.text();
          return new Response(data, {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=86400",
              ...corsHeaders,
            },
          });
        }

        if (upRes.status === 401 || upRes.status === 403) continue;
        break;
      } catch (e) {}
    }

    return jsonOut({ profiles: [] }, 200, corsHeaders);
  }
  // 2. 中轉狀態檢查
  if (url.pathname === "/api/trailers/proxy/status") {
    return jsonOut({ enabled: true }, 200, corsHeaders);
  }

  // 3. 串流反向代理
  if (url.pathname === "/proxy") {
    const qToken = url.searchParams.get("token");
    const hToken = request.headers.get("X-Javxy-Token");
    if (qToken !== SECRET_TOKEN && hToken !== SECRET_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl || !targetUrl.startsWith("http")) {
      return new Response("Invalid URL", { status: 400 });
    }
    return proxyStream(request, url.origin, targetUrl, corsHeaders);
  }

  // 4. 預告片查詢
  const segs = url.pathname.split("/").filter(Boolean);
  if (segs.at(0) !== "api" || segs.at(1) !== "trailers" || !segs.at(2)) {
    return jsonOut({ error: "Not Found" }, 404, corsHeaders);
  }

  if (request.headers.get("X-Javxy-Token") !== SECRET_TOKEN) {
    return jsonOut({ error: "Unauthorized" }, 401, corsHeaders);
  }

  const code = decodeURIComponent(segs.at(2)).trim().toUpperCase();
  const principal = request.headers.get("X-Javxy-Principal") || `anon_${Date.now().toString(36)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const upstream = await getDynamicUpstreamConfig(attempt === 1);
    try {
      const upUrl = new URL(`https://${upstream.host}/api/trailers/${encodeURIComponent(code)}`);
      url.searchParams.forEach((v, k) => upUrl.searchParams.set(k, v));
      upUrl.searchParams.set("client", "laosiji-new");

      const upRes = await fetch(upUrl.href, {
        headers: {
          "Accept": "application/json,text/plain,*/*",
          "X-Javxy-Token": upstream.token,
          "X-Javxy-Principal": principal,
        },
      });

      if (upRes.ok) {
        const rawText = await upRes.text();
        try {
          const json = JSON.parse(rawText);
          const wrapProxy = (u) => {
            if (!u || typeof u !== "string") return u;
            // 若原本已經帶有原作者的 /proxy，替換成你自己的東京 Vercel 代理
            if (u.includes("/proxy?token=")) {
              return u.replace(/https?:\/\/[^"'\s]+\/proxy\?token=[^&"'\s]+/, `${url.origin}/proxy?token=${SECRET_TOKEN}`);
            }
            // 若是直連的 FANZA / DMM 網址，強制包一層東京代理繞過海外 IP 封鎖
            if (u.includes("dmm.co.jp")) {
              return `${url.origin}/proxy?token=${SECRET_TOKEN}&url=${encodeURIComponent(u)}`;
            }
            return u;
          };

          if (json.trailer) json.trailer = wrapProxy(json.trailer);
          if (json.qualities && typeof json.qualities === "object") {
            for (const q of Object.keys(json.qualities)) {
              json.qualities[q] = wrapProxy(json.qualities[q]);
            }
          }
          json.proxy = true;

          return new Response(JSON.stringify(json), {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              ...corsHeaders,
            },
          });
        } catch (e) {}
      }


  // 備援：本地 JavTrailers 抓取
  const rawVideoUrl = await fetchFromJavTrailers(code);
  if (!rawVideoUrl) {
    return jsonOut({ error: "Trailer not found", code }, 404, corsHeaders);
  }

  const proxiedUrl = `${url.origin}/proxy?token=${SECRET_TOKEN}&url=${encodeURIComponent(rawVideoUrl)}`;
  const isHls = rawVideoUrl.includes(".m3u8");

  return jsonOut(
    {
      code,
      trailer: proxiedUrl,
      source: "JavTrailers",
      type: isHls ? "hls" : "video",
      quality: "720p",
      proxy: true,
      qualities: { "720p": proxiedUrl },
    },
    200,
    corsHeaders
  );
}

// 串流反向代理
async function proxyStream(request, serverOrigin, targetUrl, corsHeaders) {
  const targetObj = new URL(targetUrl);
  const reqHeaders = new Headers();
  reqHeaders.set(
    "User-Agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );

  if (targetObj.hostname.includes("dmm.co.jp")) {
    reqHeaders.set("Referer", "https://dmm.co.jp");
  } else {
    reqHeaders.set("Referer", `${targetObj.origin}/`);
  }

  const range = request.headers.get("Range");
  if (range) reqHeaders.set("Range", range);

  const upstream = await fetch(targetUrl, { method: request.method, headers: reqHeaders });
  const outHeaders = new Headers(corsHeaders);
  const cType = upstream.headers.get("Content-Type") || "";
  if (cType) outHeaders.set("Content-Type", cType);

  if (targetUrl.includes(".m3u8") && upstream.ok) {
    const m3u8Text = await upstream.text();
    const toProxy = (rawPath) => {
      const absUrl = new URL(rawPath, targetUrl).href;
      return `${serverOrigin}/proxy?token=${SECRET_TOKEN}&url=${encodeURIComponent(absUrl)}`;
    };

    const rewritten = m3u8Text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/gi, (_, uri) => `URI="${toProxy(uri)}"`);
        }
        return toProxy(trimmed);
      })
      .join("\n");

    outHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    return new Response(rewritten, { status: upstream.status, headers: outHeaders });
  }

  ["Content-Length", "Content-Range", "Accept-Ranges"].forEach((h) => {
    const val = upstream.headers.get(h);
    if (val) outHeaders.set(h, val);
  });

  outHeaders.set("Cache-Control", "public, max-age=86400");
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

// 備援抓取 JavTrailers 預告片
async function fetchFromJavTrailers(code) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "ja,en-US;q=0.9",
  };
  const host = "https://javtrailers.com";
  const sRes = await fetch(`${host}/search/${encodeURIComponent(code)}`, { headers });
  if (!sRes.ok) return null;

  const sHtml = await sRes.text();
  const idx = sHtml.indexOf("/video/");
  if (idx === -1) return null;

  let endIdx = idx + 7;
  while (endIdx < sHtml.length && !"\"'?# >".includes(sHtml[endIdx])) {
    endIdx++;
  }
  const videoPath = sHtml.slice(idx, endIdx);

  const dRes = await fetch(host + videoPath, { headers });
  if (!dRes.ok) return null;

  const dHtml = await dRes.text();
  const cleanHtml = dHtml.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  return extractMediaUrl(cleanHtml, ".m3u8") || extractMediaUrl(cleanHtml, ".mp4");
}

function extractMediaUrl(html, ext) {
  const extIdx = html.indexOf(ext);
  if (extIdx === -1) return "";
  const startIdx = html.lastIndexOf("http", extIdx);
  if (startIdx === -1) return "";

  let endIdx = extIdx + ext.length;
  while (endIdx < html.length && !"\"' <>\\".includes(html[endIdx])) {
    endIdx++;
  }
  const url = html.slice(startIdx, endIdx);
  return url.startsWith("http") ? url : "";
}

function jsonOut(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
