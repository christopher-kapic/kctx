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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";
import { orpc } from "@/utils/orpc";
import { getSafeProvider } from "@/utils/config";
import { OpenRouterProviderForm } from "./forms/openrouter-provider-form";
import { OpenCodeZenProviderForm } from "./forms/opencode-zen-provider-form";
import { CustomProviderForm } from "./forms/custom-provider-form";

type ProviderType = "openrouter" | "opencode-zen" | "custom";

export function AddProviderDialog({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [providerType, setProviderType] = useState<ProviderType | null>(null);
  const queryClient = useQueryClient();
  const config = useQuery(orpc.models.getConfig.queryOptions());

  const updateMutation = useMutation(
    orpc.models.updateConfig.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: orpc.models.getConfig.key(),
        });
        toast.success("Provider added successfully");
        setOpen(false);
        setProviderType(null);
      },
      onError: (error: any) => {
        toast.error(error.message || "Failed to add provider");
      },
    }),
  );

  const handleProviderAdded = (providerId: string, providerConfig: any) => {
    if (!config.data) return;
    if (
      !providerConfig ||
      typeof providerConfig !== "object" ||
      Array.isArray(providerConfig)
    ) {
      toast.error("Invalid provider configuration");
      return;
    }

    const safeProvider = getSafeProvider(config.data.provider);
    const updatedConfig = {
      ...config.data,
      provider: { ...safeProvider, [providerId]: providerConfig },
    };
    updateMutation.mutate({ config: updatedConfig });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button className={className} size="sm" />}
      >
        <Plus className="size-4 mr-2" />
        Add Provider
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Provider</DialogTitle>
          <DialogDescription>
            Add a new AI model provider to your configuration
          </DialogDescription>
        </DialogHeader>

        {!providerType ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Provider Type</Label>
              <Select
                value={providerType ?? undefined}
                onValueChange={(value) =>
                  setProviderType((value ?? null) as ProviderType | null)
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a provider type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="opencode-zen">OpenCode Zen</SelectItem>
                  <SelectItem value="openrouter">OpenRouter</SelectItem>
                  <SelectItem value="custom">Custom Provider</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setProviderType(null)}
              className="mb-2"
            >
              &larr; Back to provider selection
            </Button>

            {providerType === "opencode-zen" && (
              <OpenCodeZenProviderForm
                onSave={handleProviderAdded}
                onCancel={() => setProviderType(null)}
              />
            )}

            {providerType === "openrouter" && (
              <OpenRouterProviderForm
                onSave={handleProviderAdded}
                onCancel={() => setProviderType(null)}
              />
            )}

            {providerType === "custom" && (
              <CustomProviderForm
                onSave={handleProviderAdded}
                onCancel={() => setProviderType(null)}
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
