// Asks the database whether this person may make one more costly or outward request (066,
// claim_request): an AI answer, a report email, a phone notification. Yes means it was counted.
// Until migration 066 is applied the function doesn't exist; then nothing is limited, as before.
type RpcClient = {rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{data: unknown; error: {code?: string} | null}>};

export const LIMIT_KINDS = ["tutor", "assistant", "report_email", "notify", "invite_email"] as const;
export type LimitKind = typeof LIMIT_KINDS[number];

export function missingFunction(error: {code?: string} | null) {
  return !!error && (error.code === "PGRST202" || error.code === "42883");
}

export async function claimRequest(db: RpcClient, kind: LimitKind, ref?: string): Promise<boolean> {
  const result = await db.rpc("claim_request", {kind, ref: ref ?? null});
  if (result.error) return missingFunction(result.error);
  return result.data !== false;
}

export const LIMIT_MESSAGES = {
  tutor: "You've reached today's limit for the tutor. Try again tomorrow.",
  assistant: "You've reached today's limit for the assistant. Try again tomorrow.",
} as const;
