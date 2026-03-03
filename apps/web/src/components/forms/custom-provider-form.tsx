import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface CustomProviderFormProps {
  onSave: (providerId: string, config: any) => void;
  onCancel: () => void;
}

export function CustomProviderForm({
  onSave,
  onCancel,
}: CustomProviderFormProps) {
  const [modelsText, setModelsText] = useState("");
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  const form = useForm({
    defaultValues: {
      providerId: "",
      npm: "",
      name: "",
      baseURL: "",
      apiKey: "",
    },
    onSubmit: async ({ value }) => {
      if (!value.providerId || !value.npm || !value.name) {
        toast.error("Provider ID, NPM package, and display name are required");
        return;
      }

      const models: Record<string, { name?: string }> = {};
      if (modelsText) {
        const lines = modelsText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
        for (const line of lines) {
          if (line.includes(":")) {
            const [modelId, ...nameParts] = line.split(":");
            const name = nameParts.join(":").trim();
            models[modelId.trim()] = name ? { name } : {};
          } else {
            models[line] = {};
          }
        }
      }

      const config: Record<string, unknown> = { npm: value.npm, name: value.name };
      const options: Record<string, string> = {};
      if (value.baseURL) options.baseURL = value.baseURL;
      if (value.apiKey) options.apiKey = value.apiKey;
      if (Object.keys(options).length > 0) config.options = options;
      if (Object.keys(models).length > 0) config.models = models;

      onSave(value.providerId, config);
    },
  });

  const fetchModels = async () => {
    const { baseURL, apiKey } = form.state.values;
    if (!baseURL) {
      toast.error("Please enter a Base URL first");
      return;
    }
    setIsLoadingModels(true);
    try {
      const headers: HeadersInit = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(`${baseURL}/models`, { headers });
      if (!response.ok) throw new Error(`Failed: ${response.statusText}`);
      const data = await response.json();
      if (data.data?.length) {
        const text = data.data
          .map((m: any) => `${m.id}: ${m.id.split("/").pop() || m.id}`)
          .join("\n");
        setModelsText(text);
        toast.success(`Loaded ${data.data.length} models`);
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
            <Label htmlFor={field.name}>Provider ID *</Label>
            <Input
              id={field.name}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="my-provider"
            />
          </div>
        )}
      </form.Field>

      <form.Field name="npm">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>NPM Package *</Label>
            <Input
              id={field.name}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="@ai-sdk/openai-compatible"
            />
          </div>
        )}
      </form.Field>

      <form.Field name="name">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>Display Name *</Label>
            <Input
              id={field.name}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="My AI Provider"
            />
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
              placeholder="https://api.example.com/v1"
            />
          </div>
        )}
      </form.Field>

      <form.Field name="apiKey">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>API Key</Label>
            <Input
              id={field.name}
              type="password"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="sk-..."
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
            disabled={isLoadingModels || !form.state.values.baseURL}
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
          placeholder={"model-id: Display Name\nmodel-id-2: Display Name 2"}
          rows={6}
        />
        <p className="text-xs text-muted-foreground">
          Format: modelId: Display Name (name is optional)
        </p>
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
