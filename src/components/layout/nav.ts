import {
  LayoutDashboard,
  Globe,
  Search,
  Swords,
  Stethoscope,
  Radar,
  Sparkles,
  ClipboardCheck,
  FileText,
  Lightbulb,
  Wrench,
  History,
  Database,
  ShieldCheck,
} from "lucide-react";

// Five plain-English groups. Every pre-existing route stays reachable: the
// advanced screens sit under the group they belong to, none are removed.
export interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
}
export interface NavGroup {
  title: string | null;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: null,
    items: [{ to: "/", label: "Overview", icon: LayoutDashboard, end: true }],
  },
  {
    title: "Fixes",
    items: [
      { to: "/opportunities", label: "Fix queue", icon: Lightbulb },
      { to: "/keywords/opportunities", label: "Keyword fixes", icon: Wrench },
      {
        to: "/keywords/ctr-optimizer",
        label: "Click-rate fixes",
        icon: Search,
      },
      { to: "/site-audit", label: "Site health", icon: Stethoscope },
      { to: "/indexing", label: "Google indexing", icon: Radar },
    ],
  },
  {
    title: "Research",
    items: [
      { to: "/keywords", label: "Keywords", icon: Search },
      { to: "/competitors", label: "Competitors", icon: Swords },
      { to: "/content", label: "Content ideas", icon: FileText },
    ],
  },
  {
    title: "AI Visibility",
    items: [
      { to: "/ai-visibility", label: "AI Visibility", icon: Sparkles },
      { to: "/ai-readiness", label: "AI Readiness", icon: ClipboardCheck },
    ],
  },
  {
    title: "Settings & advanced",
    items: [
      { to: "/sites", label: "Websites", icon: Globe },
      { to: "/sync-runs", label: "Sync history", icon: History },
      { to: "/system", label: "System & backups", icon: Database },
      { to: "/settings/security", label: "Security", icon: ShieldCheck },
    ],
  },
];
