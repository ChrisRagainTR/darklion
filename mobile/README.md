# DarkLion mobile client app

Expo + React Native + TypeScript client app. Clients sign in with their portal credentials and get their waiting items, secure messages, documents, and return review and signing.

Branding and the server address come from environment variables at build time. See [../docs/mobile-branding.md](../docs/mobile-branding.md).

```bash
npm ci
EXPO_PUBLIC_API_BASE_URL=http://localhost:8080 npx expo start
npm run typecheck
```
