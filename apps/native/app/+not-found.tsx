import { Link, Stack } from "expo-router";
import { Button, Surface } from "heroui-native";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Container } from "@/components/container";

export default function NotFoundScreen() {
  const { t } = useTranslation("native");

  return (
    <>
      <Stack.Screen options={{ title: t("native:notFound.title") }} />
      <Container>
        <View className="flex-1 justify-center items-center p-4">
          <Surface variant="secondary" className="items-center p-6 max-w-sm rounded-lg">
            <Text className="text-foreground text-4xl mb-3">404</Text>
            <Text className="text-foreground font-medium text-lg mb-1">
              {t("native:notFound.heading")}
            </Text>
            <Text className="text-muted text-sm text-center mb-4">
              {t("native:notFound.description")}
            </Text>
            <Link href="/" asChild>
              <Button size="sm">{t("native:notFound.goHome")}</Button>
            </Link>
          </Surface>
        </View>
      </Container>
    </>
  );
}
