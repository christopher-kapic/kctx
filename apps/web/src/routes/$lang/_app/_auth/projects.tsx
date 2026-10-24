import { Button } from "@starter/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@starter/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@starter/ui/components/dropdown-menu";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MoreVertical, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/empty-state";
import { LoadMore } from "@/components/load-more";
import { PageHeader, PageShell } from "@/components/page-shell";
import { CreateProjectDialog } from "@/components/projects/create-project-dialog";
import { DeleteProjectDialog } from "@/components/projects/delete-project-dialog";
import { EditProjectSheet } from "@/components/projects/edit-project-sheet";
import type { Project } from "@/components/projects/project-form";
import { QueryBoundary } from "@/components/query-boundary";
import { SkeletonList } from "@/components/skeleton-list";
import { orpc } from "@/utils/orpc";

/**
 * Projects — the golden-path example route. See patterns/golden-path.md.
 *
 * The whole page is one bounded infinite list plus the three overlay
 * conventions (create → Dialog, edit → Sheet, delete → AlertDialog with
 * type-to-confirm). Nothing here is clever; the shape is the point.
 */
export const Route = createFileRoute("/$lang/_app/_auth/projects")({
  component: ProjectsPage,
});

const PAGE_LIMIT = 20;

function ProjectsPage() {
  const { t, i18n } = useTranslation(["projects", "common"]);
  // The row each overlay is acting on, captured when it opens. Held as the row
  // itself rather than an id so the overlays keep rendering the name they were
  // opened with while the list refetches underneath them.
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);

  // `.infiniteOptions()` + `<LoadMore>` is the default for a list. `input` is a
  // FUNCTION of the current page param; `getNextPageParam` reads the opaque
  // token the procedure minted.
  const listQuery = useInfiniteQuery(
    orpc.projects.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: PAGE_LIMIT, cursor }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );

  // A plain flatten, with no dedupe: this list is keyed on `createdAt`, which
  // never changes, so a row cannot slide between pages the way a chat session
  // ordered by `updatedAt` can. A list ordered by a mutable column needs
  // `flattenSessionPages`-style dedupe instead.
  const projects = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <PageShell width="narrow">
      <PageHeader
        title={t("projects:title")}
        description={t("projects:description")}
        actions={<CreateProjectDialog />}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t("projects:listTitle")}</CardTitle>
          <CardDescription>
            {listQuery.isPending
              ? t("common:loading")
              : t("projects:countLabel", { count: projects.length })}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {/* Pending → skeleton, error → inline "Try again", empty → a CTA,
              otherwise the list. All four states, one component. */}
          <QueryBoundary
            query={listQuery}
            skeleton={<SkeletonList count={4} />}
            errorMessage={t("projects:loadFailed")}
            errorClassName="py-12"
            isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
            empty={
              <EmptyState
                title={t("projects:empty.title")}
                description={t("projects:empty.description")}
                action={<CreateProjectDialog />}
              />
            }
          >
            {() => (
              <>
                <ul className="divide-y">
                  {projects.map((project) => (
                    <li
                      key={project.id}
                      className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{project.name}</p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {t("projects:createdOn", {
                            date: new Date(project.createdAt).toLocaleDateString(i18n.language),
                          })}
                          {project.notes ? ` · ${project.notes}` : ""}
                        </p>
                      </div>
                      <ProjectActions
                        project={project}
                        onEdit={() => setEditing(project)}
                        onDelete={() => setDeleting(project)}
                      />
                    </li>
                  ))}
                </ul>
                <LoadMore
                  hasNextPage={listQuery.hasNextPage}
                  isFetchingNextPage={listQuery.isFetchingNextPage}
                  onLoadMore={() => void listQuery.fetchNextPage()}
                />
              </>
            )}
          </QueryBoundary>
        </CardContent>
      </Card>

      <EditProjectSheet
        project={editing}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />

      <DeleteProjectDialog
        project={deleting}
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    </PageShell>
  );
}

/**
 * Row actions. A non-exported local section component: exporting a component
 * from a route file can pull it back into the eager bundle graph.
 */
function ProjectActions({
  project,
  onEdit,
  onDelete,
}: {
  project: Project;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["projects", "common"]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="min-h-[44px] self-end sm:self-auto"
            aria-label={t("projects:actions.rowMenuAriaLabel", { name: project.name })}
          />
        }
      >
        <MoreVertical aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={onEdit}>
          <Pencil aria-hidden className="size-4" />
          {t("common:actions.edit")}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 aria-hidden className="size-4" />
          {t("common:actions.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
