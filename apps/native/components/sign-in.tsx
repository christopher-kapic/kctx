import { DEFAULT_LOCALE } from "@starter/config/locales";
import { useForm } from "@tanstack/react-form";
import {
  Button,
  FieldError,
  Input,
  Label,
  Spinner,
  Surface,
  TextField,
  useToast,
} from "heroui-native";
import type { TFunction } from "i18next";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, TextInput, View } from "react-native";
import z from "zod";

import { authClient } from "@/lib/auth-client";
import { haptic } from "@/lib/haptics";
import { getAuthErrorMessage, getErrorMessage } from "@/utils/form-error";
import { orpc, queryClient } from "@/utils/orpc";

function makeSignInSchema(t: TFunction<"native">) {
  return z.object({
    email: z
      .string()
      .trim()
      .min(1, t("native:auth.validation.emailRequired"))
      .email(t("native:auth.validation.emailInvalid")),
    // No length rule here on purpose: sign-in validates an existing password,
    // which may predate the current minimum. The server decides.
    password: z.string().min(1, t("native:auth.validation.passwordRequired")),
  });
}

type SignInView =
  | { kind: "form" }
  | { kind: "twoFactor" }
  | { kind: "forgot"; initialEmail: string };

function SignIn() {
  const { t } = useTranslation("native");
  const passwordInputRef = useRef<TextInput>(null);
  const { toast } = useToast();
  const [view, setView] = useState<SignInView>({ kind: "form" });

  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
    },
    validators: {
      onSubmit: makeSignInSchema(t),
    },
    onSubmit: async ({ value, formApi }) => {
      const result = await authClient.signIn.email({
        email: value.email.trim(),
        password: value.password,
      });

      if (result.error) {
        haptic("error");
        toast.show({
          variant: "danger",
          label: getAuthErrorMessage(result.error, t("native:auth.signIn.failed")),
        });
        return;
      }

      if ((result.data as Record<string, unknown> | null)?.twoFactorRedirect) {
        setView({ kind: "twoFactor" });
        return;
      }

      formApi.reset();
      haptic("success");
      toast.show({
        variant: "success",
        label: t("native:auth.signIn.success"),
      });
      queryClient.refetchQueries();
    },
  });

  if (view.kind === "forgot") {
    return (
      <ForgotPasswordCard
        initialEmail={view.initialEmail}
        onBack={() => setView({ kind: "form" })}
      />
    );
  }

  if (view.kind === "twoFactor") {
    return <TwoFactorCard onBack={() => setView({ kind: "form" })} />;
  }

  return (
    <Surface variant="secondary" className="p-4 rounded-lg">
      <Text className="text-foreground font-medium mb-4">{t("native:auth.signIn.heading")}</Text>

      <form.Subscribe
        selector={(state) => ({
          isSubmitting: state.isSubmitting,
          validationError: getErrorMessage(state.errorMap.onSubmit),
        })}
      >
        {({ isSubmitting, validationError }) => {
          const formError = validationError;

          return (
            <>
              <FieldError isInvalid={!!formError} className="mb-3">
                {formError}
              </FieldError>

              <View className="gap-3">
                <form.Field name="email">
                  {(field) => (
                    <TextField>
                      <Label>{t("native:auth.fields.email")}</Label>
                      <Input
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChangeText={field.handleChange}
                        placeholder="email@example.com"
                        keyboardType="email-address"
                        autoCapitalize="none"
                        autoComplete="email"
                        textContentType="emailAddress"
                        returnKeyType="next"
                        blurOnSubmit={false}
                        onSubmitEditing={() => {
                          passwordInputRef.current?.focus();
                        }}
                      />
                    </TextField>
                  )}
                </form.Field>

                <form.Field name="password">
                  {(field) => (
                    <TextField>
                      <Label>{t("native:auth.fields.password")}</Label>
                      <Input
                        ref={passwordInputRef}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChangeText={field.handleChange}
                        placeholder="••••••••"
                        secureTextEntry
                        autoComplete="password"
                        textContentType="password"
                        returnKeyType="go"
                        onSubmitEditing={form.handleSubmit}
                      />
                    </TextField>
                  )}
                </form.Field>

                <Button onPress={form.handleSubmit} isDisabled={isSubmitting} className="mt-1">
                  {isSubmitting ? (
                    <Spinner size="sm" color="default" />
                  ) : (
                    <Button.Label>{t("native:auth.signIn.submit")}</Button.Label>
                  )}
                </Button>

                <Button
                  variant="ghost"
                  onPress={() => {
                    haptic("light");
                    setView({
                      kind: "forgot",
                      initialEmail: form.getFieldValue("email")?.trim() ?? "",
                    });
                  }}
                >
                  <Button.Label>{t("native:auth.forgotPassword.trigger")}</Button.Label>
                </Button>
              </View>
            </>
          );
        }}
      </form.Subscribe>
    </Surface>
  );
}

