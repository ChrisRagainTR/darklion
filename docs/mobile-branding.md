# Branding the mobile app

`mobile/` is an Expo (React Native) client app. Clients sign in with their portal credentials and can see what's waiting on them, message the firm, open documents, and review and sign returns. You publish it under your own name with your own Apple and Google developer accounts.

## Settings

All branding is read from environment variables at build time (`mobile/app.config.js`):

| Variable | Example |
| --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | `https://portal.yourfirm.com` |
| `EXPO_PUBLIC_APP_NAME` | `Smith & Co. Portal` |
| `DARKLION_BUNDLE_ID` | `com.smithcpas.portal` |
| `DARKLION_URL_SCHEME` | `smithcpas` |
| `DARKLION_EXPO_SLUG` | `smithcpas-portal` |
| `DARKLION_APP_ICON` | `./assets/my-icon.png` (1024×1024 PNG) |
| `EXPO_PUBLIC_EAS_PROJECT_ID` | from `eas init` |

## Build and publish

```bash
cd mobile
npm ci
npx eas login
npx eas init            # creates your own EAS project id
npx eas build --platform ios --profile production
npx eas submit --platform ios
```

Android works the same with `--platform android`. Apple review usually asks for a demo client login; create a test client in DarkLion for it.

Set `DARKLION_APP_STORE_URL` on the server so portal emails and pages link to your listing.
