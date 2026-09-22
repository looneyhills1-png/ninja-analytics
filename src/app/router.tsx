import { type ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  RedirectIfAuthenticated,
  RequireDashboard,
  RequireSession,
} from "@/auth/guards";
import { LoginPage } from "@/auth/LoginPage";
import { ResetPasswordPage } from "@/auth/ResetPasswordPage";
import { MfaSetupPage } from "@/auth/MfaSetupPage";
import { MfaChallengePage } from "@/auth/MfaChallengePage";
import { NotAuthorizedPage } from "@/auth/NotAuthorizedPage";

// Keep route pages in the main application bundle. The dashboard is an
// authenticated admin tool, and avoiding per-route chunk files prevents stale
// browser/app-shell deployments from requesting chunk filenames that no longer
// exist after a Cloudflare Pages deployment.
import { OverviewPage } from "@/features/dashboard/OverviewPage";
import { SitesPage } from "@/features/sites/SitesPage";
import { SiteDetailPage } from "@/features/sites/SiteDetailPage";
import { SyncRunsPage } from "@/features/sync-runs/SyncRunsPage";
import { SecuritySettingsPage } from "@/auth/SecuritySettingsPage";
import { SystemPage } from "@/features/system/SystemPage";
import { KeywordsLayout } from "@/features/keywords/KeywordsLayout";
import { KeywordsOverviewPage } from "@/features/keywords/KeywordsOverviewPage";
import { KeywordsOpportunitiesPage } from "@/features/keywords/KeywordsOpportunitiesPage";
import { CtrOptimizerPage } from "@/features/keywords/CtrOptimizerPage";
import { KeywordsRankingsPage } from "@/features/keywords/KeywordsRankingsPage";
import { KeywordsQueriesPage } from "@/features/keywords/KeywordsQueriesPage";
import { KeywordsPagesPage } from "@/features/keywords/KeywordsPagesPage";
import { KeywordsClustersPage } from "@/features/keywords/KeywordsClustersPage";
import { CompetitorsLayout } from "@/features/competitors/CompetitorsLayout";
import { CompetitorsOverviewPage } from "@/features/competitors/CompetitorsOverviewPage";
import { CompetitorsHistoricalPagesPage } from "@/features/competitors/CompetitorsHistoricalPagesPage";
import { CompetitorsNewLostPagesPage } from "@/features/competitors/CompetitorsNewLostPagesPage";
import { CompetitorsLinksPage } from "@/features/competitors/CompetitorsLinksPage";
import { SiteAuditPage } from "@/features/site-audit/SiteAuditPage";
import { AiVisibilityPage } from "@/features/ai-visibility/AiVisibilityPage";
import {
  DemoLayout,
  DemoOverviewPage,
  DemoSitesPage,
  DemoSiteDetailPage,
  DemoSyncHistoryPage,
  DemoSystemPage,
} from "@/features/demo/DemoPages";

function demoElement(element: ReactNode) {
  return element;
}

/**
 * Route map per brief §10. No registration route exists. Public auth pages
 * redirect already-authenticated users onward; the MFA pages require a session
 * but not yet aal2; the dashboard group requires aal2 + admin.
 */
export const router = createBrowserRouter(
  [
    // Public synthetic demo - it has no auth or Supabase data queries.
    {
      path: "/demo",
      element: demoElement(<DemoLayout />),
      children: [
        { index: true, element: demoElement(<DemoOverviewPage />) },
        { path: "sites", element: demoElement(<DemoSitesPage />) },
        {
          path: "sites/:siteSlug",
          element: demoElement(<DemoSiteDetailPage />),
        },
        {
          path: "sync-history",
          element: demoElement(<DemoSyncHistoryPage />),
        },
        { path: "system", element: demoElement(<DemoSystemPage />) },
      ],
    },

    // Public auth pages -------------------------------------------------------
    {
      element: <RedirectIfAuthenticated />,
      children: [{ path: "/login", element: <LoginPage /> }],
    },
    { path: "/reset-password", element: <ResetPasswordPage /> },
    { path: "/not-authorized", element: <NotAuthorizedPage /> },

    // MFA flow (session required, aal2 not yet) --------------------------------
    {
      element: <RequireSession />,
      children: [
        { path: "/mfa/setup", element: <MfaSetupPage /> },
        { path: "/mfa/verify", element: <MfaChallengePage /> },
      ],
    },

    // Protected dashboard (aal2 + admin) --------------------------------------
    {
      element: <RequireDashboard />,
      children: [
        {
          element: <AppLayout />,
          children: [
            { path: "/", element: <OverviewPage /> },
            { path: "/sites", element: <SitesPage /> },
            { path: "/sites/:siteId", element: <SiteDetailPage /> },
            {
              path: "/keywords",
              element: <KeywordsLayout />,
              children: [
                { index: true, element: <KeywordsOverviewPage /> },
                {
                  path: "opportunities",
                  element: <KeywordsOpportunitiesPage />,
                },
                { path: "ctr-optimizer", element: <CtrOptimizerPage /> },
                { path: "rankings", element: <KeywordsRankingsPage /> },
                { path: "queries", element: <KeywordsQueriesPage /> },
                { path: "pages", element: <KeywordsPagesPage /> },
                { path: "clusters", element: <KeywordsClustersPage /> },
              ],
            },
            {
              path: "/competitors",
              element: <CompetitorsLayout />,
              children: [
                { index: true, element: <CompetitorsOverviewPage /> },
                {
                  path: "historical-pages",
                  element: <CompetitorsHistoricalPagesPage />,
                },
                {
                  path: "new-lost-pages",
                  element: <CompetitorsNewLostPagesPage />,
                },
                { path: "links", element: <CompetitorsLinksPage /> },
              ],
            },
            { path: "/site-audit", element: <SiteAuditPage /> },
            { path: "/ai-visibility", element: <AiVisibilityPage /> },
            { path: "/sync-runs", element: <SyncRunsPage /> },
            { path: "/system", element: <SystemPage /> },
            { path: "/settings/security", element: <SecuritySettingsPage /> },
          ],
        },
      ],
    },

    { path: "*", element: <Navigate to="/" replace /> },
  ],
  {
    // Opt into the v7 splat-path resolution now to de-risk the upgrade.
    // (v7_startTransition is a RouterProvider flag - see App.tsx.)
    future: {
      v7_relativeSplatPath: true,
    },
  },
);
