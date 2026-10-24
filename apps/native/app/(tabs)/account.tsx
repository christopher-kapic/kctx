import { useQuery } from "@tanstack/react-query";
import { Card, Skeleton, Surface } from "heroui-native";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { Container } from "@/components/container";
import { SignIn } from "@/components/sign-in";
import { SignUp } from "@/components/sign-up";
import { authClient } from "@/lib/auth-client";
import { haptic } from "@/lib/haptics";
import { appConfigQueryOptions, queryClient } from "@/utils/orpc";

async function handleSignOut() {
  haptic("light");
  await authClient.signOut();
  queryClient.invalidateQueries();
}

export default function Account() {
  const { t } = useTranslation("native");
  const { data: session, isPending: isSessionPending } = authClient.useSession();
  const { data: appConfig, isPending: appConfigPending } = useQuery(appConfigQueryOptions());
  const showSignup =
    appConfig?.signupEnabled === true || appConfig?.adminBootstrapSignupEnabled === true;
  const forceSso = appConfig?.ssoEnabled === true && appConfig.forceSso === true;

  return (
    <Container className="p-6">
      <View className="py-4 mb-6">
        <Text className="text-4xl font-bold text-foreground mb-2">{t("native:account.title")}</Text>
        <Text className="text-muted text-base">{t("native:account.subtitle")}</Text>
      </View>

      {isSessionPending ? (
        <Card variant="secondary" className="p-5">
          <Skeleton className="h-5 w-48 rounded-md mb-2" />
          <Skeleton className="h-4 w-64 rounded-md mb-4" />
          <Skeleton className="h-11 w-28 rounded-lg" />
        </Card>
      ) : session?.user ? (
        <Card variant="secondary" className="p-5">
          <Text className="text-foreground text-base mb-2">
            {t("native:account.signedInAs")}{" "}
            <Text className="font-medium">{session.user.name}</Text>
          </Text>
          <Text className="text-muted text-sm mb-4">{session.user.email}</Text>
          <Pressable
            className="bg-danger py-3 px-4 rounded-lg self-start active:opacity-70"
            onPress={handleSignOut}
          >
            <Text className="text-foreground font-medium">{t("native:account.signOut")}</Text>
          </Pressable>
        </Card>
      ) : forceSso ? (
        <Surface variant="secondary" className="p-4 rounded-lg">
          <Text className="text-foreground font-medium mb-1">{t("native:account.sso.title")}</Text>
          <Text className="text-muted text-sm">{t("native:account.sso.description")}</Text>
        </Surface>
      ) : (
        <View className="gap-5">
          <SignIn />
          {appConfigPending ? (
            <Surface variant="secondary" className="p-4 rounded-lg">
              <Skeleton className="h-5 w-40 rounded-md mb-2" />
              <Skeleton className="h-4 w-full rounded-md" />
            </Surface>
          ) : showSignup ? (
            <SignUp />
          ) : (
            <Surface variant="secondary" className="p-4 rounded-lg">
              <Text className="text-foreground font-medium mb-1">
                {t("native:account.signupDisabled.title")}
              </Text>
              <Text className="text-muted text-sm">
                {t("native:account.signupDisabled.description")}
              </Text>
            </Surface>
          )}
        </View>
      )}
    </Container>
  );
}
