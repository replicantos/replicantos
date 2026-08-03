import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthorizationError,
  authorize,
  createEntityId,
  evaluateAuthorization,
  isoTimestamp,
} from "../dist/index.js";

const actorId = createEntityId("user", "member01");
const adminId = createEntityId("user", "admin001");
const grantId = createEntityId("grant", "channel01");
const channelId = createEntityId("channel", "general01");
const otherChannelId = createEntityId("channel", "private01");
const workspaceId = createEntityId("workspace", "demo0001");
const now = isoTimestamp("2030-01-15T12:00:00.000Z");

function actor(overrides = {}) {
  return {
    id: actorId,
    workspaceId,
    role: "member",
    kind: "human",
    status: "active",
    ...overrides,
  };
}

function grant(overrides = {}) {
  return {
    id: grantId,
    workspaceId,
    subjectType: "user",
    subjectUserId: actorId,
    subjectRole: null,
    permission: "channel:read",
    resourceType: "channel",
    resourceId: channelId,
    effect: "allow",
    reason: null,
    createdBy: adminId,
    createdAt: now,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

test("a member grant is scoped to one resource", () => {
  assert.deepEqual(
    evaluateAuthorization(
      actor(),
      {
        permission: "channel:read",
        resourceType: "channel",
        resourceId: channelId,
      },
      [grant()],
      now,
    ),
    { allowed: true, reason: "explicit-allow", matchedGrantId: grantId },
  );
  assert.equal(
    evaluateAuthorization(
      actor(),
      {
        permission: "channel:read",
        resourceType: "channel",
        resourceId: otherChannelId,
      },
      [grant()],
      now,
    ).allowed,
    false,
  );
});

test("explicit deny takes precedence over role and allow grants", () => {
  const decision = evaluateAuthorization(
    actor({ id: adminId, role: "admin" }),
    { permission: "database:inspect", resourceType: "database" },
    [
      grant({
        id: createEntityId("grant", "dballow01"),
        subjectUserId: adminId,
        permission: "database:inspect",
        resourceType: "database",
        resourceId: null,
      }),
      grant({
        id: createEntityId("grant", "dbdeny001"),
        subjectUserId: adminId,
        permission: "database:inspect",
        resourceType: "database",
        resourceId: null,
        effect: "deny",
      }),
    ],
    now,
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "explicit-deny");
});

test("expired and revoked grants never authorize", () => {
  const request = {
    permission: "channel:read",
    resourceType: "channel",
    resourceId: channelId,
  };
  assert.equal(
    evaluateAuthorization(actor(), request, [grant({ expiresAt: now })], now)
      .allowed,
    false,
  );
  assert.equal(
    evaluateAuthorization(actor(), request, [grant({ revokedAt: now })], now)
      .allowed,
    false,
  );
});

test("inactive actors are denied before role evaluation", () => {
  const decision = evaluateAuthorization(
    actor({ role: "owner", status: "suspended" }),
    { permission: "workspace:manage" },
    [],
    now,
  );
  assert.deepEqual(decision, {
    allowed: false,
    reason: "actor-inactive",
    matchedGrantId: null,
  });
});

test("owner and admin defaults preserve ownership boundaries", () => {
  assert.equal(
    evaluateAuthorization(
      actor({ role: "owner" }),
      { permission: "workspace:transfer" },
      [],
      now,
    ).allowed,
    true,
  );
  assert.equal(
    evaluateAuthorization(
      actor({ role: "admin" }),
      { permission: "workspace:transfer" },
      [],
      now,
    ).allowed,
    false,
  );
  assert.equal(
    evaluateAuthorization(
      actor({ role: "admin" }),
      { permission: "database:inspect" },
      [],
      now,
    ).allowed,
    true,
  );
});

test("owner-only permissions cannot be delegated to non-owners", () => {
  for (const role of ["admin", "member", "service"]) {
    for (const [permission, resourceType] of [
      ["workspace:transfer", "workspace"],
      ["backup:restore", "backup"],
    ]) {
      const allowGrant = grant({
        subjectUserId: actorId,
        permission,
        resourceType,
        resourceId: null,
      });
      const decision = evaluateAuthorization(
        actor({ role, kind: role === "service" ? "service" : "human" }),
        { permission, resourceType },
        [allowGrant],
        now,
      );

      assert.deepEqual(
        decision,
        { allowed: false, reason: "not-granted", matchedGrantId: null },
        `${role} must not receive ${permission} through a user grant`,
      );

      const roleGrantDecision = evaluateAuthorization(
        actor({ role, kind: role === "service" ? "service" : "human" }),
        { permission, resourceType },
        [
          grant({
            subjectType: "role",
            subjectUserId: null,
            subjectRole: role,
            permission,
            resourceType,
            resourceId: null,
          }),
        ],
        now,
      );

      assert.deepEqual(
        roleGrantDecision,
        { allowed: false, reason: "not-granted", matchedGrantId: null },
        `${role} must not receive ${permission} through a role grant`,
      );
    }
  }
});

test("administrative permissions cannot be delegated to members or services", () => {
  for (const role of ["member", "service"]) {
    for (const [permission, resourceType] of [
      ["workspace:manage", "workspace"],
      ["user:manage", "user"],
      ["access:manage", "access"],
      ["database:inspect", "database"],
      ["terminal:execute", "terminal"],
      ["credential:manage", "credential"],
      ["backup:create", "backup"],
      ["audit:read", "audit"],
    ]) {
      const decision = evaluateAuthorization(
        actor({ role, kind: role === "service" ? "service" : "human" }),
        {
          permission,
          resourceType,
          ...(permission === "terminal:execute"
            ? { featureEnabled: true }
            : {}),
        },
        [
          grant({
            permission,
            resourceType,
            resourceId: null,
          }),
        ],
        now,
      );

      assert.deepEqual(
        decision,
        { allowed: false, reason: "not-granted", matchedGrantId: null },
        `${role} must not receive administrative ${permission}`,
      );
    }
  }
});

test("member and service grants retain normal collaboration capabilities", () => {
  for (const role of ["member", "service"]) {
    const decision = evaluateAuthorization(
      actor({ role, kind: role === "service" ? "service" : "human" }),
      {
        permission: "channel:write",
        resourceType: "channel",
        resourceId: channelId,
      },
      [
        grant({
          permission: "channel:write",
          resourceType: "channel",
          resourceId: channelId,
        }),
      ],
      now,
    );
    assert.deepEqual(decision, {
      allowed: true,
      reason: "explicit-allow",
      matchedGrantId: grantId,
    });
  }
});

test("owners retain owner-only permissions unless explicitly denied", () => {
  for (const [permission, resourceType] of [
    ["workspace:transfer", "workspace"],
    ["backup:restore", "backup"],
  ]) {
    assert.deepEqual(
      evaluateAuthorization(
        actor({ role: "owner" }),
        { permission, resourceType },
        [],
        now,
      ),
      { allowed: true, reason: "role-allow", matchedGrantId: null },
    );

    const denyGrant = grant({
      permission,
      resourceType,
      resourceId: null,
      effect: "deny",
    });
    assert.deepEqual(
      evaluateAuthorization(
        actor({ role: "owner" }),
        { permission, resourceType },
        [denyGrant],
        now,
      ),
      { allowed: false, reason: "explicit-deny", matchedGrantId: grantId },
    );
  }
});

test("workspace checks precede owner-only role and grant evaluation", () => {
  const otherWorkspaceId = createEntityId("workspace", "other002");
  const decision = evaluateAuthorization(
    actor({ role: "owner" }),
    {
      permission: "workspace:transfer",
      workspaceId: otherWorkspaceId,
      resourceType: "workspace",
    },
    [
      grant({
        permission: "workspace:transfer",
        resourceType: "workspace",
        resourceId: null,
      }),
    ],
    now,
  );

  assert.deepEqual(decision, {
    allowed: false,
    reason: "workspace-mismatch",
    matchedGrantId: null,
  });
});

test("members can inspect their own identity and notifications only", () => {
  assert.equal(
    evaluateAuthorization(
      actor(),
      { permission: "notification:read", resourceOwnerId: actorId },
      [],
      now,
    ).reason,
    "self-allow",
  );
  assert.equal(
    evaluateAuthorization(
      actor(),
      { permission: "notification:read", resourceOwnerId: adminId },
      [],
      now,
    ).allowed,
    false,
  );
});

test("service actors receive no implicit interactive permissions", () => {
  const service = actor({ role: "service", kind: "service" });
  assert.equal(
    evaluateAuthorization(service, { permission: "run:create" }, [], now)
      .allowed,
    false,
  );
});

test("workspace mismatch and disabled terminal fail before role grants", () => {
  assert.equal(
    evaluateAuthorization(
      actor({ role: "owner" }),
      {
        permission: "channel:read",
        workspaceId: createEntityId("workspace", "other001"),
      },
      [],
      now,
    ).reason,
    "workspace-mismatch",
  );
  assert.equal(
    evaluateAuthorization(
      actor({ role: "owner" }),
      { permission: "terminal:execute" },
      [],
      now,
    ).reason,
    "feature-disabled",
  );
  assert.equal(
    evaluateAuthorization(
      actor({ role: "owner" }),
      { permission: "terminal:execute", featureEnabled: true },
      [],
      now,
    ).allowed,
    true,
  );
});

test("authorize throws a typed error", () => {
  assert.throws(
    () => authorize(actor(), { permission: "terminal:execute" }, [], now),
    AuthorizationError,
  );
});

test("domain identifier and timestamp parsing rejects malformed input", () => {
  assert.throws(() => createEntityId("user", "bad"), TypeError);
  assert.throws(() => isoTimestamp("2030-01-15"), TypeError);
});
