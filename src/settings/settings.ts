export class DiscordRPCSettings {
  showVaultName: boolean = true;
  showCurrentFileName: boolean = true;
  showPopups: boolean = true;
  customVaultName: string = "";
  showFileExtension: boolean = true;
  useLoadedTime: boolean = true;
  connectOnStart: boolean = true;
  autoHideStatusBar: boolean = false;
  privacyMode: boolean = false;
  useWatchingType: boolean = false;
  useOriginalIcon: boolean = false;
  showReadWriteImage: boolean = true;
}

export enum PluginState {
  connected,
  connecting,
  disconnected,
}
