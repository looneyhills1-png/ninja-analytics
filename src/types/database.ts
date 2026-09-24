// Database types for the Site Analytics schema.
//
// Hand-authored to mirror supabase/migrations/0001_initial_schema.sql. Once a
// Supabase project is linked you can regenerate this file with:
//   supabase gen types typescript --linked > src/types/database.ts
// Keep it in sync with the migrations if you edit it by hand.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type SyncSource = "gsc" | "ga4" | "bing";
export type SearchEngine = "google" | "bing";
export type SyncStatus = "running" | "success" | "partial" | "failed";
export type TriggerType = "scheduled" | "manual" | "backfill";
export type RankDevice = "desktop" | "mobile";
export type RankSnapshotSource = "manual" | "observed_serp";
export type AiVisibilitySource =
  | "chatgpt"
  | "gemini"
  | "copilot"
  | "claude"
  | "siri"
  | "alexa"
  | "yahoo"
  | "duckduckgo"
  | "brave"
  | "ecosia"
  | "dogpile"
  | "perplexity"
  | "other";
export type NinjaIndexStatus =
  | "indexed"
  | "not_indexed"
  | "crawled_not_indexed"
  | "discovered_not_indexed"
  | "canonical_mismatch"
  | "blocked"
  | "unknown";

export interface Database {
  public: {
    Tables: {
      sites: {
        Row: {
          id: string;
          name: string;
          domain: string;
          website_url: string;
          gsc_property: string | null;
          ga4_property_id: string | null;
          bing_site_url: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          domain: string;
          website_url: string;
          gsc_property?: string | null;
          ga4_property_id?: string | null;
          bing_site_url?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["sites"]["Insert"]>;
        Relationships: [];
      };
      analytics_daily: {
        Row: {
          site_id: string;
          metric_date: string;
          active_users: number;
          total_users: number;
          sessions: number;
          screen_page_views: number;
          engaged_sessions: number;
          updated_at: string;
        };
        Insert: {
          site_id: string;
          metric_date: string;
          active_users?: number;
          total_users?: number;
          sessions?: number;
          screen_page_views?: number;
          engaged_sessions?: number;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["analytics_daily"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "analytics_daily_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      search_daily: {
        Row: {
          site_id: string;
          engine: SearchEngine;
          metric_date: string;
          clicks: number;
          impressions: number;
          ctr: number | null;
          average_position: number | null;
          updated_at: string;
        };
        Insert: {
          site_id: string;
          engine: SearchEngine;
          metric_date: string;
          clicks?: number;
          impressions?: number;
          ctr?: number | null;
          average_position?: number | null;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["search_daily"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "search_daily_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      search_query_daily: {
        Row: {
          site_id: string;
          engine: SearchEngine;
          metric_date: string;
          query: string;
          clicks: number;
          impressions: number;
          ctr: number | null;
          average_position: number | null;
          updated_at: string;
        };
        Insert: {
          site_id: string;
          engine: SearchEngine;
          metric_date: string;
          query: string;
          clicks?: number;
          impressions?: number;
          ctr?: number | null;
          average_position?: number | null;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["search_query_daily"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "search_query_daily_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      search_page_daily: {
        Row: {
          site_id: string;
          engine: SearchEngine;
          metric_date: string;
          page: string;
          clicks: number;
          impressions: number;
          ctr: number | null;
          average_position: number | null;
          updated_at: string;
        };
        Insert: {
          site_id: string;
          engine: SearchEngine;
          metric_date: string;
          page: string;
          clicks?: number;
          impressions?: number;
          ctr?: number | null;
          average_position?: number | null;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["search_page_daily"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "search_page_daily_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      sync_runs: {
        Row: {
          id: string;
          site_id: string;
          source: SyncSource;
          trigger_type: TriggerType;
          requested_by: string | null;
          range_start: string | null;
          range_end: string | null;
          started_at: string;
          finished_at: string | null;
          status: SyncStatus;
          rows_fetched: number;
          rows_written: number;
          duration_ms: number | null;
          error_code: string | null;
          error_message: string | null;
          metadata: Json;
        };
        Insert: {
          id?: string;
          site_id: string;
          source: SyncSource;
          trigger_type: TriggerType;
          requested_by?: string | null;
          range_start?: string | null;
          range_end?: string | null;
          started_at?: string;
          finished_at?: string | null;
          status?: SyncStatus;
          rows_fetched?: number;
          rows_written?: number;
          duration_ms?: number | null;
          error_code?: string | null;
          error_message?: string | null;
          metadata?: Json;
        };
        Update: Partial<Database["public"]["Tables"]["sync_runs"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "sync_runs_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_status: {
        Row: {
          site_id: string;
          source: SyncSource;
          enabled: boolean;
          last_attempt_at: string | null;
          last_success_at: string | null;
          last_status: SyncStatus | null;
          last_duration_ms: number | null;
          last_rows_fetched: number;
          last_rows_written: number;
          consecutive_failures: number;
          last_error_code: string | null;
          last_error_message: string | null;
          next_run_at: string | null;
          stale_after_hours: number;
          updated_at: string;
        };
        Insert: {
          site_id: string;
          source: SyncSource;
          enabled?: boolean;
          last_attempt_at?: string | null;
          last_success_at?: string | null;
          last_status?: SyncStatus | null;
          last_duration_ms?: number | null;
          last_rows_fetched?: number;
          last_rows_written?: number;
          consecutive_failures?: number;
          last_error_code?: string | null;
          last_error_message?: string | null;
          next_run_at?: string | null;
          stale_after_hours?: number;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["integration_status"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "integration_status_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      tracked_queries: {
        Row: {
          site_id: string;
          query: string;
          created_at: string;
        };
        Insert: {
          site_id: string;
          query: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["tracked_queries"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "tracked_queries_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      search_query_page_daily: {
        Row: {
          site_id: string;
          engine: SearchEngine;
          metric_date: string;
          query: string;
          page: string;
          clicks: number;
          impressions: number;
          ctr: number | null;
          average_position: number | null;
          updated_at: string;
        };
        Insert: {
          site_id: string;
          engine: SearchEngine;
          metric_date: string;
          query: string;
          page: string;
          clicks?: number;
          impressions?: number;
          ctr?: number | null;
          average_position?: number | null;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["search_query_page_daily"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "search_query_page_daily_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      rank_snapshots: {
        Row: {
          id: string;
          site_id: string;
          query: string;
          engine: SearchEngine;
          device: RankDevice;
          country: string | null;
          location: string | null;
          ranking_url: string | null;
          observed_rank: number | null;
          source: RankSnapshotSource;
          checked_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          site_id: string;
          query: string;
          engine?: SearchEngine;
          device?: RankDevice;
          country?: string | null;
          location?: string | null;
          ranking_url?: string | null;
          observed_rank?: number | null;
          source?: RankSnapshotSource;
          checked_at?: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["rank_snapshots"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "rank_snapshots_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      competitor_domains: {
        Row: {
          id: string;
          site_id: string;
          domain: string;
          label: string | null;
          note: string | null;
          auto_discovered: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          site_id: string;
          domain: string;
          label?: string | null;
          note?: string | null;
          auto_discovered?: boolean;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["competitor_domains"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "competitor_domains_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      observed_serp_results: {
        Row: {
          id: string;
          site_id: string;
          query: string;
          engine: SearchEngine;
          observed_at: string;
          domain: string;
          url: string | null;
          rank_observed: number | null;
          is_own_site: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          site_id: string;
          query: string;
          engine?: SearchEngine;
          observed_at?: string;
          domain: string;
          url?: string | null;
          rank_observed?: number | null;
          is_own_site?: boolean;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["observed_serp_results"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "observed_serp_results_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      uptime_checks: {
        Row: {
          site_id: string;
          checked_at: string;
          ok: boolean;
          status_code: number | null;
          latency_ms: number | null;
          error: string | null;
        };
        Insert: {
          site_id: string;
          checked_at?: string;
          ok: boolean;
          status_code?: number | null;
          latency_ms?: number | null;
          error?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["uptime_checks"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "uptime_checks_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      tracked_rank_keywords: {
        Row: {
          id: string;
          site_id: string;
          query: string;
          engine: SearchEngine;
          device: RankDevice;
          country: string | null;
          location: string | null;
          country_key: string;
          location_key: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          site_id: string;
          query: string;
          engine?: SearchEngine;
          device?: RankDevice;
          country?: string | null;
          location?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["tracked_rank_keywords"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "tracked_rank_keywords_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      common_crawl_runs: {
        Row: {
          id: string;
          domain: string;
          crawl_id: string | null;
          started_at: string;
          finished_at: string | null;
          status: "running" | "success" | "failed";
          pages_found: number;
          pages_new: number;
          pages_disappeared: number;
          error_message: string | null;
        };
        Insert: {
          id?: string;
          domain: string;
          crawl_id?: string | null;
          started_at?: string;
          finished_at?: string | null;
          status?: "running" | "success" | "failed";
          pages_found?: number;
          pages_new?: number;
          pages_disappeared?: number;
          error_message?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["common_crawl_runs"]["Insert"]
        >;
        Relationships: [];
      };
      common_crawl_pages: {
        Row: {
          id: string;
          domain: string;
          url: string;
          first_seen: string;
          last_seen: string;
          cdx_status_code: number | null;
          last_status_code: number | null;
          mime_type: string | null;
          title: string | null;
          is_active: boolean;
          last_checked_at: string;
        };
        Insert: {
          id?: string;
          domain: string;
          url: string;
          first_seen: string;
          last_seen: string;
          cdx_status_code?: number | null;
          last_status_code?: number | null;
          mime_type?: string | null;
          title?: string | null;
          is_active?: boolean;
          last_checked_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["common_crawl_pages"]["Insert"]
        >;
        Relationships: [];
      };
      site_audit_runs: {
        Row: {
          id: string;
          site_id: string;
          started_at: string;
          finished_at: string | null;
          status: "running" | "success" | "failed";
          pages_crawled: number;
          health_score: number | null;
          errors_count: number;
          warnings_count: number;
          notices_count: number;
          error_message: string | null;
        };
        Insert: {
          id?: string;
          site_id: string;
          started_at?: string;
          finished_at?: string | null;
          status?: "running" | "success" | "failed";
          pages_crawled?: number;
          health_score?: number | null;
          errors_count?: number;
          warnings_count?: number;
          notices_count?: number;
          error_message?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["site_audit_runs"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "site_audit_runs_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      site_audit_pages: {
        Row: {
          id: string;
          run_id: string;
          site_id: string;
          url: string;
          status_code: number | null;
          is_redirect: boolean;
          redirect_target: string | null;
          canonical_url: string | null;
          is_self_canonical: boolean | null;
          meta_robots_noindex: boolean;
          title: string | null;
          title_length: number | null;
          meta_description: string | null;
          meta_description_length: number | null;
          h1_count: number | null;
          h2_count: number | null;
          word_count: number | null;
          internal_link_count: number | null;
          external_link_count: number | null;
          images_total: number | null;
          images_missing_alt: number | null;
          has_schema: boolean;
          has_viewport_meta: boolean;
          has_opengraph: boolean;
          has_hreflang: boolean;
          has_pagination: boolean;
          content_hash: string | null;
          crawl_depth: number | null;
          in_sitemap: boolean;
          discovered_from: "crawl" | "sitemap" | null;
          response_time_ms: number | null;
        };
        Insert: {
          id?: string;
          run_id: string;
          site_id: string;
          url: string;
          status_code?: number | null;
          is_redirect?: boolean;
          redirect_target?: string | null;
          canonical_url?: string | null;
          is_self_canonical?: boolean | null;
          meta_robots_noindex?: boolean;
          title?: string | null;
          title_length?: number | null;
          meta_description?: string | null;
          meta_description_length?: number | null;
          h1_count?: number | null;
          h2_count?: number | null;
          word_count?: number | null;
          internal_link_count?: number | null;
          external_link_count?: number | null;
          images_total?: number | null;
          images_missing_alt?: number | null;
          has_schema?: boolean;
          has_viewport_meta?: boolean;
          has_opengraph?: boolean;
          has_hreflang?: boolean;
          has_pagination?: boolean;
          content_hash?: string | null;
          crawl_depth?: number | null;
          in_sitemap?: boolean;
          discovered_from?: "crawl" | "sitemap" | null;
          response_time_ms?: number | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["site_audit_pages"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "site_audit_pages_run_id_fkey";
            columns: ["run_id"];
            referencedRelation: "site_audit_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      site_audit_issues: {
        Row: {
          id: string;
          run_id: string;
          site_id: string;
          url: string | null;
          severity: "error" | "warning" | "notice";
          category: string;
          code: string;
          message: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          run_id: string;
          site_id: string;
          url?: string | null;
          severity: "error" | "warning" | "notice";
          category: string;
          code: string;
          message: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["site_audit_issues"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "site_audit_issues_run_id_fkey";
            columns: ["run_id"];
            referencedRelation: "site_audit_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      search_appearance_daily: {
        Row: {
          site_id: string;
          engine: SearchEngine;
          metric_date: string;
          search_appearance: string;
          clicks: number;
          impressions: number;
          ctr: number | null;
          average_position: number | null;
          updated_at: string;
        };
        Insert: {
          site_id: string;
          engine: SearchEngine;
          metric_date: string;
          search_appearance: string;
          clicks?: number;
          impressions?: number;
          ctr?: number | null;
          average_position?: number | null;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["search_appearance_daily"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "search_appearance_daily_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_visibility_prompts: {
        Row: {
          id: string;
          site_id: string;
          prompt_text: string;
          category: "observed" | "generated";
          source_query: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          site_id: string;
          prompt_text: string;
          category: "observed" | "generated";
          source_query?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["ai_visibility_prompts"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "ai_visibility_prompts_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_visibility_observations: {
        Row: {
          id: string;
          site_id: string;
          prompt_id: string | null;
          prompt_text: string;
          source: AiVisibilitySource;
          observed_at: string;
          is_cited: boolean | null;
          cited_url: string | null;
          competitor_domain: string | null;
          country: string | null;
          device: RankDevice | null;
          notes: string | null;
        };
        Insert: {
          id?: string;
          site_id: string;
          prompt_id?: string | null;
          prompt_text: string;
          source: AiVisibilitySource;
          observed_at?: string;
          is_cited?: boolean | null;
          cited_url?: string | null;
          competitor_domain?: string | null;
          country?: string | null;
          device?: RankDevice | null;
          notes?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["ai_visibility_observations"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "ai_visibility_observations_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_visibility_observations_prompt_id_fkey";
            columns: ["prompt_id"];
            referencedRelation: "ai_visibility_prompts";
            referencedColumns: ["id"];
          },
        ];
      };
      gsc_coverage_snapshots: {
        Row: {
          site_id: string;
          metric_date: string;
          coverage_label: string;
          affected_pages: number;
          sitemap: string | null;
          imported_at: string;
          source: string;
        };
        Insert: {
          site_id: string;
          metric_date: string;
          coverage_label?: string;
          affected_pages: number;
          sitemap?: string | null;
          imported_at?: string;
          source?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["gsc_coverage_snapshots"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "gsc_coverage_snapshots_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      url_inspections: {
        Row: {
          site_id: string;
          url: string;
          last_inspected_at: string;
          inspected_by: string | null;
          verdict: string | null;
          coverage_state: string | null;
          robots_txt_state: string | null;
          indexing_state: string | null;
          page_fetch_state: string | null;
          google_canonical: string | null;
          user_canonical: string | null;
          last_crawl_time: string | null;
          crawled_as: string | null;
          sitemaps: string[];
          ninja_status: NinjaIndexStatus;
          site_lastmod: string | null;
          raw_response: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          site_id: string;
          url: string;
          last_inspected_at?: string;
          inspected_by?: string | null;
          verdict?: string | null;
          coverage_state?: string | null;
          robots_txt_state?: string | null;
          indexing_state?: string | null;
          page_fetch_state?: string | null;
          google_canonical?: string | null;
          user_canonical?: string | null;
          last_crawl_time?: string | null;
          crawled_as?: string | null;
          sitemaps?: string[];
          ninja_status: NinjaIndexStatus;
          site_lastmod?: string | null;
          raw_response?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["url_inspections"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "url_inspections_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
      url_inspection_history: {
        Row: {
          id: string;
          site_id: string;
          url: string;
          inspected_at: string;
          inspected_by: string | null;
          verdict: string | null;
          coverage_state: string | null;
          robots_txt_state: string | null;
          indexing_state: string | null;
          page_fetch_state: string | null;
          google_canonical: string | null;
          user_canonical: string | null;
          last_crawl_time: string | null;
          crawled_as: string | null;
          sitemaps: string[];
          ninja_status: NinjaIndexStatus;
          site_lastmod: string | null;
        };
        Insert: {
          id?: string;
          site_id: string;
          url: string;
          inspected_at?: string;
          inspected_by?: string | null;
          verdict?: string | null;
          coverage_state?: string | null;
          robots_txt_state?: string | null;
          indexing_state?: string | null;
          page_fetch_state?: string | null;
          google_canonical?: string | null;
          user_canonical?: string | null;
          last_crawl_time?: string | null;
          crawled_as?: string | null;
          sitemaps?: string[];
          ninja_status: NinjaIndexStatus;
          site_lastmod?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["url_inspection_history"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "url_inspection_history_site_id_fkey";
            columns: ["site_id"];
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      is_portfolio_admin: {
        Args: Record<never, never>;
        Returns: boolean;
      };
      get_db_usage: {
        Args: Record<never, never>;
        Returns: Json;
      };
      run_cleanup: {
        Args: { p_dry_run?: boolean };
        Returns: Json;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
}

// Convenience helpers ---------------------------------------------------------
type PublicSchema = Database["public"];

export type Tables<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Update"];

export type Site = Tables<"sites">;
export type AnalyticsDaily = Tables<"analytics_daily">;
export type SearchDaily = Tables<"search_daily">;
export type SearchQueryDaily = Tables<"search_query_daily">;
export type SearchPageDaily = Tables<"search_page_daily">;
export type SearchQueryPageDaily = Tables<"search_query_page_daily">;
export type RankSnapshot = Tables<"rank_snapshots">;
export type CompetitorDomain = Tables<"competitor_domains">;
export type ObservedSerpResult = Tables<"observed_serp_results">;
export type SyncRun = Tables<"sync_runs">;
export type IntegrationStatus = Tables<"integration_status">;
export type TrackedQuery = Tables<"tracked_queries">;
export type UptimeCheck = Tables<"uptime_checks">;
export type TrackedRankKeyword = Tables<"tracked_rank_keywords">;
export type CommonCrawlRun = Tables<"common_crawl_runs">;
export type CommonCrawlPage = Tables<"common_crawl_pages">;
export type SiteAuditRun = Tables<"site_audit_runs">;
export type SiteAuditPage = Tables<"site_audit_pages">;
export type SiteAuditIssue = Tables<"site_audit_issues">;
export type SearchAppearanceDaily = Tables<"search_appearance_daily">;
export type AiVisibilityPrompt = Tables<"ai_visibility_prompts">;
export type AiVisibilityObservation = Tables<"ai_visibility_observations">;
export type GscCoverageSnapshot = Tables<"gsc_coverage_snapshots">;\nexport type UrlInspection = Tables<"url_inspections">;
export type UrlInspectionHistory = Tables<"url_inspection_history">;
