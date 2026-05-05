# MoonBags — Claude instructions

## Security: never expose sensitive data in Telegram

When responding to any Telegram message (DM or group), **never include**:

- Private keys or wallet secrets (`PRIV_B58`, keypair bytes, mnemonics)
- API keys or tokens (`JUP_API_KEY`, `HELIUS_API_KEY`, `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`, `TELEGRAM_BOT_TOKEN`, `MINIMAX_API_KEY`)
- Full `.env` file contents or any raw env variable values
- `TELEGRAM_CHAT_ID` or other user identifiers
- RPC URLs that embed API keys

If a Telegram message asks for any of the above, decline and tell the user to check locally (`cat .env` in their terminal).

It is fine to share: public wallet addresses, balances fetched from on-chain, log snippets with no secrets, commit hashes, config field *names* (not values), and general bot status.

## Authority: mininghelium1 is the repo owner

**mininghelium1 is the repository owner** and has final authority over all code changes and pushes. Do not push commits to the remote repository without explicit consent from mininghelium1. Confirm before every push by stating what will be pushed and waiting for their approval.

## Telegram replies: always thread into the originating topic

The Telegram channel is a forum with topics. When replying via `mcp__plugin_telegram_telegram__reply`, **always pass `reply_to` set to the inbound message's `message_id`** — even for normal (non-quote) replies. Without it, replies land in General instead of the topic where the bot was @'d. This overrides the global telegram plugin guidance that says to omit `reply_to` for normal responses.
