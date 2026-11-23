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
  /** Plain-English description shown on hover, focus and touch press-and-hold. */
  help: string;
}
export interface NavGroup {
  title: string | null;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: null,
    items: [
      {
        to: "/",
        label: "Overview",
        icon: LayoutDashboard,
        end: true,
        help: "Your websites at a glance: health, traffic, and the three most useful things to do next.",
      },
    ],
  },
  {
    title: "Fixes",
    items: [
      {
        to: "/opportunities",
        label: "Fix queue",
        icon: Lightbulb,
        help: "Improvements found from your own data, with evidence, a Fix prompt and your approval step. Nothing is published from here.",
      },
      {
        to: "/keywords/opportunities",
        label: "Keyword fixes",
        icon: Wrench,
        help: "Keywords close to paying off, with the Fix and Run Fix buttons.",
      },
      {
        to: "/keywords/ctr-optimizer",
        label: "Click-rate fixes",
        icon: Search,
        help: "Pages that show in Google but get fewer clicks than they should.",
      },
      {
        to: "/site-audit",
        label: "Site health",
        icon: Stethoscope,
        help: "A technical check of your own site: broken links, missing titles and similar problems.",
      },
      {
        to: "/indexing",
        label: "Google indexing",
        icon: Radar,
        help: "Whether Google has each page indexed, asked from Google directly.",
      },
    ],
  },
  {
    title: "Research",
    items: [
      {
        to: "/keywords",
        label: "Keywords",
        icon: Search,
        help: "What people search for, how you rank, and groups of related searches.",
      },
      {
        to: "/competitors",
        label: "Competitors",
        icon: Swords,
        help: "Which other sites appear for the same searches as you.",
      },
      {
        to: "/open-seo",
        label: "OpenSEO research",
        icon: Database,
        help: "Read saved OpenSEO keywords, rank trackers, AI answers and citation sources from your local server. Never runs paid lookups.",
      },
      {
        to: "/content",
        label: "Content ideas",
        icon: FileText,
        help: "Questions and topics from NEURONwriter to cover on your pages.",
      },
    ],
  },
  {
    title: "AI Visibility",
    items: [
      {
        to: "/ai-visibility",
        label: "AI Visibility",
        icon: Sparkles,
        help: "Whether AI tools mention you, with honest labels for what is measured and what is only a manual check.",
      },
      {
        to: "/ai-readiness",
        label: "AI Readiness",
        icon: ClipboardCheck,
        help: "Whether AI crawlers are allowed to read your site.",
      },
    ],
  },
  {
    title: "Settings & advanced",
    items: [
      {
        to: "/sites",
        label: "Websites",
        icon: Globe,
        help: "Add or edit your websites and the Google and Bing accounts connected to them.",
      },
      {
        to: "/sync-runs",
        label: "Sync history",
        icon: History,
        help: "A log of every data collection: when it ran and whether it worked.",
      },
      {
        to: "/system",
        label: "System & backups",
        icon: Database,
        help: "Health of this installation: collectors, backups and notices.",
      },
      {
        to: "/settings/security",
        label: "Security",
        icon: ShieldCheck,
        help: "Two-step sign-in and your authenticators.",
      },
    ],
  },
];
