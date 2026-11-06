// 追加機能（プラグイン）の一覧。このリポジトリでは何も入れない。
// 別の場所で、このファイルを差し替えて機能を足せるようにしている。
//
// プラグインの形：
//   {
//     id: string,
//     // 登録・編集画面の「音域」の下に出すボタン
//     rangeAction?: {
//       label: string,
//       icon?: string,  // index.html にあるアイコン名（search など）
//       run(ctx): Promise<void>,
//     },
//     // 曲の詳細画面で、音域の表の下に足す HTML
//     detailHTML?(song): string,
//     // 曲の音域をまとめて補う（テキストからまとめて追加した直後と、設定の「音域の取り込み」から呼ぶ）
//     rangeBatch?: {
//       label: string,   // 設定のボタンの名前
//       hint?: string,   // 設定のボタンの下の説明
//       run(items, ctx): void,  // items：[{ id, artist, title }]。待たずに戻ってよい（画面の表示も追加機能が持つ）
//     },
//     // 曲の詳細画面の「試聴」で選べる音源
//     previewSource?: {
//       id: string,
//       label: string,                       // 音源を切り替えるボタンの名前
//       hint?: string,                       // 音源がまだ決まっていないときの説明
//       info?(song): { text, link?: { href, label } } | null,  // 決まっている音源の説明
//       resolve(song, ctx, { refresh }): Promise<string | null>,  // 再生する URL（refresh：取り直す）。
//                                    // 失敗の理由を見せるときは、Error に userMessage を付けて投げる
//       pick?: { label: string, run(song, ctx): Promise<boolean> },  // 音源を選び直す（変えたら true）
//     },
//   }
//
// run に渡す ctx：
//   ctx.artist / ctx.title          … 入力中のアーティスト名・曲名
//   ctx.current()                   … 入力中の音域 { low, chestHigh, falsettoHigh }（音階の番号）
//   ctx.applyRange(range, extPatch) … 音域を入れる。extPatch は曲の保存欄 song.ext に足される
//
// rangeBatch に渡す ctx：
//   ctx.getSong(id)                      … 今の曲（消えていれば null）
//   ctx.applyRange(id, range, extPatch)  … 音域を入れて保存する（値がある項目は変えない）。入れなければ false
//   ctx.openSong(id)                     … 曲の詳細画面を開く
//
// previewSource に渡す ctx：
//   ctx.saveExt(patch) … 曲の保存欄 song.ext に足して保存する
//
// song.ext は追加機能が自由に使う保存欄で、このリポジトリの画面では表示も変更もしない。
export const plugins = [];
