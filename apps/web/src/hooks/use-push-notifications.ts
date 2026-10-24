import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { orpc } from "@/utils/orpc";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function usePushNotifications() {
  const { data: vapidKeyData } = useQuery(orpc.push.vapidPublicKey.queryOptions());

  const isSupported =
    typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;

  const permission =
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "default";

  // The oRPC procedures are the mutation core (mutationOptions). The
  // imperative browser steps — permission prompt, service-worker registration
  // — run in the wrappers below and feed the procedure its input. No repo-wide
  // pattern exists for pre-mutation browser work, so the hook keeps its outer
  // shape and only the mutation core is swapped.
  const subscribeProcedure = useMutation(orpc.push.subscribe.mutationOptions());
  const unsubscribeProcedure = useMutation(orpc.push.unsubscribe.mutationOptions());

  // Browser-phase busy flags: the procedure's isPending only covers the
  // server call, not the permission prompt + service-worker round trip.
  const [isPreparingSubscribe, setIsPreparingSubscribe] = useState(false);
  const [isPreparingUnsubscribe, setIsPreparingUnsubscribe] = useState(false);

  const subscribe = useCallback(async () => {
    const vapidKey = vapidKeyData?.key;
    if (!vapidKey) throw new Error("VAPID key not available");

    setIsPreparingSubscribe(true);
    try {
      const granted = await Notification.requestPermission();
      if (granted !== "granted") throw new Error("Permission denied");

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
      });

      const json = subscription.toJSON();
      await subscribeProcedure.mutateAsync({
        endpoint: json.endpoint!,
        keys: {
          p256dh: json.keys!.p256dh!,
          auth: json.keys!.auth!,
        },
      });
    } finally {
      setIsPreparingSubscribe(false);
    }
  }, [subscribeProcedure, vapidKeyData]);

  const unsubscribe = useCallback(async () => {
    setIsPreparingUnsubscribe(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return;

      await unsubscribeProcedure.mutateAsync({ endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    } finally {
      setIsPreparingUnsubscribe(false);
    }
  }, [unsubscribeProcedure]);

  return useMemo(
    () => ({
      isSupported,
      permission,
      subscribe,
      unsubscribe,
      isSubscribing: isPreparingSubscribe || subscribeProcedure.isPending,
      isUnsubscribing: isPreparingUnsubscribe || unsubscribeProcedure.isPending,
    }),
    [
      isSupported,
      permission,
      subscribe,
      unsubscribe,
      isPreparingSubscribe,
      isPreparingUnsubscribe,
      subscribeProcedure.isPending,
      unsubscribeProcedure.isPending,
    ],
  );
}
