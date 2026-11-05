# 音域ノート（range-note）

カラオケで歌う曲を、音域とキーとあわせて管理する Web アプリ。

## 機能

- 曲の登録・編集・削除（アーティスト、曲名、最低音・地声最高音・裏声最高音、キー）
- 一覧からのキー変更（±1、原キー、オク下）。キーに合わせて音域の表示も変わる
- 自分の音域にもとづくおすすめキーの表示
- 検索、アーティスト・タグ・お気に入り・音域での絞り込み、並び替え
- 登録済みアーティスト名の入力候補
- お気に入り、タグ、採点、メモ、歌った回数・最終歌唱日の記録
- ランダム選曲
- CSV の書き出し・読み込み
- ホーム画面への追加（PWA）、オフラインでの表示

## 構成

- HTML / CSS / JavaScript（ビルドなし）
- Firebase Authentication（Google ログイン）
- Cloud Firestore（端末内キャッシュあり）

## セットアップ

1. Firebase プロジェクトを作成し、ウェブアプリを登録する
2. Authentication で Google ログインを有効にし、公開先のドメインを承認済みドメインに追加する
3. Firestore Database を作成し、`firestore.rules` の内容をルールに設定する
4. `js/config.js` の `FIREBASE_CONFIG` に firebaseConfig を設定する

`FIREBASE_CONFIG` が `null` の場合は、ブラウザ内にだけ保存するローカルモードで動作する。

## 開発

```bash
python -m http.server 8080
```

```bash
npm test
```

ほとんどのコーディングは生成AIです。
