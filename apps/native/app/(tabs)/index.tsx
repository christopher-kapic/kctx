import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { Card, Chip, useThemeColor } from "heroui-native";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, Text, View } from "react-native";

import { Container } from "@/components/container";
import { authClient } from "@/lib/auth-client";
import { appConfigQueryOptions, orpc } from "@/utils/orpc";

export default function Home() {
  const { t } = useTranslation("native");
  const {
    data: healthData,
    isPending: healthPending,
    isError: healthError,
    refetch: refetchHealth,
  } = useQuery(orpc.health.check.queryOptions());
  const {
    data: appConfig,
    isPending: appConfigPending,
    isError: appConfigError,
    refetch: refetchAppConfig,
  } = useQuery(appConfigQueryOptions());
  const { data: session } = authClient.useSession();
  const {
    data: privateData,
    isPending: privatePending,
    isError: privateError,
    refetch: refetchPrivate,
  } = useQuery({
    ...orpc.privateData.queryOptions(),
    enabled: !!session?.user,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);

  const isConnected = healthData === "OK";
  const mutedColor = useThemeColor("muted");
  const successColor = useThemeColor("success");
  const dangerColor = useThemeColor("danger");

  // TanStack Query's refetch() never rejects (errors land on the query
  // object), so no try/finally is needed here.
  const handleRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([
      refetchHealth(),
      refetchAppConfig(),
      session?.user ? refetchPrivate() : Promise.resolve(),
    ]);
    setIsRefreshing(false);
  };

  return (
    <Container
      className="p-6"
      scrollViewProps={{
        refreshControl: (
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={mutedColor}
            colors={[mutedColor]}
          />
        ),
      }}
    >
      <View className="py-4 mb-6">
        <Text className="text-4xl font-bold text-foreground mb-2">{t("native:home.title")}</Text>
        <Text className="text-muted text-base">{t("native:home.subtitle")}</Text>
      </View>

      <Card variant="secondary" className="p-5">
        <View className="flex-row items-center justify-between mb-4">
          <Card.Title>{t("native:home.apiConnection.title")}</Card.Title>
          <Chip
            variant="secondary"
            color={isConnected ? "success" : healthError ? "danger" : "default"}
            size="sm"
          >
            <Chip.Label>
              {isConnected
                ? t("native:home.status.live")
                : healthError
                  ? t("native:home.status.offline")
                  : t("native:home.status.checking")}
            </Chip.Label>
          </Chip>
        </View>

        <View className="flex-row items-center">
          <View className="mr-3">
            {healthPending ? (
              <Ionicons name="hourglass-outline" size={22} color={mutedColor} />
            ) : isConnected ? (
              <Ionicons name="checkmark-circle" size={22} color={successColor} />
            ) : (
              <Ionicons name="close-circle" size={22} color={dangerColor} />
            )}
          </View>
          <View className="flex-1">
            <Text className="text-foreground font-medium mb-1">
              {t("native:home.apiConnection.label")}
            </Text>
            <Card.Description>
              {healthPending
                ? t("native:home.apiConnection.checking")
                : isConnected
                  ? t("native:home.apiConnection.connected")
                  : t("native:home.apiConnection.error")}
            </Card.Description>
          </View>
        </View>
      </Card>

      <Card variant="secondary" className="mt-5 p-5">
        <Card.Title className="mb-3">{t("native:home.appConfig.title")}</Card.Title>
        <Card.Description>
          {appConfigPending
            ? t("native:home.appConfig.loading")
            : appConfigError || !appConfig
              ? t("native:home.appConfig.error")
              : appConfig.signupEnabled || appConfig.adminBootstrapSignupEnabled
                ? t("native:home.appConfig.signupAvailable")
                : t("native:home.appConfig.signupDisabled")}
        </Card.Description>
      </Card>

      <Card variant="secondary" className="mt-5 p-5">
        <Card.Title className="mb-3">{t("native:home.protected.title")}</Card.Title>
        <Card.Description>
          {session?.user
            ? privatePending
              ? t("native:home.protected.loading")
              : privateError || !privateData
                ? t("native:home.protected.error")
                : privateData.message
            : t("native:home.protected.signedOut")}
        </Card.Description>
      </Card>
    </Container>
  );
}
