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
//   }
//
// run に渡す ctx：
//   ctx.artist / ctx.title          … 入力中のアーティスト名・曲名
//   ctx.current()                   … 入力中の音域 { low, chestHigh, falsettoHigh }（音階の番号）
//   ctx.applyRange(range, extPatch) … 音域を入れる。extPatch は曲の保存欄 song.ext に足される
//
// song.ext は追加機能が自由に使う保存欄で、このリポジトリの画面では表示も変更もしない。
export const plugins = [];
