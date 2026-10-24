import { cn } from "@starter/ui/lib/utils";
import type { ReactNode } from "react";

const WIDTH_CLASS = {
  narrow: "max-w-4xl",
  default: "max-w-5xl",
  wide: "max-w-7xl",
} as const;

type PageShellProps = {
  width?: keyof typeof WIDTH_CLASS;
  className?: string;
  children: ReactNode;
};

export function PageShell({ width = "default", className, children }: PageShellProps) {
  return (
    <div className={cn("container mx-auto space-y-6 px-4 py-8", WIDTH_CLASS[width], className)}>
      {children}
    </div>
  );
}

type PageHeaderProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <header className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </header>
      {actions}
    </div>
  );
}
