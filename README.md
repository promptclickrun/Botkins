# Botkins

Botkins runs your bots on your computer. Pair the mobile app to chat with them and manage their work from your phone.

| Component | Getting started |
| --- | --- |
| [Desktop](desktop/README.md) · Electron | In `desktop/`, run `npm ci`, then `npm start`. |
| [Mobile](mobile/README.md) · Expo and React Native | In `mobile/`, run `npm ci`. Run `npm start` for Metro, or `npm run ios` to build for an iOS simulator. |
| [Relay](mobile/relay/README.md) · Cloudflare Worker | In `mobile/relay/`, run `npm ci` and `npm test`. |

Each component has its own package manifest and lockfile. Run `npm test` in the component you are changing. For changes to the desktop–phone link, run both app suites and refer to the [link contract](mobile/docs/link-contract.md).

To refresh the desktop copy of the mobile link client, install both apps’ dependencies and run `node scripts/build-link-client.mjs` from `desktop/`. The desktop tests compare the generated client and the appearance catalog with the mobile sources.

## Contributions

Open a pull request to change the default branch. A reviewer must approve the latest changes. The repository owner can merge a pull request without an approval.

## License

Botkins uses the [MIT License](LICENSE). The fonts, provider marks, and third-party code have separate notices. See the notices for the [desktop app](desktop/desktop/THIRD-PARTY-NOTICES.txt) and the [mobile app](mobile/THIRD-PARTY-NOTICES.txt).
