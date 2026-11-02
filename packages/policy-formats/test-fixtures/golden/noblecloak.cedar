// NobleCloak tool_invocation policies, written by @noblecloak/policy-formats.
// Format: Cedar, NobleCloak dialect (schemas/noblecloak.cedarschema).
// A call no policy matches is denied by the target engine.
// Role and group subjects match through `principal in`: the evaluating engine needs the deployment's membership entities.
// Lossy: policy "pol_agent_escalate" /config/mode: escalate is exported as a forbid (fail closed): a Cedar engine has no approval outcome, so it denies the call; @noblecloak_mode keeps escalate for an import
// Lossy: policy "pol_agent_escalate" /config/on_deny: kept in @noblecloak_on_deny only; a Cedar engine does not enforce it
// Lossy: policy "pol_finance_payments" /config/approver_groups: kept in @noblecloak_approver_groups only; a Cedar engine does not enforce it
// Lossy: policy "pol_finance_payments" /config/expires_after: kept in @noblecloak_expires_after only; a Cedar engine does not enforce it
// Lossy: policy "pol_finance_payments" /config/mode: ask is exported as a forbid (fail closed): a Cedar engine has no approval outcome, so it denies the call; @noblecloak_mode keeps ask for an import
// Lossy: policy "pol_finance_payments" /config/on_deny: kept in @noblecloak_on_deny only; a Cedar engine does not enforce it
// Lossy: policy "pol_not_granted" /config/mode: not_granted is exported as a forbid: a Cedar engine denies the call without the reason not_granted

@noblecloak_policy("pol_agent_escalate")
@noblecloak_kind("tool_invocation")
@noblecloak_mode("escalate")
@noblecloak_name("Deploys escalate")
@noblecloak_on_deny("resume")
@noblecloak_encoding("fail_closed")
@id("noblecloak.escalate:pol_agent_escalate")
forbid (
  principal == NobleCloak::Agent::"agt_release_bot",
  action == NobleCloak::Action::"tool_invocation",
  resource == NobleCloak::Tool::"external:deploy"
);

@noblecloak_policy("pol_agent_escalate")
@noblecloak_kind("tool_invocation")
@noblecloak_mode("escalate")
@noblecloak_name("Deploys escalate")
@noblecloak_on_deny("resume")
@noblecloak_encoding("fail_closed")
@id("noblecloak.escalate:pol_agent_escalate")
forbid (
  principal == NobleCloak::Service::"svc_ci",
  action == NobleCloak::Action::"tool_invocation",
  resource == NobleCloak::Tool::"external:deploy"
);

@noblecloak_policy("pol_contractor_deny")
@noblecloak_kind("tool_invocation")
@noblecloak_mode("deny")
@noblecloak_name("Contractors never send mail")
@id("noblecloak.deny:pol_contractor_deny")
forbid (
  principal in NobleCloak::Group::"grp_contractors",
  action == NobleCloak::Action::"tool_invocation",
  resource == NobleCloak::Tool::"mcp:gmail:main:send_email"
);

@noblecloak_policy("pol_contractor_deny")
@noblecloak_kind("tool_invocation")
@noblecloak_mode("deny")
@noblecloak_name("Contractors never send mail")
@id("noblecloak.deny:pol_contractor_deny")
forbid (
  principal == NobleCloak::User::"usr_contractor_7",
  action == NobleCloak::Action::"tool_invocation",
  resource == NobleCloak::Tool::"mcp:gmail:main:send_email"
);

@noblecloak_policy("pol_finance_payments")
@noblecloak_kind("tool_invocation")
@noblecloak_mode("ask")
@noblecloak_name("Payments need finance approval")
@noblecloak_description("Any payment or refund by a member is approved by finance first.")
@noblecloak_on_deny("halt")
@noblecloak_expires_after("PT1H")
@noblecloak_approver_groups("[\"finance\",\"owners\"]")
@noblecloak_encoding("fail_closed")
@id("noblecloak.ask:pol_finance_payments")
forbid (
  principal in NobleCloak::Role::"member",
  action == NobleCloak::Action::"tool_invocation",
  resource
)
when {
  [
    NobleCloak::Tool::"mcp:stripe:main:create_payment",
    NobleCloak::Tool::"mcp:stripe:main:create_refund"
  ].contains(resource)
};

@noblecloak_policy("pol_not_granted")
@noblecloak_kind("tool_invocation")
@noblecloak_mode("not_granted")
@noblecloak_name("Billing is not granted")
@id("noblecloak.not_granted:pol_not_granted")
forbid (
  principal in NobleCloak::Role::"viewer",
  action == NobleCloak::Action::"tool_invocation",
  resource
)
when {
  [
    NobleCloak::Tool::"mcp:stripe:main:create_payment",
    NobleCloak::Tool::"mcp:stripe:main:create_payment"
  ].contains(resource)
};

@noblecloak_policy("pol_org_read")
@noblecloak_kind("tool_invocation")
@noblecloak_mode("always_allow")
@noblecloak_name("Everyone may read")
@noblecloak_description("")
@id("noblecloak.always_allow:pol_org_read")
permit (
  principal,
  action == NobleCloak::Action::"tool_invocation",
  resource
);
