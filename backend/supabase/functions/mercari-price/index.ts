// ============================================================
//  mercari-price  ―  メルカリ売切実売相場プロキシ（Supabase Edge Function / Deno）
//  おたすけ君から  GET ?q=商品名  で叩くと、メルカリの「売り切れ」実売価格を
//  DPoP署名つき内部検索APIから取得し、中央値＋四分位帯で返す。
//
//  デプロイ:
//    supabase functions deploy mercari-price --no-verify-jwt
//  ローカル起動:
//    supabase functions serve mercari-price --no-verify-jwt
//  叩き方:
//    curl "https://<project>.supabase.co/functions/v1/mercari-price?q=ユニクロ+Tシャツ"
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// ---- DPoP(ES256) 署名JWT。セッション毎に鍵生成でOK・ログイン不要 ----
async function makeDpop(url: string, method: string): Promise<string> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y } };
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
    htu: url,
    htm: method,
    uuid: crypto.randomUUID(),
  };
  const signingInput = b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, enc.encode(signingInput));
  return signingInput + "." + b64url(sig);
}

async function searchMercari(keyword: string) {
  const url = "https://api.mercari.jp/v2/entities:search";
  const dpop = await makeDpop(url, "POST");
  const body = {
    userId: "", pageSize: 60, pageToken: "",
    searchSessionId: crypto.randomUUID().replace(/-/g, ""),
    indexRouting: "INDEX_ROUTING_UNSPECIFIED", thumbnailTypes: [],
    searchCondition: {
      keyword, excludeKeyword: "", sort: "SORT_CREATED_TIME", order: "ORDER_DESC",
      status: ["STATUS_SOLD_OUT"], sizeId: [], categoryId: [], brandId: [], sellerId: [],
      priceMin: 0, priceMax: 0, itemConditionId: [], shippingPayerId: [], shippingFromArea: [],
      shippingMethod: [], colorId: [], hasCoupon: false, attributes: [], itemTypes: [],
      skuIds: [], shopIds: [], excludeShippingMethodIds: [],
    },
    defaultDatasets: [], serviceFrom: "suruga",
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "DPoP": dpop, "X-Platform": "web",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept": "*/*", "Origin": "https://jp.mercari.com", "Referer": "https://jp.mercari.com/",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("mercari " + res.status);
  return await res.json();
}

const pctile = (a: number[], q: number) => {
  if (!a.length) return 0;
  const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round(a[lo] + (a[hi] - a[lo]) * (i - lo));
};
const round100 = (n: number) => Math.round(n / 100) * 100;

// ---- インスタンス内キャッシュ（ToS配慮・リクエスト削減）1時間 ----
const cache = new Map<string, { t: number; v: unknown }>();
const TTL = 60 * 60 * 1000;

async function handle(q: string) {
  const key = q.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  const j = await searchMercari(q);
  const items = (j.items || []).filter((i: any) => !i.isNoPrice && +i.price > 0);
  const prices = items.map((i: any) => +i.price).sort((a: number, b: number) => a - b);

  if (!prices.length) {
    const v = { ok: true, q, count: 0, numFound: +(j.meta?.numFound || 0), message: "売切データが見つかりませんでした" };
    cache.set(key, { t: Date.now(), v });
    return v;
  }

  // 外れ値トリム（下位5%・上位5%）した帯を推奨に
  const lo = Math.floor(prices.length * 0.05), hi = Math.ceil(prices.length * 0.95);
  const trimmed = prices.slice(lo, Math.max(lo + 1, hi));

  const v = {
    ok: true, q,
    numFound: +(j.meta?.numFound || 0),
    count: prices.length,
    min: prices[0],
    max: prices[prices.length - 1],
    median: pctile(prices, 0.5),
    p25: pctile(prices, 0.25),
    p75: pctile(prices, 0.75),
    // アプリが直接使う推奨（100円丸め）
    suggest: round100(pctile(trimmed, 0.5)),
    bandLow: round100(pctile(trimmed, 0.25)),
    bandHigh: round100(pctile(trimmed, 0.75)),
    samples: items.slice(0, 8).map((i: any) => ({
      name: i.name, price: +i.price,
      thumb: (i.thumbnails && i.thumbnails[0]) || "",
      url: "https://jp.mercari.com/item/" + i.id,
    })),
  };
  cache.set(key, { t: Date.now(), v });
  return v;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    let q = url.searchParams.get("q") || "";
    if (!q && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      q = body.q || "";
    }
    q = q.trim();
    if (!q) {
      return new Response(JSON.stringify({ ok: false, error: "q(商品名)が必要です" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const v = await handle(q);
    return new Response(JSON.stringify(v), {
      headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 502, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
