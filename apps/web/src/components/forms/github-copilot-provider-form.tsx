import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Info, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { client } from "@/utils/orpc";

function getModelsForDisplay(models: Record<string, unknown> | undefined): string {
  if (!models) return "";
  return Object.keys(models).join("\n");
}

type AuthStep = "idle" | "code" | "completing" | "done";

interface GitHubCopilotProviderFormProps {
  initialData?: any;
  providerId?: string;
  onSave: (providerId: string, config: any) => void;
  onCancel: () => void;
}

export function GitHubCopilotProviderForm({
  initialData,
  providerId: initialProviderId,
  onSave,
  onCancel,
}: GitHubCopilotProviderFormProps) {
  const [authStep, setAuthStep] = useState<AuthStep>("idle");
  const [authUrl, setAuthUrl] = useState("");
  const [authInstructions, setAuthInstructions] = useState("");
  const [isStartingAuth, setIsStartingAuth] = useState(false);
  const [isCompletingAuth, setIsCompletingAuth] = useState(false);
  const [modelsText, setModelsText] = useState(getModelsForDisplay(initialData?.models));
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  const form = useForm({
    defaultValues: {
      providerId: initialProviderId || "github-copilot",
      enterpriseUrl: initialData?.options?.enterpriseUrl || "",
      models: getModelsForDisplay(initialData?.models),
    },
    onSubmit: async ({ value }) => {
      const config: any = {
        npm: "@ai-sdk/github-copilot",
        name: "GitHub Copilot",
      };

      if (value.enterpriseUrl) {
        config.options = { enterpriseUrl: value.enterpriseUrl };
      }

      const modelIds = modelsText
        .split("\n")
        .map((m) => m.trim())
        .filter((m) => m.length > 0);
      const models: Record<string, { name: string }> = {};
      for (const id of modelIds) {
        models[id] = { name: id };
      }
      if (Object.keys(models).length > 0) {
        config.models = models;
      }

      onSave(value.providerId, config);
    },
  });

  const handleStartAuth = async () => {
    setIsStartingAuth(true);
    try {
      const enterpriseUrl = form.state.values.enterpriseUrl?.trim() || undefined;
      const result = await client.models.startGithubCopilotAuth({
        enterpriseUrl: enterpriseUrl || "",
      });
      setAuthUrl(result.url);
      setAuthInstructions(result.instructions);
      setAuthStep("code");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to start GitHub Copilot auth");
    } finally {
      setIsStartingAuth(false);
    }
  };

  const handleCompleteAuth = async () => {
    setIsCompletingAuth(true);
    try {
      const result = await client.models.completeGithubCopilotAuth();
      if (result.success) {
        setAuthStep("done");
        toast.success("GitHub Copilot connected");
      } else {
        toast.error("Authentication did not complete. Enter the code on GitHub and try again.");
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to complete GitHub Copilot auth");
    } finally {
      setIsCompletingAuth(false);
    }
  };

  const fetchModels = async () => {
    setIsLoadingModels(true);
    try {
      const enterpriseUrl = form.state.values.enterpriseUrl?.trim() || undefined;
      const result = await client.models.fetchGithubCopilotModels({
        enterpriseUrl: enterpriseUrl ?? "",
      });
      if (result.models && result.models.length > 0) {
        const text = result.models.map((m: { id: string }) => m.id).join("\n");
        setModelsText(text);
        form.setFieldValue("models", text);
        toast.success(`Loaded ${result.models.length} models`);
      } else {
        toast.error("No models returned");
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to fetch models");
    } finally {
      setIsLoadingModels(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      <div className="flex items-start gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
        <Info className="size-4 mt-0.5 shrink-0" />
        <p>
          You can authenticate in-browser using the buttons below, or use the{" "}
          <code>/connect</code> command in OpenCode. For GitHub Copilot Enterprise,
          provide your enterprise URL below.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border p-3">
        <p className="text-sm font-medium">GitHub Copilot authentication</p>
        {authStep === "idle" && (
          <Button
            type="button"
            variant="outline"
            onClick={handleStartAuth}
            disabled={isStartingAuth}
          >
            {isStartingAuth ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />
                Getting code...
              </>
            ) : (
              "Authenticate with GitHub"
            )}
          </Button>
        )}
        {authStep === "code" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{authInstructions}</p>
            {authUrl && (
              <a
                href={authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm font-medium text-primary underline"
              >
                Open GitHub to enter code
              </a>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={handleCompleteAuth}
              disabled={isCompletingAuth}
            >
              {isCompletingAuth ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Waiting for authorization...
                </>
              ) : (
                "I've entered the code — complete"
              )}
            </Button>
          </div>
        )}
        {authStep === "done" && (
          <p className="text-sm text-green-600 dark:text-green-400">
            GitHub Copilot connected
          </p>
        )}
      </div>

      <form.Field name="providerId">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>Provider ID *</Label>
            <Input
              id={field.name}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="github-copilot"
              disabled={!!initialProviderId}
            />
          </div>
        )}
      </form.Field>

      <form.Field name="enterpriseUrl">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>Enterprise URL (optional)</Label>
            <Input
              id={field.name}
              type="url"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="https://github.example.com"
            />
            <p className="text-xs text-muted-foreground">
              Only required for GitHub Copilot Enterprise. Leave empty for regular
              GitHub Copilot.
            </p>
          </div>
        )}
      </form.Field>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="github-copilot-models">Models (one per line)</Label>
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
          id="github-copilot-models"
          value={modelsText}
          onChange={(e) => {
            setModelsText(e.target.value);
            form.setFieldValue("models", e.target.value);
          }}
          placeholder={"gpt-5.2-codex\nclaude-sonnet-4-5"}
          rows={4}
        />
        <p className="text-xs text-muted-foreground">
          Click "Fetch Models" to load available Copilot models, or enter model IDs
          one per line.
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
