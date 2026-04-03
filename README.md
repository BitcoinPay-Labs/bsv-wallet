# BSV Wallet

BSV (Bitcoin SV) ブラウザウォレット。秘密鍵（WIF形式）でログインし、Mainnet / Testnet の両方に対応しています。

## Demo

https://dist-smoky-rho-81.vercel.app

## Features

- **WIF秘密鍵ログイン** - WIF (Wallet Import Format) 形式の秘密鍵でログイン
- **Mainnet / Testnet 対応** - ネットワーク切り替えが可能
- **残高表示** - 確認済み・未確認の残高をリアルタイム表示
- **BSV送金** - アドレスと金額を指定して送金
- **取引履歴** - WhatsOnChain エクスプローラーへのリンク付き
- **アドレスコピー** - ワンクリックでアドレスをクリップボードにコピー
- **新規鍵生成** - ブラウザ上で新しい秘密鍵を安全に生成
- **自動更新** - 30秒ごとに残高と取引履歴を自動更新

## Tech Stack

- **React** + **TypeScript** + **Vite**
- **[@bsv/sdk](https://www.npmjs.com/package/@bsv/sdk)** - 公式 BSV TypeScript SDK
- **[WhatsOnChain API](https://docs.whatsonchain.com/)** - 残高・UTXO・取引履歴・ブロードキャスト

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## How It Works

1. ログイン画面で Mainnet または Testnet を選択
2. WIF形式の秘密鍵を入力してログイン（または「新しい鍵を生成する」で新規作成）
3. ダッシュボードで残高確認・送金・取引履歴の閲覧が可能

## API

残高・UTXO・取引履歴の取得およびトランザクションのブロードキャストには [WhatsOnChain API](https://docs.whatsonchain.com/) を使用しています（認証不要、3リクエスト/秒まで無料）。

## Security

- 秘密鍵はブラウザのメモリ上にのみ保持され、サーバーには送信されません
- すべての署名処理はクライアントサイドで実行されます
- ログアウト時に秘密鍵はメモリから完全に削除されます

## License

MIT
