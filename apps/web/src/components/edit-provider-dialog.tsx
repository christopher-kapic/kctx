import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { orpc } from "@/utils/orpc";
import { getSafeProvider } from "@/utils/config";
import { OpenRouterProviderForm } from "./forms/openrouter-provider-form";
import { OpenCodeZenProviderForm } from "./forms/opencode-zen-provider-form";
import { GitHubCopilotProviderForm } from "./forms/github-copilot-provider-form";
import { CustomProviderForm } from "./forms/custom-provider-form";
import { Settings } from "lucide-react";

interface EditProviderDialogProps {
  providerId: string;
  providerConfig: any;
}

export function EditProviderDialog({
  providerId,
  providerConfig,
}: EditProviderDialogProps) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const config = useQuery(orpc.models.getConfig.queryOptions());

  const updateMutation = useMutation(
    orpc.models.updateConfig.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.models.getConfig.key() });
        toast.success("Provider updated successfully");
        setOpen(false);
      },
      onError: (error: any) => {
        toast.error(error.message || "Failed to update provider");
      },
    }),
  );

  const handleProviderUpdated = (updatedProviderId: string, updatedConfig: any) => {
    if (!config.data) return;

    if (!updatedConfig || typeof updatedConfig !== "object" || Array.isArray(updatedConfig)) {
      toast.error("Invalid provider configuration");
      return;
    }

    const safeProvider = getSafeProvider(config.data.provider);
    const cleanedProvider = { ...safeProvider };
    if (updatedProviderId !== providerId) {
      delete cleanedProvider[providerId];
    }

    const updated = {
      ...config.data,
      provider: {
        ...cleanedProvider,
        [updatedProviderId]: updatedConfig,
      },
    };

    updateMutation.mutate({ config: updated });
  };

  const isOpenRouter =
    providerId === "openrouter" || providerConfig.npm === "@openrouter/ai-sdk-provider";
  const isOpenCodeZen =
    providerId === "opencode" ||
    providerId === "opencode-zen" ||
    (providerConfig.npm === "@ai-sdk/openai-compatible" &&
      providerConfig.options?.baseURL?.includes("opencode.ai/zen"));
  const isGitHubCopilot =
    providerId === "github-copilot" || providerConfig.npm === "@ai-sdk/github-copilot";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="ghost" size="icon" className="size-8" />}
      >
        <Settings className="size-4" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Provider</DialogTitle>
          <DialogDescription>
            Update the configuration for {providerId}
          </DialogDescription>
        </DialogHeader>

        {isOpenRouter ? (
          <OpenRouterProviderForm
            initialData={providerConfig}
            providerId={providerId}
            onSave={handleProviderUpdated}
            onCancel={() => setOpen(false)}
          />
        ) : isOpenCodeZen ? (
          <OpenCodeZenProviderForm
            initialData={providerConfig}
            providerId={providerId}
            onSave={handleProviderUpdated}
            onCancel={() => setOpen(false)}
          />
        ) : isGitHubCopilot ? (
          <GitHubCopilotProviderForm
            initialData={providerConfig}
            providerId={providerId}
            onSave={handleProviderUpdated}
            onCancel={() => setOpen(false)}
          />
        ) : (
          <CustomProviderForm
            initialData={providerConfig}
            providerId={providerId}
            onSave={handleProviderUpdated}
            onCancel={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
