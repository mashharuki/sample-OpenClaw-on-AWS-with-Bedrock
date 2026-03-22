/**
 * openclaw AgentCore ユーティリティ関数
 * SessionKey の導出と呼び出しレスポンスのフォーマットを処理する。
 */

/**
 * 指定されたテナントの openclaw SessionKey を導出する。
 * フォーマット: agentcore:{tenantId}
 * この値は POST /v1/chat/completions の `user` フィールドとして渡され、
 * getReplyFromConfig() で SessionKey として使用される。
 *
 * 検証: 要件 1.3, 2.3
 */
export function deriveSessionKey(tenantId: string): string {
  return `agentcore:${tenantId}`;
}

/**
 * 呼び出しレスポンスをフォーマットして、常に `choices` 配列を含むようにする。
 * AgentCore Runtime は OpenAI 互換のレスポンスフォーマットを想定している。
 *
 * - ペイロードに既に `choices` 配列がある場合はそのまま返す。
 * - それ以外の場合はラップする: { choices: [{ message: { content: JSON.stringify(payload) } }], ...payload }
 *
 * 検証: 要件 1.4
 */
export function formatInvocationResponse(payload: unknown): object {
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Array.isArray((payload as Record<string, unknown>)["choices"])
  ) {
    return payload as object;
  }

  const content =
    typeof payload === "string" ? payload : JSON.stringify(payload);

  return {
    ...(payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as object)
      : {}),
    choices: [
      {
        message: {
          content,
        },
      },
    ],
  };
}
