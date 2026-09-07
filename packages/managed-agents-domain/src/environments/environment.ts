export interface EnvironmentStartup {
  script: string;
  enabled?: boolean;
  triggers?: Array<"create" | "wake" | "revive">;
  timeoutSeconds?: number;
}

export type EnvironmentNetwork =
  | { type: "unrestricted" }
  | {
      type: "limited";
      allowMcpServers: boolean;
      allowPackageManagers: boolean;
      allowedHosts: string[];
    };

export interface EnvironmentPackages {
  apt: string[];
  cargo: string[];
  gem: string[];
  go: string[];
  npm: string[];
  pip: string[];
}

export type EnvironmentConfig =
  | {
      type: "cloud";
      networking: EnvironmentNetwork;
      packages: EnvironmentPackages;
      image?: string;
      imageRegistryAuth?: { vaultId: string; credentialId: string };
      context?: string;
      startup?: EnvironmentStartup;
    }
  | { type: "self_hosted" };

export interface Environment {
  id: string;
  archivedAt: string | null;
  config: EnvironmentConfig;
  createdAt: string;
  description: string | null;
  metadata: Record<string, string>;
  name: string;
  updatedAt: string;
  scope?: "organization" | "account";
}
