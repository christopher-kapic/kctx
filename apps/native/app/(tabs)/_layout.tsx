import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { useThemeColor } from "heroui-native";
import { useTranslation } from "react-i18next";

import { ThemeToggle } from "@/components/theme-toggle";
import { haptic } from "@/lib/haptics";

export default function TabLayout() {
  const { t } = useTranslation("native");
  const foregroundColor = useThemeColor("foreground");
  const backgroundColor = useThemeColor("background");
  const mutedColor = useThemeColor("muted");

  return (
    <Tabs
      screenListeners={{
        tabPress: () => {
          haptic("selection");
        },
      }}
      screenOptions={{
        headerTintColor: foregroundColor,
        headerStyle: { backgroundColor },
        headerTitleStyle: {
          color: foregroundColor,
          fontWeight: "600",
        },
        headerRight: () => <ThemeToggle />,
        tabBarActiveTintColor: foregroundColor,
        tabBarInactiveTintColor: mutedColor,
        tabBarStyle: {
          backgroundColor,
          borderTopColor: mutedColor,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("native:tabs.home"),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: t("native:tabs.account"),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-circle-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
