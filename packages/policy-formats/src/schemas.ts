/**
 * The Cedar schemas of the two dialects, as text (cedarschema format). The package also ships them as
 * files, `schemas/noblecloak.cedarschema` and `schemas/agt.cedarschema`, which a test keeps equal to these.
 * They describe the statements an export writes, so a validator (cedar-wasm `validate`) can check an export
 * before it is deployed. Neither declares a request context: no exported statement reads one.
 */

/** NobleCloak's dialect: every subject type, roles and groups as parents of the principals. */
export const NOBLECLOAK_CEDAR_SCHEMA = `namespace NobleCloak {
  entity Organization;
  entity Group in [Organization];
  entity Role in [Organization];
  entity User in [Group, Role, Organization];
  entity Service in [Group, Role, Organization];
  entity Agent in [Group, Role, Organization];
  entity Tool;
  action "tool_invocation" appliesTo {
    principal: [User, Service, Agent],
    resource: [Tool],
    context: {}
  };
}
`;

/**
 * AGT's dialect as its engine builds a request at a tool intervention point: an agent principal, the
 * point as the action, the tool as the resource, no namespace. AGT ships no schema; this one is ours. As an
 * AGT `schema_path` it would reject the context AGT sends, which it does not declare.
 */
export const AGT_CEDAR_SCHEMA = `entity Agent;
entity Tool;
entity PolicyTarget;
action "pre_tool_call" appliesTo {
  principal: [Agent],
  resource: [Tool],
  context: {}
};
`;
