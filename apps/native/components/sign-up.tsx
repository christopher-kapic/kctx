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
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Text, TextInput, View } from "react-native";
import z from "zod";

import { authClient } from "@/lib/auth-client";
import { haptic } from "@/lib/haptics";
import { getAuthErrorMessage, getErrorMessage } from "@/utils/form-error";
import { queryClient } from "@/utils/orpc";

function makeSignUpSchema(t: TFunction<"native">) {
  return z.object({
    name: z
      .string()
      .trim()
      .min(1, t("native:auth.validation.nameRequired"))
      .min(2, t("native:auth.validation.nameMin")),
    email: z
      .string()
      .trim()
      .min(1, t("native:auth.validation.emailRequired"))
      .email(t("native:auth.validation.emailInvalid")),
    password: z
      .string()
      .min(1, t("native:auth.validation.passwordRequired"))
      .min(12, t("native:auth.validation.passwordMin")),
  });
}

export function SignUp() {
  const { t } = useTranslation("native");
  const emailInputRef = useRef<TextInput>(null);
  const passwordInputRef = useRef<TextInput>(null);
  const { toast } = useToast();

  const form = useForm({
    defaultValues: {
      name: "",
      email: "",
      password: "",
    },
    validators: {
      onSubmit: makeSignUpSchema(t),
    },
    onSubmit: async ({ value, formApi }) => {
      const result = await authClient.signUp.email({
        name: value.name.trim(),
        email: value.email.trim(),
        password: value.password,
      });

      if (result.error) {
        haptic("error");
        toast.show({
          variant: "danger",
          label: getAuthErrorMessage(result.error, t("native:auth.signUp.failed")),
        });
        return;
      }

      formApi.reset();
      haptic("success");
      toast.show({
        variant: "success",
        label: t("native:auth.signUp.success"),
      });
      queryClient.refetchQueries();
    },
  });

  return (
    <Surface variant="secondary" className="p-4 rounded-lg">
      <Text className="text-foreground font-medium mb-4">{t("native:auth.signUp.heading")}</Text>

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
                <form.Field name="name">
                  {(field) => (
                    <TextField>
                      <Label>{t("native:auth.fields.name")}</Label>
                      <Input
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChangeText={field.handleChange}
                        placeholder="John Doe"
                        autoComplete="name"
                        textContentType="name"
                        returnKeyType="next"
                        blurOnSubmit={false}
                        onSubmitEditing={() => {
                          emailInputRef.current?.focus();
                        }}
                      />
                    </TextField>
                  )}
                </form.Field>

                <form.Field name="email">
                  {(field) => (
                    <TextField>
                      <Label>{t("native:auth.fields.email")}</Label>
                      <Input
                        ref={emailInputRef}
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
                        autoComplete="new-password"
                        textContentType="newPassword"
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
                    <Button.Label>{t("native:auth.signUp.submit")}</Button.Label>
                  )}
                </Button>
              </View>
            </>
          );
        }}
      </form.Subscribe>
    </Surface>
  );
}
