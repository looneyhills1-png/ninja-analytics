import { Suspense } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { LogOut } from "lucide-react";
import { NAV_GROUPS } from "@/components/layout/nav";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAuth } from "@/auth/AuthProvider";
import { env } from "@/lib/env";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ExportAllDataButton } from "@/components/layout/ExportAllDataButton";
import { PrivacyModeToggle } from "@/components/layout/PrivacyModeToggle";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { APP_COMMIT } from "@/lib/build-info";
import { usePrivacyMode } from "@/lib/privacy";

/**
 * Shell layout for authenticated pages. Auth/MFA gating is added in Phase 3;
 * for now it provides the navigation chrome around routed content.
 */
export function AppLayout() {
  const { user, signOut } = useAuth();
  const privacy = usePrivacyMode();

  return (
    <div className="min-h-screen md:flex">
      <aside className="flex flex-col border-b border-border bg-card md:w-60 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-4 py-4">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <span className="text-sm font-semibold">Site Analytics</span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:gap-0.5 md:pb-4">
          {NAV_GROUPS.map((group) => (
            <div
              key={group.title ?? "top"}
              className="flex gap-1 md:flex-col md:gap-0.5"
            >
              {group.title && (
                <p className="hidden px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground md:block">
                  {group.title}
                </p>
              )}
              {group.items.map(({ to, label, icon: Icon, end, help }) => (
                <Tooltip key={to} content={help} className="md:w-full">
                  <NavLink
                    to={to}
                    end={end ?? false}
                    className={({ isActive }) =>
                      cn(
                        "flex w-full items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )
                    }
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {label}
                  </NavLink>
                </Tooltip>
              ))}
            </div>
          ))}
          <ExportAllDataButton />
          <PrivacyModeToggle />
          <ThemeToggle />
        </nav>
        <div className="mt-auto hidden border-t border-border p-3 md:block">
          <p className="truncate px-1 pb-2 text-xs text-muted-foreground">
            {env.VITE_LOCAL_ACCESS
              ? "Local access (this PC only)"
              : privacy.maskText(user?.email)}
          </p>
          {!env.VITE_LOCAL_ACCESS && (
            <Button
              help="Signs you out of this browser session."
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => void signOut()}
            >
              <LogOut className="h-4 w-4" aria-hidden />
              Sign out
            </Button>
          )}
          <p className="px-1 pt-3 text-[10px] font-medium text-muted-foreground">
            Commit {APP_COMMIT}
          </p>
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-8">
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-20">
              <Spinner className="h-6 w-6 text-muted-foreground" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
