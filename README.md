# Discord Recruitment Bot

ゲーム、イベント、勉強会、作業会などの参加者募集と日程調整をDiscord内で完結させる、複数サーバー対応Botです。

実運用しているBotから、公開配布に必要な機能だけを独立させたリポジトリです。ホームラボ管理、ホスト操作、内部ネットワーク連携などのprivate機能は含みません。

## 主な機能

- 募集カードの作成、編集、参加、取消し、補欠、締切
- 開始日時、事前通知、時間締切、VC集合による自動締切
- サーバーごとの募集設定と最大20件のテンプレート
- 常設募集パネル、履歴からの再作成、募集一覧
- 日程投票と参加統計
- IGDBによるゲーム名候補・カバー画像（任意）
- X投稿画面への共有リンク（自動投稿やX認証は行いません）
- guild単位のデータ分離、Discord Markdown無害化、入力上限

## セキュリティ境界

- Guild Install / Guild Contextのみ
- Privileged Gateway Intentsは不使用
- Discord Bot tokenとIGDB Client Secretはソース管理外
- Dockerは非root、read-only root filesystem、capabilityなし
- 外部公開ポートなし。Discord Gatewayへのoutbound通信のみ
- guild IDを保存データと操作時に照合し、サーバー間操作を拒否

Botに必要なDiscord権限は、View Channels、Send Messages、Embed Links、Read Message History、Mention Everyone、Use Application Commandsです。Administrator権限は不要です。

## セットアップ

Node.js 22以降が必要です。

```bash
npm ci
cp .env.example .env
```

Discord Developer Portalで専用Applicationを作成し、`.env`へ`CLIENT_ID`と`DISCORD_TOKEN`を設定します。実トークンをGitへ追加しないでください。

最初は検証用サーバーだけへコマンドを登録します。

```dotenv
PUBLIC_STAGING_GUILD_ID=検証用サーバーID
```

```bash
npm run deploy
npm start
```

動作確認後、`PUBLIC_STAGING_GUILD_ID`を削除して`npm run deploy`を再実行すると、8個のコマンドをグローバル登録します。Discord側へのグローバル反映には時間がかかる場合があります。

## Docker Compose

```bash
cp settings.env.example settings.env
mkdir -p secrets
install -m 600 /dev/null secrets/discord_token
# エディタでsecrets/discord_tokenへtokenを保存

docker compose build
docker compose run --rm discord-recruitment-bot node deploy-commands.js
docker compose up -d
```

永続データは`discord-bot-data` volumeへ保存されます。tokenや実データはimageとGit管理対象に入りません。

IGDBをDockerで有効にする場合は、`settings.env`へ`IGDB_CLIENT_ID`だけを設定し、Client Secretは専用secretへ保存します。

```bash
install -m 600 /dev/null secrets/igdb_client_secret
# エディタでsecrets/igdb_client_secretへClient Secretを保存

docker compose -f compose.yaml -f compose.igdb.yaml up -d
```

## 開発

```bash
npm test
npm run test:coverage
docker compose config
docker build .
```

テストでは、guild間分離、コマンド境界、入力検証、通知状態、永続化、Docker設定を確認します。

## ライセンス

[MIT License](LICENSE)
