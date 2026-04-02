export const config = {
  emaillistverify_api_key: process.env.EMAILLISTVERIFY_API_KEY || "",
  debounce_api_key: process.env.DEBOUNCE_API_KEY || "",

  max_permutations_to_try: 15,

  // Cache TTL in seconds
  domain_cache_ttl: 604800,       // 7 days
  verification_cache_ttl: 2592000, // 30 days
};
