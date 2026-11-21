// 再生の試験の Service Worker。
// - 画面のファイルは入れたときに保存（shell-v2）。音声はページの「保存する」で audio-v1 に入れる。
// - 保存済みの音声に Range 要求が来たら、保存した全体から切り出して 206 で返す（iPhone の Safari 対策）。
// - 「保存する」の取り直し（?fresh=1）は保存を経由せずネットワークから取る（11/21 Sol 高2）。
// - 何を返したか（保存から／ネット／206 の範囲）をページへ知らせて、試験の記録に残す（Sol 高2・中1）。
const SHELL = "shell-v3", AUDIO = "audio-v1";
const SHELL_FILES = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith("shell-") && k !== SHELL) await caches.delete(k);
  await self.clients.claim();
})()));

async function tell(clientId, msg) {
  try {
    const one = clientId ? await self.clients.get(clientId) : null;   // 音の要求は clientId で引けないことがある＝全部へ（Hydrogen 低10）
    const list = one ? [one] : await self.clients.matchAll({ type: "window" });
    for (const c of list) if (c) c.postMessage({ sw: msg });
  } catch (_) {}
}

// 単一範囲だけを受ける（RFC 9110 §14.1.2）。合わない書式は null＝全体を 200 で返す。
function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((h || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") {                       // bytes=-N（末尾 N バイト）
    const n = parseInt(m[2], 10);
    if (n === 0) return { bad: true };
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
    if (m[2] !== "" && parseInt(m[2], 10) < start) return null;   // 逆順は無効な指定＝無視して全体
  }
  if (start >= size) return { bad: true };
  return { start, end };
}

// 保存した音声を返す。Range なし・書式外は全体を 200（Accept-Ranges つき）／HEAD は本体なし（Hydrogen 中6）。
// 全体を配列に広げず Blob のまま切る（長い音声でメモリを食わない）。
async function cachedResponse(req, cached, clientId) {
  const blob = await cached.blob();
  const size = blob.size;
  const type = cached.headers.get("Content-Type") || "audio/mp4";
  const head = req.method === "HEAD";
  const h = req.headers.get("range");
  const r = h ? parseRange(h, size) : null;
  if (!r) {
    tell(clientId, h ? `保存から 200（Range 書式外 "${h}"）` : `保存から 200（Range なし${head ? "・HEAD" : ""}）`);
    return new Response(head ? null : blob, { status: 200, headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" } });
  }
  if (r.bad) {
    tell(clientId, `保存から 416（${h} / ${size}）`);
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  tell(clientId, `保存から 206 ${r.start}-${r.end}/${size}${head ? "・HEAD" : ""}`);
  return new Response(head ? null : blob.slice(r.start, r.end + 1, type), {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Range": `bytes ${r.start}-${r.end}/${size}`,
      "Content-Length": String(r.end - r.start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

self.addEventListener("message", e => {
  if (e.data === "ping") e.source && e.source.postMessage({ sw: "pong " + SHELL });
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method === "HEAD" && !url.pathname.endsWith(".m4a")) return;
  if (req.method !== "GET" && req.method !== "HEAD") return;
  e.respondWith((async () => {
    if (url.pathname.endsWith(".m4a")) {
      if (url.searchParams.has("fresh")) {           // 保存し直し＝保存を通さない
        tell(e.clientId, "ネットから取得（保存し直し）" + url.pathname.split("/").pop());
        return fetch(req, { cache: "reload" });
      }
      const c = await caches.open(AUDIO);
      const hit = await c.match(url.origin + url.pathname);
      if (hit) return cachedResponse(req, hit, e.clientId);
      tell(e.clientId, "保存に無い→ネット " + url.pathname.split("/").pop());
      return fetch(req);
    }
    const hit = await caches.match(req, { ignoreSearch: true });
    return hit || fetch(req);
  })());
});
