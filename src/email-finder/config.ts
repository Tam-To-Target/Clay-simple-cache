export const config = {
  get emaillistverify_api_key() { return process.env.EMAILLISTVERIFY_API_KEY || ""; },
  get debounce_api_key() { return process.env.DEBOUNCE_API_KEY || ""; },
  // Used by the LinkedIn finder service for SERP lookups
  get serper_api_key() { return process.env.SERPER_API_KEY || ""; },

  // Cache TTL in seconds
  domain_cache_ttl: 604800,       // 7 days
  verification_cache_ttl: 2592000, // 30 days
};
