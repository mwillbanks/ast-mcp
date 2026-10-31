/** Codex approval display hints never confer server authorization. */
export function codexApprovalMetadata(
  client: { name?: unknown } | undefined,
  filesystem = false,
  probe = false,
) {
  if (
    typeof client?.name !== "string" ||
    !/(?:^|[-_ ])codex(?:$|[-_ ])/i.test(client.name)
  )
    return undefined;
  return {
    codex_approval_kind: "mcp_tool_call",
    persist: probe ? [] : filesystem ? ["session"] : ["session", "always"],
  };
}
