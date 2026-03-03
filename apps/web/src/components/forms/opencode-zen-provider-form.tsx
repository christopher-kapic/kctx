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

interface OpenCodeZenProviderFormProps {
  initialData?: any;
  providerId?: string;
  onSave: (providerId: string, config: any) => void;
  onCancel: () => void;
}

export function OpenCodeZenProviderForm({
  initialData,
  providerId: initialProviderId,
  onSave,
  onCancel,
}: OpenCodeZenProviderFormProps) {
  const [modelsText, setModelsText] = useState(
    getModelsForDisplay(initialData?.models) || "gpt-5.2-codex\nclaude-sonnet-4-5",
  );
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  const form = useForm({
    defaultValues: {
      providerId: initialProviderId || "opencode",
      apiKey: initialData?.options?.apiKey || "",
      baseURL: initialData?.options?.baseURL || "https://opencode.ai/zen/v1",
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
        const clean = modelId.replace(/^opencode\//, "");
        models[clean] = { name: clean };
      }

      onSave(value.providerId || "opencode", {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenCode Zen",
        options: {
          baseURL: value.baseURL || "https://opencode.ai/zen/v1",
          apiKey: value.apiKey,
        },
        models,
      });
    },
  });

  const fetchModels = async () => {
    const { apiKey, baseURL } = form.state.values;
    if (!apiKey) {
      toast.error("Please enter an API key first");
      return;
    }
    setIsLoadingModels(true);
    try {
      const result = await client.models.fetchOpencodeZenModels({
        apiKey,
        baseURL: baseURL !== "https://opencode.ai/zen/v1" ? baseURL : undefined,
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
              placeholder="opencode"
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
              placeholder="Your OpenCode Zen API key"
            />
            <p className="text-xs text-muted-foreground">
              Get your API key from{" "}
              <a href="https://opencode.ai/auth" target="_blank" rel="noopener noreferrer" className="underline">
                OpenCode auth page
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
              placeholder="https://opencode.ai/zen/v1"
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
            disabled={isLoadingModels || !form.state.values.apiKey}
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
          placeholder={"gpt-5.2-codex\nclaude-sonnet-4-5"}
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
