import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

type HapticPattern = "light" | "success" | "error" | "selection" | "warning";

/**
 * Native counterpart of the web app's `useHaptics()` vocabulary. Canonical preset
 * list: patterns/animation.md § Haptic presets
 *
 * "light" button taps, "success" save/submit, "error" validation/network failure,
 * "selection" tab/toggle, "warning" before destructive actions.
 * No-op on Expo web, where expo-haptics is unsupported.
 */
export function haptic(pattern: HapticPattern) {
  if (Platform.OS === "web") {
    return;
  }

  switch (pattern) {
    case "light":
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      break;
    case "success":
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      break;
    case "error":
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      break;
    case "warning":
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      break;
    case "selection":
      void Haptics.selectionAsync();
      break;
  }
}
