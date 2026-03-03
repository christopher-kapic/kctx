import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { client } from "@/utils/orpc";

function getModelsForDisplay(models: Record<string, unknown> | undefined): string {
  if (!models) return "";
  return Object.keys(models).join("\n");
}

interface OpenRouterProviderFormProps {
  initialData?: any;
  providerId?: string;
  onSave: (providerId: string, config: any) => void;
  onCancel: () => void;
}

export function OpenRouterProviderForm({
  initialData,
  providerId: initialProviderId,
  onSave,
  onCancel,
}: OpenRouterProviderFormProps) {
  const [modelsText, setModelsText] = useState(
    getModelsForDisplay(initialData?.models) || "anthropic/claude-3.5-sonnet\nanthropic/claude-3-opus",
  );
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  const form = useForm({
    defaultValues: {
      providerId: initialProviderId || "openrouter",
      apiKey: initialData?.options?.apiKey || "",
      baseURL: initialData?.options?.baseURL || "https://openrouter.ai/api/v1",
    },
    onSubmit: async ({ value }) => {
      if (!value.apiKey) {
        toast.error("API key is required");
        return;
      }

      const modelIds = modelsText
        .split("\n")
        .map((m) => m.trim())
        .filter((m) => m.length > 0);

      const models: Record<string, { name: string }> = {};
      for (const modelId of modelIds) {
        const clean = modelId.replace(/^openrouter\//, "");
        models[clean] = { name: clean.split("/").pop() || clean };
      }

      onSave(value.providerId || "openrouter", {
        npm: "@openrouter/ai-sdk-provider",
        name: "OpenRouter",
        options: {
          baseURL: value.baseURL || "https://openrouter.ai/api/v1",
          apiKey: value.apiKey,
        },
        models,
      });
    },
  });

  const fetchModels = async () => {
    const { baseURL } = form.state.values;
    setIsLoadingModels(true);
    try {
      const result = await client.models.fetchOpenrouterModels({
        baseURL: baseURL !== "https://openrouter.ai/api/v1" ? baseURL : undefined,
      });
      if (result.models?.length) {
        const text = result.models.map((m: { id: string }) => m.id).join("\n");
        setModelsText(text);
        toast.success(`Loaded ${result.models.length} models`);
      }
    } catch (error: any) {
      toast.error(error?.message || "Failed to fetch models");
    } finally {
      setIsLoadingModels(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      <form.Field name="providerId">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>Provider ID</Label>
            <Input
              id={field.name}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="openrouter"
              disabled={!!initialProviderId}
            />
          </div>
        )}
      </form.Field>

      <form.Field name="apiKey">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>API Key *</Label>
            <Input
              id={field.name}
              type="password"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="sk-or-v1-..."
            />
            <p className="text-xs text-muted-foreground">
              Get your API key from{" "}
              <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener noreferrer" className="underline">
                OpenRouter dashboard
              </a>
            </p>
          </div>
        )}
      </form.Field>

      <form.Field name="baseURL">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>Base URL</Label>
            <Input
              id={field.name}
              type="url"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="https://openrouter.ai/api/v1"
            />
          </div>
        )}
      </form.Field>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Models (one per line)</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={fetchModels}
            disabled={isLoadingModels}
          >
            {isLoadingModels ? (
              <>
                <Loader2 className="size-3 mr-2 animate-spin" />
                Loading...
              </>
            ) : (
              "Fetch Models"
            )}
          </Button>
        </div>
        <Textarea
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          placeholder={"anthropic/claude-3.5-sonnet\nanthropic/claude-3-opus"}
          rows={6}
        />
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Save Provider</Button>
      </div>
    </form>
  );
}
