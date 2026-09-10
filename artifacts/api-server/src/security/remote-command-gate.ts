let runtimeOverride: boolean | null = null;

export function canManageRemoteCommandsGate(context: { platformAccess: boolean; platformRole: string | null }): boolean {
  return context.platformAccess && (context.platformRole === "PLATFORM_ADMIN" || context.platformRole === "PLATFORM_SUPER_ADMIN");
}

export function remoteCommandsEnabled(): boolean {
  return runtimeOverride ?? process.env.REMOTE_COMMANDS_ENABLED === "true";
}

export function setRemoteCommandsEnabled(enabled: boolean): boolean {
  runtimeOverride = enabled;
  return enabled;
}
