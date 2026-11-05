// NobleCloak tool_invocation policies, written by @noblecloak/policy-formats.
// Format: Cedar, NobleCloak dialect (schemas/noblecloak.cedarschema).
// A call no policy matches is denied by the target engine.
// Lossy: policy "pol_deploy_by_env" /config/expires_after: kept in @noblecloak_expires_after only; a Cedar engine does not enforce it
// Lossy: policy "pol_deploy_by_env" /config/mode: escalate is exported as a forbid (fail closed): a Cedar engine has no approval outcome, so it denies the call; @noblecloak_mode keeps escalate for an import
// Lossy: policy "pol_deploy_by_env" /config/rules: kept in @noblecloak_rules only; a Cedar engine applies only the statement's outcome (escalate, the tightest the policy can reach), not the per-call rules, and NobleCloak asks where a fact of the call has no value
// Lossy: policy "pol_mail_exclude" /config/approvers: kept in @noblecloak_approvers only; a Cedar engine does not enforce it
// Lossy: policy "pol_mail_exclude" /config/exclude: kept in @noblecloak_exclude only; a Cedar engine does not enforce it
// Lossy: policy "pol_mail_exclude" /config/mode: ask is exported as a forbid (fail closed): a Cedar engine has no approval outcome, so it denies the call; @noblecloak_mode keeps ask for an import
// Lossy: policy "pol_never_wire" /config/rules: kept in @noblecloak_rules only; a Cedar engine applies only the statement's outcome (deny, the tightest the policy can reach), not the per-call rules, and NobleCloak asks where a fact of the call has no value
// Lossy: policy "pol_open_read" /config/rules: kept in @noblecloak_rules only; a Cedar engine applies only the statement's outcome (always_allow, the tightest the policy can reach), not the per-call rules
// Lossy: policy "pol_payments_by_amount" /config/approvers: kept in @noblecloak_approvers only; a Cedar engine applies only the statement's outcome (deny, the tightest the policy can reach), not the per-call rules, and NobleCloak asks where a fact of the call has no value
// Lossy: policy "pol_payments_by_amount" /config/exclude: kept in @noblecloak_exclude only; a Cedar engine applies only the statement's outcome (deny, the tightest the policy can reach), not the per-call rules, and NobleCloak asks where a fact of the call has no value
// Lossy: policy "pol_payments_by_amount" /config/rules: kept in @noblecloak_rules only; a Cedar engine applies only the statement's outcome (deny, the tightest the policy can reach), not the per-call rules, and NobleCloak asks where a fact of the call has no value

@noblecloak_policy("pol_deploy_by_env")
@noblecloak_kind("tool_invocation")
@noblecloak_mode("escalate")
@noblecloak_name("Production deploys escalate")
@noblecloak_expires_after("PT30M")
@noblecloak_rules("[{\"then\":\"always_allow\",\"when\":[{\"fact\":\"env\",\"op\":\"eq\",\"value\":\"staging\"}]},{\"then\":\"ask\",\"when\":[{\"fact\":\"env\",\"op\":\"not_in\",\"value\":[\"staging\",\"dev\"]}]}]")
@noblecloak_encoding("rules_tightest")
@id("noblecloak.escalate:pol_deploy_by_env")
forbid (
  principal == NobleCloak::Agent::"agt_release_bot",
  action == NobleCloak::Action::"tool_invocation",
  resource == NobleCloak::Tool::"external:deploy"
);

@noblecloak_policy("pol_mail_exclude")
@noblecloak_kind("tool_invocation")
@noblecloak_mode("ask")
@noblecloak_name("Mail needs a second person")
@noblecloak_approvers("[{\"role\":\"manager\"}]")
@noblecloak_exclude("[\"requester\"]")
@noblecloak_encoding("fail_closed")
@id("noblecloak.ask:pol_mail_exclude")
forbid (
  principal == NobleCloak::Agent::"agt_support",
  action == NobleCloak::Action::"tool_invocation",
  resource == NobleCloak::Tool::"mcp:gmail:main:send_email"
);

@noblecloak_policy("pol_never_wire")
@noblecloak_kind("tool_invocation")
@noblecloak_mode("ask")
@noblecloak_name("Wires over the limit are denied")
@noblecloak_rules("[{\"then\":\"deny\",\"when\":[{\"fact\":\"lines\",\"op\":\"lt\",\"value\":0}]}]")
@noblecloak_encoding("rules_tightest")
@id("noblecloak.deny:pol_never_wire")
forbid (
  principal == NobleCloak::Agent::"agt_support",
  action == NobleCloak::Action::"tool_invocation",
  resource
);

@noblecloak_policy("pol_open_read")
@noblecloak_kind("tool_invocation")
@noblecloak_mode("always_allow")
@noblecloak_name("Reads with a declared scope stay open")
@noblecloak_rules("[{\"then\":\"always_allow\",\"when\":[{\"fact\":\"scope\",\"op\":\"exists\"}]}]")
@noblecloak_encoding("rules_tightest")
@id("noblecloak.always_allow:pol_open_read")
permit (
  principal,
  action == NobleCloak::Action::"tool_invocation",
  resource
);

@noblecloak_policy("pol_payments_by_amount")
@noblecloak_kind("tool_invocation")
@noblecloak_mode("always_allow")
@noblecloak_name("Large payments need finance")
@noblecloak_approvers("[{\"role\":\"finance\"}]")
@noblecloak_exclude("[\"requester\"]")
@noblecloak_rules("[{\"approvers\":[{\"role\":\"finance\"},{\"user\":\"usr_cfo\",\"when\":[{\"fact\":\"amount\",\"op\":\"gte\",\"value\":5000}]}],\"then\":\"ask\",\"when\":[{\"fact\":\"amount\",\"op\":\"gt\",\"value\":500},{\"fact\":\"currency\",\"op\":\"in\",\"value\":[\"eur\",\"usd\"]}]},{\"then\":\"always_allow\",\"when\":[{\"fact\":\"reason\",\"op\":\"exists\"}]},{\"then\":\"deny\",\"when\":[{\"fact\":\"amount\",\"op\":\"lte\",\"value\":1}]}]")
@noblecloak_encoding("rules_tightest")
@id("noblecloak.deny:pol_payments_by_amount")
forbid (
  principal == NobleCloak::Agent::"agt_support",
  action == NobleCloak::Action::"tool_invocation",
  resource == NobleCloak::Tool::"mcp:stripe:main:create_refund"
);
