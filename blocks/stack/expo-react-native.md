---
title: Expo and React Native
summary: Expo New Architecture, app.config.ts, EAS Build/Update, native-stack and Zustand
group: stack
scopes: [project]
defaults: []
skills: [eas-workflows, eas-update, expo-dev-client, expo-upgrade, expo-module, react-native-best-practices, react-navigation, react-native-testing, upgrading-react-native, vercel-react-native-skills]
---

## Expo and React Native

- Target Expo's New Architecture and configure the app via `app.config.ts`, using `expo-dev-client` development builds, EAS Build, and EAS Update rather than bare native directory edits unless required.
- Use React Navigation `native-stack` (`@react-navigation/native-stack`, or Expo Router built on `native-stack`) and wrap screens in shared screen/layout wrapper components that handle safe areas (`react-native-safe-area-context`) and keyboard avoidance.
- Install SDK-compatible packages with `expo install <package>` via the project's package manager (such as `yarn expo install <package>`), render lists with `FlatList` or `FlashList`, and use Zustand strictly for client-only UI state (keeping server data in TanStack Query).