function TwoFactorCard({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation("native");
  const { toast } = useToast();
  const [otpSent, setOtpSent] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [isSendingOtp, setIsSendingOtp] = useState(false);

  // No try/finally: React Compiler can't optimize components containing try
  // statements yet, and better-auth reports failures as result.error values.
  // `.catch(() => null)` covers the rare thrown (network-level) failure.
  const handleVerify = async () => {
    setIsVerifying(true);
    const result = await (otpSent
      ? authClient.twoFactor.verifyOtp({ code: totpCode })
      : authClient.twoFactor.verifyTotp({ code: totpCode })
    ).catch(() => null);
    setIsVerifying(false);

    if (!result) {
      haptic("error");
      toast.show({
        variant: "danger",
        label: t("native:auth.errors.unexpected"),
      });
      return;
    }

    if (result.error) {
      haptic("error");
      toast.show({
        variant: "danger",
        label: t("native:auth.twoFactor.invalidCode"),
      });
      return;
    }

    haptic("success");
    toast.show({
      variant: "success",
      label: t("native:auth.signIn.success"),
    });
    queryClient.refetchQueries();
    onBack();
  };

  const handleSendEmailOtp = async () => {
    setIsSendingOtp(true);
    const preflight = await orpc.auth.verifyEmailTransport.call().catch(() => ({ ok: false }));
    if (!preflight.ok) {
      setIsSendingOtp(false);
      haptic("error");
      toast.show({
        variant: "danger",
        label: t("native:auth.twoFactor.sendFailed"),
      });
      return;
    }

    const result = await authClient.twoFactor.sendOtp().catch(() => null);
    setIsSendingOtp(false);

    if (!result) {
      haptic("error");
      toast.show({
        variant: "danger",
        label: t("native:auth.errors.unexpected"),
      });
      return;
    }

    if (result.error) {
      haptic("error");
      toast.show({
        variant: "danger",
        label: getAuthErrorMessage(result.error, t("native:auth.twoFactor.sendFailed")),
      });
      return;
    }

    setOtpSent(true);
    setTotpCode("");
    toast.show({
      variant: "success",
      label: t("native:auth.twoFactor.codeSent"),
    });
  };

  return (
    <Surface variant="secondary" className="p-4 rounded-lg">
      <Text className="text-foreground font-medium mb-1">{t("native:auth.twoFactor.title")}</Text>
      <Text className="text-muted text-sm mb-4">
        {otpSent ? t("native:auth.twoFactor.emailPrompt") : t("native:auth.twoFactor.appPrompt")}
      </Text>

      <View className="gap-3">
        <TextField>
          <Label>{t("native:auth.twoFactor.codeLabel")}</Label>
          <Input
            value={totpCode}
            onChangeText={setTotpCode}
            placeholder="123456"
            keyboardType="number-pad"
            inputMode="numeric"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={6}
            returnKeyType="go"
            onSubmitEditing={() => {
              if (totpCode.length === 6) {
                handleVerify();
              }
            }}
          />
        </TextField>

        <Button
          onPress={handleVerify}
          isDisabled={totpCode.length !== 6 || isVerifying}
          className="mt-1"
        >
          {isVerifying ? (
            <Spinner size="sm" color="default" />
          ) : (
            <Button.Label>{t("native:auth.twoFactor.verify")}</Button.Label>
          )}
        </Button>

        <Button onPress={handleSendEmailOtp} isDisabled={isSendingOtp}>
          {isSendingOtp ? (
            <Spinner size="sm" color="default" />
          ) : (
            <Button.Label>
              {otpSent ? t("native:auth.twoFactor.resend") : t("native:auth.twoFactor.emailMe")}
            </Button.Label>
          )}
        </Button>

        <Button onPress={onBack}>
          <Button.Label>{t("native:auth.twoFactor.back")}</Button.Label>
        </Button>
      </View>
    </Surface>
  );
}

// Forgot-password request card. Completion happens on the web via the emailed
// link; native only kicks off the request (no token entry here).
function ForgotPasswordCard({
  initialEmail,
  onBack,
}: {
  initialEmail: string;
  onBack: () => void;
}) {
  const { t } = useTranslation("native");
  const { toast } = useToast();
  const [email, setEmail] = useState(initialEmail);
  const [isSending, setIsSending] = useState(false);

  const handleRequestReset = async () => {
    setIsSending(true);
    const result = await authClient
      .requestPasswordReset({
        email: email.trim(),
        // Resolved against BETTER_AUTH_URL (the web origin); completion lands on
        // the web reset-password page in the default locale.
        redirectTo: `/${DEFAULT_LOCALE}/reset-password`,
      })
      .catch(() => null);
    setIsSending(false);

    if (!result) {
      haptic("error");
      toast.show({
        variant: "danger",
        label: t("native:auth.errors.unexpected"),
      });
      return;
    }

    if (result.error) {
      haptic("error");
      toast.show({
        variant: "danger",
        label: getAuthErrorMessage(result.error, t("native:auth.forgotPassword.failed")),
      });
      return;
    }

    // Always the same success copy regardless of whether the account exists
    // (no account enumeration).
    haptic("success");
    toast.show({
      variant: "success",
      label: t("native:auth.forgotPassword.success"),
    });
    onBack();
  };

  return (
    <Surface variant="secondary" className="p-4 rounded-lg">
      <Text className="text-foreground font-medium mb-1">
        {t("native:auth.forgotPassword.heading")}
      </Text>
      <Text className="text-muted text-sm mb-4">{t("native:auth.forgotPassword.prompt")}</Text>

      <View className="gap-3">
        <TextField>
          <Label>{t("native:auth.fields.email")}</Label>
          <Input
            value={email}
            onChangeText={setEmail}
            placeholder="email@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="go"
            onSubmitEditing={() => {
              if (email.trim()) {
                handleRequestReset();
              }
            }}
          />
        </TextField>

        <Button
          onPress={handleRequestReset}
          isDisabled={!email.trim() || isSending}
          className="mt-1"
        >
          {isSending ? (
            <Spinner size="sm" color="default" />
          ) : (
            <Button.Label>{t("native:auth.forgotPassword.submit")}</Button.Label>
          )}
        </Button>

        <Button variant="ghost" onPress={onBack}>
          <Button.Label>{t("native:auth.forgotPassword.back")}</Button.Label>
        </Button>
      </View>
    </Surface>
  );
}

export { SignIn };
