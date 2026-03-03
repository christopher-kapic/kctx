import { createFileRoute, Link } from "@tanstack/react-router";
import { PackageChat } from "@/components/package-chat";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute(
  "/_authenticated/packages_/$identifier/chat",
)({
  component: PackageChatPage,
});

function PackageChatPage() {
  const { identifier } = Route.useParams();

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] p-6">
      <div className="mb-4 flex items-center gap-3">
        <Link to="/packages">
          <Button variant="ghost" size="icon-sm">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-semibold">
            Chat with{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-base">
              {identifier}
            </code>
          </h1>
          <p className="text-xs text-muted-foreground">
            Ask questions about how to use this package
          </p>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <PackageChat packageIdentifier={identifier} />
      </div>
    </div>
  );
}
