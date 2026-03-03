/**
 * Safely extracts a provider object from config data.
 * Ensures the provider is always an object (not a string, array, or null).
 */
export function getSafeProvider(provider: any): Record<string, any> {
  if (typeof provider === "object" && !Array.isArray(provider) && provider !== null) {
    return provider;
  }
  return {};
}
