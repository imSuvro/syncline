// The demo's tiny HTTP surface: login (pick a persona — no signup wall) and
// the workspace directory. Everything else flows over the sync socket.

export const SERVER_URL: string =
  (import.meta.env['VITE_SYNC_URL'] as string | undefined) ?? 'http://localhost:8787';

export interface DemoUser {
  userId: string;
  name: string;
  color: string;
}

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
}

export const login = async (userId: string): Promise<{ token: string; user: DemoUser }> => {
  const res = await fetch(`${SERVER_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error('That demo account is not available.');
  return (await res.json()) as { token: string; user: DemoUser };
};

export const fetchDirectory = async (userId: string): Promise<WorkspaceSummary[]> => {
  const res = await fetch(`${SERVER_URL}/directory?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) return [];
  return ((await res.json()) as { workspaces: WorkspaceSummary[] }).workspaces;
};
