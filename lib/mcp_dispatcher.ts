import * as api from "./api";
import * as cache from "./cache";
import { checkBudget, getCostSummary, trackCost } from "./costs";
import { fetchTrends, resolveWoeid } from "./trends";
import { fetchArticle } from "./article";
import { actionInfo, actionSuccess, type ActionExecutionResult } from "./action_result";

export type ToolExecutionResult = ActionExecutionResult<unknown>;

export type MCPToolHandler = (args: Record<string, unknown>) => Promise<ToolExecutionResult>;

export type MCPDispatcherDeps = {
  extractTweetId: (input: string) => string;
  callPackageApi: (method: string, path: string, body?: unknown) => Promise<unknown>;
  ensurePackageQueryCitations: (data: unknown, requireCitations: boolean) => void;
};

export function createMcpToolHandlers(deps: MCPDispatcherDeps): Record<string, MCPToolHandler> {
  return {
    async xint_search(args) {
      const query = String(args.query || "");
      const tweets = await api.search(query, {
        pages: Math.ceil((Number(args.limit) || 15) / 20),
        sortOrder: (args.sort === "recent" ? "recency" : "relevancy") as any,
        since: typeof args.since === "string" ? args.since : undefined,
      });

      let results = tweets;
      if (args.noRetweets) {
        results = results.filter((t: any) => !t.text.startsWith("RT @"));
      }
      if (args.noReplies) {
        results = results.filter((t: any) => t.conversation_id === t.id);
      }
      trackCost("search", "/2/tweets/search/recent", tweets.length);
      return actionSuccess("Search completed.", results.slice(0, Number(args.limit) || 15));
    },

    async xint_profile(args) {
      const username = String(args.username || "");
      const count = Number(args.count) || 20;
      const includeReplies = Boolean(args.includeReplies);
      const { user, tweets } = await api.profile(username, { count, includeReplies });
      trackCost("profile", `/2/users/by/username/${username}`, tweets.length + 1);
      return actionSuccess("Profile lookup completed.", { user, tweets: tweets.slice(0, count) });
    },

    async xint_thread(args) {
      const tweetId = deps.extractTweetId(String(args.tweetId || ""));
      const pages = Number(args.pages) || 2;
      const tweets = await api.thread(tweetId, { pages });
      trackCost("thread", "/2/tweets/search/recent", tweets.length);
      return actionSuccess("Thread lookup completed.", { tweets });
    },

    async xint_tweet(args) {
      const tweetId = deps.extractTweetId(String(args.tweetId || ""));
      const tweet = await api.getTweet(tweetId);
      trackCost("tweet", `/2/tweets/${tweetId}`, tweet ? 1 : 0);
      return actionSuccess("Tweet lookup completed.", tweet);
    },

    async xint_article(args) {
      const article = await fetchArticle(String(args.url || ""), { full: args.full !== false });
      return actionSuccess("Article fetch completed.", article);
    },

    async xint_xsearch() {
      return actionInfo("xSearch requires XAI_API_KEY.", { note: "xSearch requires XAI_API_KEY" });
    },

    async xint_collections_list() {
      return actionInfo("Collections requires XAI_API_KEY.", { note: "Collections requires XAI_API_KEY" });
    },

    async xint_collections_search() {
      return actionInfo("Collections requires XAI_API_KEY.", { note: "Collections requires XAI_API_KEY" });
    },

    async xint_analyze() {
      return actionInfo("Analyze requires XAI_API_KEY.", { note: "Analyze requires XAI_API_KEY" });
    },

    async xint_trends(args) {
      const location = typeof args.location === "string" ? args.location : "worldwide";
      const limit = Number(args.limit) || 20;
      const trends = await fetchTrends(resolveWoeid(location));
      return actionSuccess(
        "Trends fetch completed.",
        { ...trends, trends: trends.trends.slice(0, limit) },
        trends.source === "search_fallback",
      );
    },

    async xint_bookmarks() {
      return actionInfo("Bookmarks requires OAuth - use xint bookmarks command.", {
        note: "Bookmarks requires OAuth - use xint bookmarks command",
      });
    },

    async xint_package_create(args) {
      const payload = {
        name: String(args.name || ""),
        topic_query: String(args.topicQuery || args.topic_query || ""),
        sources: Array.isArray(args.sources) ? args.sources : [],
        time_window: (args.timeWindow || args.time_window || {
          from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          to: new Date().toISOString(),
        }) as unknown,
        policy: String(args.policy || "private"),
        analysis_profile: String(args.analysisProfile || args.analysis_profile || "summary"),
      };
      const data = await deps.callPackageApi("POST", "/packages", payload);
      return actionSuccess("Package create request accepted.", data);
    },

    async xint_package_status(args) {
      const packageId = String(args.packageId || args.package_id || "");
      if (!packageId) throw new Error("Missing packageId/package_id");
      const data = await deps.callPackageApi("GET", `/packages/${encodeURIComponent(packageId)}`);
      return actionSuccess("Package status fetched.", data);
    },

    async xint_package_query(args) {
      const requireCitations =
        args.requireCitations !== undefined
          ? Boolean(args.requireCitations)
          : args.require_citations !== undefined
            ? Boolean(args.require_citations)
            : true;
      const payload = {
        query: String(args.query || ""),
        package_ids: Array.isArray(args.packageIds)
          ? args.packageIds
          : Array.isArray(args.package_ids)
            ? args.package_ids
            : [],
        max_claims: Number(args.maxClaims || args.max_claims || 10),
        require_citations: requireCitations,
      };
      if (!payload.query || payload.package_ids.length === 0) {
        throw new Error("Missing query or packageIds/package_ids");
      }
      const data = await deps.callPackageApi("POST", "/query", payload);
      deps.ensurePackageQueryCitations(data, requireCitations);
      return actionSuccess("Package query completed.", data);
    },

    async xint_package_refresh(args) {
      const packageId = String(args.packageId || args.package_id || "");
      if (!packageId) throw new Error("Missing packageId/package_id");
      const payload = { reason: String(args.reason || "manual") };
      const data = await deps.callPackageApi(
        "POST",
        `/packages/${encodeURIComponent(packageId)}/refresh`,
        payload,
      );
      return actionSuccess("Package refresh requested.", data);
    },

    async xint_package_search(args) {
      const query = String(args.query || "");
      if (!query) throw new Error("Missing query");
      const limit = Number(args.limit || 20);
      const data = await deps.callPackageApi(
        "GET",
        `/packages/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`,
      );
      return actionSuccess("Package search completed.", data);
    },

    async xint_package_publish(args) {
      const packageId = String(args.packageId || args.package_id || "");
      const snapshotVersion = Number(args.snapshotVersion || args.snapshot_version || 0);
      if (!packageId || !snapshotVersion) {
        throw new Error("Missing packageId/package_id or snapshotVersion/snapshot_version");
      }
      const data = await deps.callPackageApi(
        "POST",
        `/packages/${encodeURIComponent(packageId)}/publish`,
        { snapshot_version: snapshotVersion },
      );
      return actionSuccess("Package publish requested.", data);
    },

    async xint_cache_clear() {
      const removed = cache.clear();
      return actionSuccess("Cache cleared.", { cleared: removed });
    },

    async xint_costs(args) {
      const rawPeriod = typeof args.period === "string" ? args.period : "today";
      const period = ["today", "week", "month", "all"].includes(rawPeriod) ? rawPeriod : "today";
      const summary = getCostSummary(period as "today" | "week" | "month" | "all");
      const budget = checkBudget();
      return actionSuccess("Cost summary generated.", { period, summary, budget });
    },
  };
}
