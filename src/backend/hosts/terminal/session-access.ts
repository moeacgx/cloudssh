export async function filterSessionsByHostAccess<T>(
  sessions: readonly T[],
  hasAccess: (session: T) => Promise<boolean>,
): Promise<T[]> {
  const decisions = await Promise.all(
    sessions.map(async (session) => {
      try {
        return (await hasAccess(session)) ? session : null;
      } catch {
        return null;
      }
    }),
  );
  return decisions.filter((session) => session !== null);
}
