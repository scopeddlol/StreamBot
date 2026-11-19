import { AppStore } from "./store.js";
import { AppError } from "./errors.js";
export const actions = [
  "instance.view",
  "instance.create",
  "instance.configure",
  "instance.start",
  "instance.stop",
  "instance.move",
  "instance.delete",
  "media.search",
  "media.request",
  "media.play_now",
  "queue.view",
  "queue.add",
  "queue.skip",
  "queue.reorder",
  "queue.clear",
  "playlist.manage",
  "requests.approve",
  "permissions.manage",
  "integrations.manage",
  "secrets.rotate",
  "system.backup",
  "system.logs",
  "ai.use",
  "ai.configure",
] as const;
export type Action = (typeof actions)[number];
export interface Actor {
  id: string;
  role?: string;
  guildId?: string;
  roleIds?: string[];
  verified?: boolean;
  source: "web" | "discord" | "ai";
}
export class Permissions {
  constructor(readonly store: AppStore) {}
  allowed(actor: Actor, action: Action, instanceId?: string): boolean {
    if (!actor || (actor.source === "discord" && !actor.verified)) return false;
    if (actor.role === "owner" && actor.source !== "discord") return true;
    const instance =
      instanceId &&
      this.store.get("SELECT config FROM instances WHERE id=?", instanceId);
    if (instanceId && !instance) return false;
    if (
      actor.guildId &&
      instance &&
      JSON.parse(instance.config).guildId !== actor.guildId
    )
      return false;
    const rules = this.store
      .all("SELECT * FROM permission_rules WHERE action=?", action)
      .filter(
        (rule) =>
          (!rule.guild_id || rule.guild_id === actor.guildId) &&
          (!rule.instance_id || rule.instance_id === instanceId),
      );
    const user = rules.filter(
      (rule) => rule.subject_type === "user" && rule.subject_id === actor.id,
    );
    if (user.some((rule) => rule.effect === "deny")) return false;
    if (user.some((rule) => rule.effect === "allow")) return true;
    const role = rules.filter(
      (rule) =>
        rule.subject_type === "role" &&
        actor.roleIds?.includes(rule.subject_id),
    );
    if (role.some((rule) => rule.effect === "deny")) return false;
    if (role.some((rule) => rule.effect === "allow")) return true;
    const defaults = rules.filter(
      (rule) =>
        rule.subject_type === "guild" && rule.subject_id === actor.guildId,
    );
    if (defaults.some((rule) => rule.effect === "deny")) return false;
    if (defaults.some((rule) => rule.effect === "allow")) return true;
    if (actor.source === "web" || actor.source === "ai") {
      if (actor.role === "admin") return true;
      if (actor.role === "operator")
        return ![
          "instance.create",
          "instance.configure",
          "instance.delete",
          "permissions.manage",
          "integrations.manage",
          "secrets.rotate",
          "system.backup",
          "system.logs",
          "ai.configure",
        ].includes(action);
      if (actor.role === "viewer")
        return ["instance.view", "queue.view", "media.search"].includes(action);
    }
    return false;
  }
  require(actor: Actor, action: Action, instanceId?: string) {
    if (!this.allowed(actor, action, instanceId)) {
      this.store.audit(
        actor?.id || "anonymous",
        action,
        instanceId || "global",
        "denied",
      );
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission for this action or room",
        403,
      );
    }
  }
}
