import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { orpc } from "@/utils/orpc";
import { getSafeProvider } from "@/utils/config";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Brain } from "lucide-react";
import { toast } from "sonner";
import { AddProviderDialog } from "@/components/add-provider-dialog";
import { EditProviderDialog } from "@/components/edit-provider-dialog";

export const Route = createFileRoute("/_authenticated/models")({
  component: ModelsComponent,
});

function ModelsComponent() {
  const queryClient = useQueryClient();
  const config = useQuery(orpc.models.getConfig.queryOptions());

  const updateMutation = useMutation(
    orpc.models.updateConfig.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: orpc.models.getConfig.key(),
        });
        toast.success("Configuration updated");
      },
      onError: (error: any) => {
        toast.error(error.message || "Failed to update configuration");
      },
    }),
  );

  const handleDeleteProvider = (providerId: string) => {
    if (!config.data) return;
    const safeProvider = getSafeProvider(config.data.provider);
    const updatedConfig = {
      ...config.data,
      provider: { ...safeProvider },
    };
    delete updatedConfig.provider?.[providerId];

    if (config.data.model?.startsWith(`${providerId}/`)) {
      updatedConfig.model = undefined;
    }
    updateMutation.mutate({ config: updatedConfig });
  };

  const handleSetModel = (modelId: string) => {
    if (!config.data) return;
    updateMutation.mutate({
      config: { ...config.data, model: modelId },
    });
  };

  const providers = config.data?.provider
    ? Object.entries(config.data.provider)
    : [];
  const currentModel = config.data?.model;

  return (
    <div className="container mx-auto max-w-6xl px-4 py-6 sm:py-8">
      <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
            <Brain className="size-6 sm:size-7" />
            Models
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground mt-1">
            Configure AI model providers and select your default model
          </p>
        </div>
        <AddProviderDialog className="w-full sm:w-auto" />
      </div>

      {config.isLoading ? (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-48 mt-2" />
            </CardHeader>
          </Card>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardHeader>
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-4 w-24 mt-2" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-4 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Current Model */}
          <Card>
            <CardHeader>
              <CardTitle>Current Model</CardTitle>
              <CardDescription>
                The model used for dependency queries
              </CardDescription>
            </CardHeader>
            <CardContent>
              {currentModel ? (
                <div>
                  <p className="font-medium">{currentModel}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {currentModel.split("/")[0]} provider
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground">
                  No model selected. Add a provider and select a model below.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Providers */}
          <div>
            <h2 className="text-xl font-semibold mb-4">Providers</h2>
            {providers.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {providers.map(([providerId, providerConfig]) => {
                  const providerName = providerConfig.name || providerId;
                  const models = providerConfig.models
                    ? Object.keys(providerConfig.models)
                    : [];

                  return (
                    <Card key={providerId}>
                      <CardHeader>
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <CardTitle className="text-base sm:text-lg">
                              {providerName}
                            </CardTitle>
                            <CardDescription className="text-xs sm:text-sm mt-1">
                              {providerId}
                            </CardDescription>
                          </div>
                          <div className="flex gap-1">
                            <EditProviderDialog
                              providerId={providerId}
                              providerConfig={providerConfig}
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-destructive hover:text-destructive"
                              onClick={() => {
                                if (
                                  confirm(`Delete provider ${providerName}?`)
                                ) {
                                  handleDeleteProvider(providerId);
                                }
                              }}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          {providerConfig.npm && (
                            <div className="text-xs sm:text-sm text-muted-foreground">
                              <span className="font-medium">Package:</span>{" "}
                              {providerConfig.npm}
                            </div>
                          )}
                          {models.length > 0 && (
                            <div>
                              <p className="text-xs sm:text-sm font-medium mb-2">
                                Available Models:
                              </p>
                              <div className="space-y-1">
                                {models.map((modelId) => {
                                  const cleanModelId = modelId.startsWith(
                                    `${providerId}/`,
                                  )
                                    ? modelId.slice(providerId.length + 1)
                                    : modelId;
                                  const fullModelId = `${providerId}/${cleanModelId}`;
                                  const isSelected =
                                    currentModel === fullModelId;
                                  return (
                                    <Button
                                      key={modelId}
                                      variant={
                                        isSelected ? "default" : "outline"
                                      }
                                      size="sm"
                                      className="w-full justify-start text-xs"
                                      onClick={() =>
                                        handleSetModel(fullModelId)
                                      }
                                    >
                                      {cleanModelId}
                                      {isSelected && " \u2713"}
                                    </Button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <p className="text-muted-foreground text-center mb-4">
                    No providers configured yet. Add your first provider to get
                    started.
                  </p>
                  <AddProviderDialog />
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
