---
title: Expo and React Native
summary: Expo Router typed routes, expo install compatibility and list virtualization
group: stack
scopes: [project]
defaults: []
---

## Expo and React Native

- Use Expo Router (`app/`) for file-based navigation with typed routes (`experiments.typedRoutes`) enabled.
- Install SDK-coupled dependencies with `npx expo install <package>` so native module versions remain compatible with the active Expo SDK, and prefer development builds (`expo-dev-client`) over prebuild bare native edits unless native customization requires it.
- Respect safe areas (`react-native-safe-area-context`) and keyboard avoidance, and render collections with `FlatList` or `FlashList` rather than nesting virtualized lists inside a `ScrollView` on the same axis.
