# おたすけ君 実データ連携 backend（メルカリ売切相場プロキシ）

おたすけ君から商品名を投げると、メルカリの**「売り切れ」実売価格**を取ってきて
中央値＋四分位帯で返す Supabase Edge Function。ルールベースの推測を「本物の相場」に置き換える。

## なぜ backend が要るか
- メルカリの検索結果は **DPoP（ES256/ECDSA署名）** つきの内部APIでしか取れない。
- GAS(Apps Script)はES256署名ができない → **Deno（Supabase Edge）** で動かす。
- ブラウザから直接メルカリを叩くのはCORSで不可 → このプロキシ経由にする。

## デプロイ手順（くみこがやるのはこれだけ）

```bash
# 1) Supabase CLI（未導入なら）
brew install supabase/tap/supabase

# 2) このフォルダで
cd output/smasell-promo-2026-06/seller-tool/backend
supabase login                      # ブラウザで一度だけ認可
supabase link --project-ref <Re:alizeのproject-ref>   # 既存Supabaseに紐付け

# 3) デプロイ（--no-verify-jwt で公開GETを許可）
supabase functions deploy mercari-price --no-verify-jwt
```

デプロイすると URL が出る：
```
https://<project-ref>.supabase.co/functions/v1/mercari-price
```

## 動作確認
```bash
curl "https://<project-ref>.supabase.co/functions/v1/mercari-price?q=ユニクロ+Tシャツ"
# => {"ok":true,"median":800,"bandLow":600,"bandHigh":1000,"numFound":2950,...}
```

## アプリ側の設定
`seller-tool/index.html` の先頭付近にある
```js
var MERCARI_API = ""; // ← ここにデプロイで出たURLを貼る
```
にこのURLを貼るだけ。空のままなら従来のルールベース値付けで動く（後方互換）。

## 注意
- メルカリ内部APIのスクレイピングは**ToSグレー**。少人数の値付け補助用途で低リスクだが、
  Function内に**1時間キャッシュ**を入れてリクエスト量を抑えている。
- 大量アクセスするとIP遮断/レート制限の可能性あり。生徒配布規模（〜200人）なら問題ない想定。
- ローカル検証コード雛形: `/tmp/dpop_test.mjs`, `/tmp/agg.mjs`（Node版）。
