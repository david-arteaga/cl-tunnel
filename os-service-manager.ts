import { trimmed } from './trim-empty-lines';

export interface OSServiceManager {
  getServiceFilePath(): string;
  getLogPaths(): { out: string; err: string };

  stopService(): Promise<void>;
  restartService(): Promise<void>;
  reloadServiceDefinition(): Promise<void>;

  patchServiceFile(cloudflaredBinPath: string): Promise<void>;
  isServiceFilePatched(cloudflaredBinPath: string): Promise<boolean>;

  getInstallInstructions(): string[];
}

class MacOSServiceManager implements OSServiceManager {
  private readonly home = process.env.HOME;

  getServiceFilePath(): string {
    return `${this.home}/Library/LaunchAgents/com.cloudflare.cloudflared.plist`;
  }

  getLogPaths() {
    return {
      out: `${this.home}/Library/Logs/com.cloudflare.cloudflared.out.log`,
      err: `${this.home}/Library/Logs/com.cloudflare.cloudflared.err.log`,
    };
  }

  async stopService(): Promise<void> {
    await Bun.$`launchctl stop com.cloudflare.cloudflared`;
  }

  async restartService(): Promise<void> {
    await Bun.$`launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared`;
  }

  async reloadServiceDefinition(): Promise<void> {
    await Bun.$`launchctl bootout gui/$(id -u)/com.cloudflare.cloudflared`;
    await Bun.$`launchctl bootstrap gui/$(id -u) ${this.getServiceFilePath()}`;
    await Bun.$`launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared`;
  }

  async patchServiceFile(cloudflaredBinPath: string): Promise<void> {
    const serviceFile = this.getServiceFilePath();
    const content = await Bun.file(serviceFile).text();

    const { search, replace } = this.getServiceFilePatch(cloudflaredBinPath);

    const patched = content.replace(search, replace);
    if (patched !== content) {
      await Bun.write(serviceFile, patched);
    }
  }

  private getServiceFilePatch(cloudflaredBinPath: string) {
    const search = trimmed`
		<array>
			<string>${cloudflaredBinPath}</string>
		</array>
`;

    const replace = trimmed`
		<array>
			<string>${cloudflaredBinPath}</string>
			<string>tunnel</string>
			<string>run</string>
		</array>
`;

    return { search, replace };
  }

  async isServiceFilePatched(cloudflaredBinPath: string): Promise<boolean> {
    const content = await Bun.file(this.getServiceFilePath()).text();
    const { replace } = this.getServiceFilePatch(cloudflaredBinPath);

    return content.includes(replace);
  }

  getInstallInstructions(): string[] {
    return ['You can install it with brew:', 'brew install cloudflared'];
  }
}

export function createOSServiceManager(): OSServiceManager {
  const platform = process.platform;

  switch (platform) {
    case 'darwin':
      return new MacOSServiceManager();
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
