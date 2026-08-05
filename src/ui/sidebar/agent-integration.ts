export const CLOUDSSH_REPOSITORY = "https://github.com/moeacgx/cloudssh";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
